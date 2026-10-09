import { MANGA_KINDS, type MangaChapter, type MangaChapters, type MangaCopies, type MangaCopy, type MangaFound, type MangaKind, type MangaSearchResult, type MangaSeries, type MangaSort, type SourceSeries } from '@breader/shared';
import { Memo, MemoryStore, type Store } from '../lib/cache.ts';
import { ApiError } from '../lib/errors.ts';
import { log } from '../log.ts';
import { copiesOf, measure } from './copies.ts';
import { Covers, type Cover, type CoverWidth } from './covers.ts';
import { Disk, type Picture } from './disk.ts';
import { DEADLINE, find, GRACE, type Place, type Wanted } from './find.ts';
import { makeMangaDex } from './mangadex.ts';
import { makeSuwayomi, type Suwayomi } from './suwayomi.ts';

/*
 * Manga through the laptop: one search across MangaDex and the sources of Breader's Suwayomi server
 * (find.ts), and each series, its chapters and their pages from wherever it is. Suwayomi is on when
 * the server is given its address. Browsing (a list, not a search by name) shows its sources only,
 * and MangaDex only when there's none to browse: none in the language asked, or Suwayomi off or
 * down. Top rated is the exception, MangaDex's alone, as no source lists by rating.
 */

export interface Manga {
  /** onSome: what's found so far, each time a place brings something, before the lot's whole. */
  search(q: { q?: string; lang?: string; sort?: MangaSort; adult?: boolean; adultOnly?: boolean; doujinshi?: boolean; kinds?: MangaKind[]; names?: string[]; next?: string }, onSome?: (items: MangaFound[]) => void): Promise<MangaSearchResult>;
  /** A MangaDex series, its chapters in a language, a chapter's page (from 0) and a cover. */
  series(id: string, adult: boolean): Promise<MangaSeries>;
  chapters(id: string, lang: string): Promise<MangaChapters>;
  page(chapterId: string, n: number, saver: boolean): Promise<Picture>;
  /** early: fetched again that much before it's due, and waited for (covers.ts). */
  cover(mangaId: string, file: string, size: '256' | '512', early?: number): Promise<Cover>;
  /** A series on Suwayomi (sw:12), and the like. */
  sourceSeries(id: string, adult: boolean): Promise<SourceSeries>;
  sourceChapters(id: string): Promise<MangaChapters>;
  sourceCover(id: string, size: '256' | '512', early?: number): Promise<Cover>;
  /** The prefetch says how long a series' covers are kept, by the list it's in (covers.ts). */
  coversFor(id: string, freshFor: number): Promise<void>;
  /** How many pages a chapter of a source has. */
  sourcePages(chapterId: string): Promise<number>;
  sourcePage(chapterId: string, n: number): Promise<Picture>;
  /** A series' copies in its place (copies.ts), their pages measured: MangaDex's in a language, a source's (sw:12) in its own. */
  copies(id: string, lang: string): Promise<MangaCopies>;
  /** Ahead of readers: shelves each English source's Popular and Updated lists, or checks MangaDex's first lots without Suwayomi. */
  warm(): Promise<void>;
}

export interface MangaOptions {
  /** Where pages and covers are kept, up to so many bytes. */
  dir: string;
  cacheBytes: number;
  fetch?: typeof fetch;
  /** Calls a window: MangaDex's API overall (each source the same), and its page servers' addresses. Tests go faster. */
  pace?: { api: [number, number]; home: [number, number] };
  /** Where answers are kept: Redis, when the server has one. Without, in memory. */
  store?: Store | null;
  /** Breader's Suwayomi server, when it has one. */
  suwayomi?: string;
  /** How long a lot it hasn't seen may take a source for it to be browsed (suwayomi.ts). Tests go faster. */
  browseWithin?: number;
}

const off = () => new ApiError(404, 'manga_not_found', 'That source isn’t on, on this server.');
const unmeasured = () => new ApiError(503, 'manga_unreachable', 'Its pages couldn’t be measured just now. Try again in a minute.');

/** How long a series' copies are fresh: groups come and go slowly, and a page's size never changes. */
const COPIES_FOR = 24 * 3_600_000;
/** And kept on after, given at once while they're measured again (lib/cache.ts). */
const COPIES_KEPT = 3 * COPIES_FOR;

