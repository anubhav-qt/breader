import type { MangaChapters, MangaSearchResult, MangaSeries, MangaSort, SourceSeries } from '@breader/shared';
import type { Store } from '../lib/cache.ts';
import { ApiError } from '../lib/errors.ts';
import { log } from '../log.ts';
import { Disk, type Picture } from './disk.ts';
import { find, type Place, type Wanted } from './find.ts';
import { makeKomga, type Komga } from './komga.ts';
import { makeMangaDex } from './mangadex.ts';
import { makeSuwayomi, type Suwayomi } from './suwayomi.ts';

/*
 * Manga through the laptop: one search across MangaDex, the sources of Breader's Suwayomi server
 * and its Komga library (find.ts), and each series, its chapters and their pages from wherever it
 * is. Suwayomi and Komga are on when the server is given their addresses.
 */

export interface Manga {
  search(q: { q?: string; lang?: string; sort?: MangaSort; adult?: boolean; doujinshi?: boolean; next?: string }): Promise<MangaSearchResult>;
  /** A MangaDex series, its chapters in a language, a chapter's page (from 0) and a cover. */
  series(id: string, adult: boolean): Promise<MangaSeries>;
  chapters(id: string, lang: string): Promise<MangaChapters>;
  page(chapterId: string, n: number, saver: boolean): Promise<Picture>;
  cover(mangaId: string, file: string, size: '256' | '512'): Promise<Picture>;
  /** A series on Suwayomi (sw:12) or in Komga (kg:0RVCY8NST343X), and the like. */
  sourceSeries(id: string, adult: boolean): Promise<SourceSeries>;
  sourceChapters(id: string): Promise<MangaChapters>;
  sourceCover(id: string): Promise<Picture>;
  /** How many pages a chapter of a source has. */
  sourcePages(chapterId: string): Promise<number>;
  sourcePage(chapterId: string, n: number): Promise<Picture>;
  /** Checks MangaDex's Popular and Updated first screens ahead of readers. */
  warm(): Promise<void>;
}

export interface MangaOptions {
  /** Where pages and covers are kept, up to so many bytes. */
  dir: string;
  cacheBytes: number;
  fetch?: typeof fetch;
  /** Calls a window: MangaDex's API overall (each source and Komga the same), and its page servers' addresses. Tests go faster. */
  pace?: { api: [number, number]; home: [number, number] };
  /** Where answers are kept: Redis, when the server has one. Without, in memory. */
  store?: Store | null;
  /** Breader's Suwayomi server, when it has one. */
  suwayomi?: string;
  /** Breader's Komga library, and the API key it gave Breader, when it has one. */
  komga?: { url: string; key: string };
}

const off = () => new ApiError(404, 'manga_not_found', 'That source isn’t on, on this server.');

export function makeManga(opts: MangaOptions): Manga {
  const disk = new Disk(opts.dir, opts.cacheBytes);
  const store = opts.store ?? null;
  const pace = opts.pace?.api;
  const dex = makeMangaDex({ disk, fetch: opts.fetch, pace: opts.pace, store });
  let suwayomi: Suwayomi | null = null;
  if (opts.suwayomi) suwayomi = makeSuwayomi({ url: opts.suwayomi, disk, fetch: opts.fetch, pace, store });
  let komga: Komga | null = null;
  if (opts.komga) komga = makeKomga({ url: opts.komga.url, key: opts.komga.key, fetch: opts.fetch, pace, store });

  /** Suwayomi's series or chapter number in an id like sw:12. */
  function onSuwayomi(id: string): number | null {
    if (!id.startsWith('sw:')) return null;
    if (!suwayomi) throw off();
    return Number(id.slice(3));
  }
  /** Komga's id in one like kg:0RVCY8NST343X. */
  function inKomga(id: string): string {
    if (!komga) throw off();
    return id.slice(3);
  }

  return {
    async search(q) {
      const w: Wanted = { lang: q.lang, sort: q.sort, adult: !!q.adult, doujinshi: !!q.doujinshi };
      if (q.q) w.q = q.q;
      const places: Place[] = [dex.place(w)];
      if (komga) places.push(komga.place(w));
      if (suwayomi) {
        try {
          places.push(...(await suwayomi.places(w)));
        } catch (err) {
          log.warn({ err }, 'Suwayomi’s sources couldn’t be listed, so the search goes on without them');
        }
      }
      return find(places, w.q, q.next);
    },

    series: (id, adult) => dex.series(id, adult),
    chapters: (id, lang) => dex.chapters(id, lang),
    page: (chapterId, n, saver) => dex.page(chapterId, n, saver),
    cover: (mangaId, file, size) => dex.cover(mangaId, file, size),
    warm: () => dex.warm(),

    async sourceSeries(id, adult) {
      const n = onSuwayomi(id);
      if (n !== null) return suwayomi!.series(n, adult);
      return komga!.series(inKomga(id), adult);
    },

    async sourceChapters(id) {
      const n = onSuwayomi(id);
      if (n !== null) return suwayomi!.chapters(n);
      return komga!.chapters(inKomga(id));
    },

    async sourceCover(id) {
      const n = onSuwayomi(id);
      if (n !== null) return suwayomi!.cover(n);
      return komga!.cover(inKomga(id));
    },

    async sourcePages(chapterId) {
      const n = onSuwayomi(chapterId);
      if (n !== null) return suwayomi!.pages(n);
      return komga!.pages(inKomga(chapterId));
    },

    async sourcePage(chapterId, page) {
      const n = onSuwayomi(chapterId);
      if (n !== null) return suwayomi!.page(n, page);
      return komga!.page(inKomga(chapterId), page);
    },
  };
}
