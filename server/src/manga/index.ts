import { ANILIST_SORTS, MANGA_KINDS, type AniListSort, type MangaChapter, type MangaChapters, type MangaCopies, type MangaCopy, type MangaFound, type MangaKind, type MangaSearchResult, type MangaSeries, type MangaSort, type SourceSeries } from '@breader/shared';
import { both, freshly, Memo, MemoryStore, type Store } from '../lib/cache.ts';
import { ApiError } from '../lib/errors.ts';
import { log } from '../log.ts';
import { copiesOf, measure } from './copies.ts';
import { Covers, type Cover, type CoverWidth } from './covers.ts';
import type { Archive } from '../lib/archive.ts';
import { Disk, pictureType, type Picture } from './disk.ts';
import { DEADLINE, find, GRACE, type Place, type Wanted } from './find.ts';
import { copiesOfCard, isCardsSeries } from './anifound.ts';
import { makeAniList, type AniList, type AniListAsk } from './anilist.ts';
import { makeMangaDex } from './mangadex.ts';
import type { Curate, Tab } from './curate.ts';
import type { Same } from './same.ts';
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
  /** quiet: kept on disk without counting as read (disk.ts), for the keeper. */
  page(chapterId: string, n: number, saver: boolean, quiet?: boolean): Promise<Picture>;
  /** early: fetched again that much before it's due, and waited for (covers.ts). */
  cover(mangaId: string, file: string, size: '256' | '512', early?: number): Promise<Cover>;
  /** A series on one of Suwayomi's sources (SourceId: sw:<source>:<address>), and the like. */
  sourceSeries(id: string, adult: boolean): Promise<SourceSeries>;
  sourceChapters(id: string): Promise<MangaChapters>;
  sourceCover(id: string, size: '256' | '512', early?: number): Promise<Cover>;
  /** The prefetch says how long a series' covers are kept, by the list it's in (covers.ts). */
  coversFor(id: string, freshFor: number): Promise<void>;
  /** How many pages a chapter of a source has. */
  sourcePages(chapterId: string): Promise<number>;
  sourcePage(chapterId: string, n: number, quiet?: boolean): Promise<Picture>;
  /** A series' copies in its place (copies.ts), their pages measured: MangaDex's in a language, a source's (sw:…) in its own. */
  copies(id: string, lang: string): Promise<MangaCopies>;
  /** AniList: Browse's lists, and what a series' page says is related to it and like it (anilist.ts). */
  anilist: AniList;
  /** Where a series AniList knows (by its id) can be read: its copies found on the sites, none when no site has it (anifound.ts). */
  aniFound(alId: number, lang: string | undefined, adult: boolean): Promise<MangaFound[]>;
  /** The same for many at once, as far as it's kept already, asking no site: one not kept is left out, to be asked alone. */
  aniFoundKept(alIds: number[], lang: string | undefined, adult: boolean): Promise<Record<string, MangaFound[]>>;
  /** Ahead of readers: shelves each English source's Popular and Updated lists, or checks MangaDex's first lots without Suwayomi, then finds where the first 20 pages of each AniList list are read in English (5 of each kind alone), with their covers. */
  warm(): Promise<void>;
}

export interface MangaOptions {
  /** Where pages and covers are kept, up to so many bytes. */
  dir: string;
  cacheBytes: number;
  fetch?: typeof fetch;
  /** Calls a window: MangaDex's API overall (each source and AniList the same), and its page servers' addresses. Tests go faster. */
  pace?: { api: [number, number]; home: [number, number] };
  /** Where answers are kept: Redis, when the server has one. Without, in memory. */
  store?: Store | null;
  /** Breader's Suwayomi server, when it has one. */
  suwayomi?: string;
  /** How long a lot it hasn't seen may take a source for it to be browsed (suwayomi.ts). Tests go faster. */
  browseWithin?: number;
  /** Which series found are one, as Gemini told (same.ts). */
  same?: Same | null;
  /** Which cards don't belong in Browse's tabs, as Gemini told (curate.ts). */
  curate?: Curate | null;
  /** Where every page and cover is kept for good, behind the cache (lib/archive.ts). */
  archive?: Archive | null;
}

const off = () => new ApiError(404, 'manga_not_found', 'That source isn’t on, on this server.');
const unmeasured = () => new ApiError(503, 'manga_unreachable', 'Its pages couldn’t be measured just now. Try again in a minute.');

/** How long a lot may wait for Gemini to group its series the first time they come together, within the app's 20 s for a search. */
const GROUP_WAIT = 6_000;
const SEARCH_WITHIN = 19_000;