export function makeManga(opts: MangaOptions): Manga {
  const disk = new Disk(opts.dir, opts.cacheBytes);
  const store = opts.store ?? null;
  const covers = new Covers(disk, store ?? new MemoryStore(20_000));
  const pace = opts.pace?.api;
  const dex = makeMangaDex({ disk, covers, fetch: opts.fetch, pace: opts.pace, store });
  let suwayomi: Suwayomi | null = null;
  if (opts.suwayomi) suwayomi = makeSuwayomi({ url: opts.suwayomi, disk, covers, fetch: opts.fetch, pace, store, browseWithin: opts.browseWithin });

  /** Suwayomi, and its series or chapter number in an id like sw:12. */
  function onSuwayomi(id: string): { suwayomi: Suwayomi; n: number } {
    if (!suwayomi) throw off();
    return { suwayomi, n: Number(id.slice(3)) };
  }

  let copyStore: Store = new MemoryStore(500);
  if (store) copyStore = store;
  const copyMemo = new Memo<MangaCopies>(copyStore, 'manga:v1:copies', COPIES_FOR, COPIES_KEPT);

  /** A series' chapters, and how to count and fetch a chapter's pages, wherever it is. */
  async function readFrom(id: string, lang: string) {
    let chapters: MangaChapter[];
    let count: (c: MangaChapter) => Promise<number>;
    let page: (c: MangaChapter, n: number) => Promise<Picture>;
    if (id.startsWith('sw:')) {
      const { suwayomi, n } = onSuwayomi(id);
      chapters = (await suwayomi.chapters(n)).chapters;
      count = (c) => suwayomi.pages(Number(c.id.slice(3)));
      page = (c, i) => suwayomi.page(Number(c.id.slice(3)), i);
    } else {
      chapters = (await dex.chapters(id, lang)).chapters;
      count = async (c) => c.pages;
      page = (c, i) => dex.page(c.id, i, false);
    }
    return { chapters, count, page };
  }

  /** Each copy measured. When not one could be, the site is likely down: that's the answer, and it isn't kept. */
  async function measureCopies(id: string, lang: string): Promise<MangaCopies> {
    const { chapters, count, page } = await readFrom(id, lang);
    const { total, plans } = copiesOf(chapters);
    const copies: MangaCopy[] = [];
    let tried = 0;
    let measured = 0;
    for (const plan of plans) {
      const copy: MangaCopy = { group: plan.group, chapters: plan.chapters, width: null, height: null };
      const sample = plan.sample;
      if (sample) {
        tried += 1;
        let pages = 0;
        try {
          pages = await count(sample);
        } catch {
          // Measured as no pages.
        }
        const size = await measure(pages, (n) => page(sample, n));
        if (size) {
          measured += 1;
          copy.width = size.width;
          copy.height = size.height;
        }
      }
      copies.push(copy);
    }
    if (tried > 0 && measured === 0) throw unmeasured();
    return { chapters: total, copies };
  }

  return {
    async search(q, onSome) {
      // In MANGA_KINDS' order, so the same ask is kept once.
      let kinds: MangaKind[] = [...MANGA_KINDS];
      const asked = q.kinds;
      if (asked && asked.length > 0) kinds = MANGA_KINDS.filter((k) => asked.includes(k));
      const w: Wanted = { lang: q.lang, sort: q.sort, adult: !!q.adult || !!q.adultOnly, doujinshi: !!q.doujinshi, kinds };
      if (q.adultOnly) w.adultOnly = true;
      if (q.q) w.q = q.q;
      if (q.names) w.names = q.names;
      // Top rated is MangaDex's alone: a source lists only its popular and its latest, and its
      // popular in place of a rating made Top rated Popular over again.
      const rated = !w.q && w.sort === 'rated';
      const places: Place[] = [];
      if (suwayomi && !rated) {
        try {
          places.push(...(await suwayomi.places(w)));
        } catch (err) {
          log.warn({ err }, 'Suwayomi’s sources couldn’t be listed, so the search goes on without them');
        }
      }
      // A search by name asks MangaDex too. Browsing asks it only when there's no source to browse.
      if (w.q || places.length === 0) places.push(dex.place(w));
      // A sheet looking for its series' other copies waits for every place; a reader sees what's come,
      // and only series going by what they searched for, as some sites answer with anything like it.
      let grace: number | null = GRACE;
      if (w.names) grace = null;
      return find(places, w.q, q.next, DEADLINE, grace, !w.names, onSome);
    },

    series: (id, adult) => dex.series(id, adult),
    chapters: (id, lang) => dex.chapters(id, lang),
    page: (chapterId, n, saver) => dex.page(chapterId, n, saver),
    cover: (mangaId, file, size, early) => dex.cover(mangaId, file, size, early),
    coversFor: (id, freshFor) => covers.listed(id, freshFor),
    async warm() {
      if (suwayomi) await suwayomi.warm();
      else await dex.warm();
    },

    async sourceSeries(id, adult) {
      const { suwayomi, n } = onSuwayomi(id);
      return suwayomi.series(n, adult);
    },

    async sourceChapters(id) {
      const { suwayomi, n } = onSuwayomi(id);
      return suwayomi.chapters(n);
    },

    async sourceCover(id, size, early) {
      const { suwayomi, n } = onSuwayomi(id);
      return suwayomi.cover(n, Number(size) as CoverWidth, early);
    },

    async sourcePages(chapterId) {
      const { suwayomi, n } = onSuwayomi(chapterId);
      return suwayomi.pages(n);
    },

    async sourcePage(chapterId, page) {
      const { suwayomi, n } = onSuwayomi(chapterId);
      return suwayomi.page(n, page);
    },

    copies: (id, lang) => copyMemo.get(`${id}:${lang}`, () => measureCopies(id, lang)),
  };
}
