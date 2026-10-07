import type { MangaChapters, MangaSearchResult, MangaSeries, MangaSort, SourceSeries } from '@breader/shared';
import type { Store } from '../lib/cache.ts';
import { ApiError } from '../lib/errors.ts';
import { log } from '../log.ts';
import { Disk, type Picture } from './disk.ts';
import { find, type Place, type Wanted } from './find.ts';
import { makeMangaDex } from './mangadex.ts';
import { makeSuwayomi, type Suwayomi } from './suwayomi.ts';

/*
 * Manga through the laptop: one search across MangaDex and the sources of Breader's Suwayomi server
 * (find.ts), and each series, its chapters and their pages from wherever it is. Suwayomi is on when
 * the server is given its address.
 */

export interface Manga {
  search(q: { q?: string; lang?: string; sort?: MangaSort; adult?: boolean; doujinshi?: boolean; next?: string }): Promise<MangaSearchResult>;
  /** A MangaDex series, its chapters in a language, a chapter's page (from 0) and a cover. */
  series(id: string, adult: boolean): Promise<MangaSeries>;
  chapters(id: string, lang: string): Promise<MangaChapters>;
  page(chapterId: string, n: number, saver: boolean): Promise<Picture>;
  cover(mangaId: string, file: string, size: '256' | '512'): Promise<Picture>;
  /** A series on Suwayomi (sw:12), and the like. */
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
  /** Calls a window: MangaDex's API overall (each source the same), and its page servers' addresses. Tests go faster. */
  pace?: { api: [number, number]; home: [number, number] };
  /** Where answers are kept: Redis, when the server has one. Without, in memory. */
  store?: Store | null;
  /** Breader's Suwayomi server, when it has one. */
  suwayomi?: string;
}

const off = () => new ApiError(404, 'manga_not_found', 'That source isn’t on, on this server.');

export function makeManga(opts: MangaOptions): Manga {
  const disk = new Disk(opts.dir, opts.cacheBytes);
  const store = opts.store ?? null;
  const pace = opts.pace?.api;
  const dex = makeMangaDex({ disk, fetch: opts.fetch, pace: opts.pace, store });
  let suwayomi: Suwayomi | null = null;
  if (opts.suwayomi) suwayomi = makeSuwayomi({ url: opts.suwayomi, disk, fetch: opts.fetch, pace, store });

  /** Suwayomi, and its series or chapter number in an id like sw:12. */
  function onSuwayomi(id: string): { suwayomi: Suwayomi; n: number } {
    if (!suwayomi) throw off();
    return { suwayomi, n: Number(id.slice(3)) };
  }

  return {
    async search(q) {
      const w: Wanted = { lang: q.lang, sort: q.sort, adult: !!q.adult, doujinshi: !!q.doujinshi };
      if (q.q) w.q = q.q;
      const places: Place[] = [dex.place(w)];
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
      const { suwayomi, n } = onSuwayomi(id);
      return suwayomi.series(n, adult);
    },

    async sourceChapters(id) {
      const { suwayomi, n } = onSuwayomi(id);
      return suwayomi.chapters(n);
    },

    async sourceCover(id) {
      const { suwayomi, n } = onSuwayomi(id);
      return suwayomi.cover(n);
    },

    async sourcePages(chapterId) {
      const { suwayomi, n } = onSuwayomi(chapterId);
      return suwayomi.pages(n);
    },

    async sourcePage(chapterId, page) {
      const { suwayomi, n } = onSuwayomi(chapterId);
      return suwayomi.page(n, page);
    },
  };
}