/** How long a series' copies are fresh: groups come and go slowly, and a page's size never changes. */
const COPIES_FOR = 24 * 3_600_000;
/** And kept on after, given at once while they're measured again (lib/cache.ts). */
const COPIES_KEPT = 3 * COPIES_FOR;
/** How long where an AniList series is read is fresh: sites add series now and then; given at once for a month after, while it's looked for again. */
const ANI_FOUND_FOR = 3 * 24 * 3_600_000;
const ANI_FOUND_KEPT = 30 * 24 * 3_600_000;
/** Pages of each AniList list warmed ahead of readers (30 series a page), with every kind on and with each kind alone, and series looked for at once. */
const ANI_WARM_PAGES = 20;
const ANI_WARM_KIND_PAGES = 5;
const ANI_WARM_AT_ONCE = 3;
/** The kinds Browse offers (Comics isn't), as it asks AniList for them. */
const BROWSE_KINDS: readonly MangaKind[] = ['manga', 'manhwa', 'manhua'];

export function makeManga(opts: MangaOptions): Manga {
  const disk = new Disk(opts.dir, opts.cacheBytes, pictureType, opts.archive?.pages ?? null);
  const store = opts.store ?? null;
  const covers = new Covers(disk, store ?? new MemoryStore(20_000));
  const pace = opts.pace?.api;
  const dex = makeMangaDex({ disk, covers, fetch: opts.fetch, pace: opts.pace, store });
  const anilist = makeAniList({ covers, fetch: opts.fetch, store, pace });
  let suwayomi: Suwayomi | null = null;
  if (opts.suwayomi) suwayomi = makeSuwayomi({ url: opts.suwayomi, disk, covers, fetch: opts.fetch, pace, store, browseWithin: opts.browseWithin });

  /** Suwayomi, when this server has one. */
  function onSuwayomi(): Suwayomi {
    if (!suwayomi) throw off();
    return suwayomi;
  }

  let copyStore: Store = new MemoryStore(500);
  if (store) copyStore = store;
  const copyMemo = new Memo<MangaCopies>(copyStore, 'manga:v1:copies', COPIES_FOR, COPIES_KEPT);
  const aniFoundMemo = new Memo<MangaFound[]>(both(new MemoryStore(20_000), copyStore), 'manga:v1:al-found', ANI_FOUND_FOR, ANI_FOUND_KEPT);

  /** A series' chapters, and how to count and fetch a chapter's pages, wherever it is. */
  async function readFrom(id: string, lang: string) {
    let chapters: MangaChapter[];
    let count: (c: MangaChapter) => Promise<number>;
    let page: (c: MangaChapter, n: number) => Promise<Picture>;
    if (id.startsWith('sw:')) {
      const suwayomi = onSuwayomi();
      chapters = (await suwayomi.chapters(id)).chapters;
      count = (c) => suwayomi.pages(c.id);
      page = (c, i) => suwayomi.page(c.id, i);
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

  /** The pages Browse's AniList lists are warmed to, as readers see them: a page of every list before the next page of any. */
  function aniWarmAsks(): AniListAsk[] {
    const asks: AniListAsk[] = [];
    const ask = (sort: AniListSort, page: number, kinds: MangaKind[]) => asks.push({ sort, page, adult: false, adultOnly: false, kinds });
    for (let page = 1; page <= ANI_WARM_PAGES; page++) {
      for (const sort of ANILIST_SORTS) ask(sort, page, [...BROWSE_KINDS]);
      if (page > ANI_WARM_KIND_PAGES) continue;
      for (const kind of BROWSE_KINDS) {
        for (const sort of ANILIST_SORTS) ask(sort, page, [kind]);
      }
    }
    return asks;
  }

  /** Where an AniList series is read is kept by this key. wide: 18+ copies count. */
  const aniFoundKey = (alId: number, lang: string | undefined, wide: boolean) => `${alId}:${lang ?? 'any'}:${wide ? 1 : 0}`;

  /** Warms a series' AniList cover onto the disk, when it isn't there. */
  async function warmAniCover(alId: number) {
    if (await covers.has(`al:${alId}`)) return;
    await anilist.cover(alId, 256).catch(() => {});
  }

  /**
   * Where the series on Browse's AniList lists are read in English, looked for ahead of readers,
   * and the covers of those that are read somewhere: the first 20 pages of each list, and 5 of each
   * kind on its own, a few series at a time. A run still going isn't started again. Everything's
   * fresh for days, so after the first time a run asks only what's past its time, and waits for
   * each (freshly), keeping to the sites' pace.
   */
  let aniWarming: Promise<void> | null = null;
  function warmAniList(): Promise<void> {
    if (aniWarming) return aniWarming;
    aniWarming = freshly(async () => {
      const seen = new Set<number>();
      for (const ask of aniWarmAsks()) {
        let cards;
        try {
          cards = (await anilist.list(ask)).items.filter((c) => !c.adult && !seen.has(c.id));
        } catch (err) {
          log.warn({ err, sort: ask.sort, page: ask.page }, 'AniList’s list couldn’t be fetched to warm');
          continue;
        }
        for (const c of cards) seen.add(c.id);
        let i = 0;
        const worker = async () => {
          while (i < cards.length) {
            const c = cards[i++];
            const found = await self.aniFound(c.id, 'en', false).catch(() => []);
            if (found.length > 0) await warmAniCover(c.id);
          }
        };
        await Promise.all(Array.from({ length: ANI_WARM_AT_ONCE }, worker));
      }
    }).finally(() => {
      aniWarming = null;
    });
    return aniWarming;
  }

  const self: Manga = {
    anilist,

    async aniFound(alId, lang, adult) {
      const card = await anilist.card(alId);
      if (card.adult && !adult) throw new ApiError(404, 'anilist_not_found', 'AniList doesn’t have that.');
      const wide = adult || card.adult;
      const key = aniFoundKey(alId, lang, wide);
      const look = () => copiesOfCard(card, (q) => self.search(q), lang, wide);
      const found = await aniFoundMemo.get(key, look);
      const right = found.filter((f) => isCardsSeries(card, f));
      // Kept before matching was this strict, with another series in it: looked for again now,
      // the rest of what's kept staying as it is.
      if (right.length < found.length) return aniFoundMemo.get(key, look, true);
      return right;
    },

    async aniFoundKept(alIds, lang, adult) {
      const out: Record<string, MangaFound[]> = {};
      const one = async (alId: number) => {
        const card = await anilist.cardKept(alId);
        if (!card) return;
        if (card.adult && !adult) return;
        const wide = adult || card.adult;
        // As kept, even past its time: looking again is left to the warming and to one asked alone,
        // as a page's worth at once would hold up readers' own searches on the sites.
        const found = await aniFoundMemo.peek(aniFoundKey(alId, lang, wide));
        if (found === undefined) return;
        const right = found.filter((f) => isCardsSeries(card, f));
        // Kept with another series in it: asked alone, which looks for it again.
        if (right.length < found.length) return;
        out[alId] = right;
      };
      await Promise.all(alIds.map(one));
      return out;
    },

    async search(q, onSome) {
      const began = Date.now();
      const same = opts.same ?? null;
      // In MANGA_KINDS' order, so the same ask is kept once.
      let kinds: MangaKind[] = [...MANGA_KINDS];
      const asked = q.kinds;
      if (asked && asked.length > 0) kinds = MANGA_KINDS.filter((k) => asked.includes(k));
      const w: Wanted = { lang: q.lang, sort: q.sort, adult: !!q.adult || !!q.adultOnly, doujinshi: !!q.doujinshi, kinds };
      if (q.adultOnly) w.adultOnly = true;
      if (q.q) w.q = q.q;
      if (q.names) w.names = same ? await same.widen(q.names) : q.names;
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
      // What's come so far shows the groups known already; the lot's whole waits a moment for Gemini
      // to group what it hasn't seen together, only the first time (same.ts).
      // A tab (no name searched for) leaves out the cards Gemini said don't belong, and has the
      // ones it hasn't seen there checked behind the reader (curate.ts).
      const curate = opts.curate ?? null;
      let tab: Tab | null = null;
      if (curate && !w.q && !w.names) tab = { sort: w.sort ?? 'popular', lang: w.lang ?? 'en', kinds, adult: w.adult, adultOnly: !!w.adultOnly, doujinshi: w.doujinshi };
      const shown = (items: MangaFound[]) => {
        let out = items;
        if (same) out = same.known(out);
        if (tab) out = curate!.known(tab, out);
        return out;
      };
      let some = onSome;
      if (onSome && (same || tab)) some = (items) => onSome(shown(items));
      const lot = await find(places, w.q, q.next, DEADLINE, grace, !w.names, some);
      let items = lot.items;
      if (same) items = await same.settle(items, Math.min(GROUP_WAIT, SEARCH_WITHIN - (Date.now() - began)));
      if (tab) items = await curate!.check(tab, items);
      return { ...lot, items };
    },

    series: (id, adult) => dex.series(id, adult),
    chapters: (id, lang) => dex.chapters(id, lang),
    page: (chapterId, n, saver, quiet) => dex.page(chapterId, n, saver, quiet),
    cover: (mangaId, file, size, early) => dex.cover(mangaId, file, size, early),
    coversFor: (id, freshFor) => covers.listed(id, freshFor),
    async warm() {
      // Side by side: shelving the sources' lists takes a while, and AniList's lists shouldn't wait on it.
      const lists = suwayomi ? suwayomi.warm() : dex.warm();
      await Promise.all([lists, warmAniList()]);
    },

    sourceSeries: (id, adult) => onSuwayomi().series(id, adult),
    sourceChapters: (id) => onSuwayomi().chapters(id),
    sourceCover: (id, size, early) => onSuwayomi().cover(id, Number(size) as CoverWidth, early),
    sourcePages: (chapterId) => onSuwayomi().pages(chapterId),
    sourcePage: (chapterId, page, quiet) => onSuwayomi().page(chapterId, page, quiet),

    copies: (id, lang) => copyMemo.get(`${id}:${lang}`, () => measureCopies(id, lang)),
  };
  return self;
}
