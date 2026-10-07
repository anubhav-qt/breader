import { MANGA_PAGE, type MangaChapter, type MangaChapters, type MangaSort, type SourceCard, type SourceSeries } from '@breader/shared';
import { Memo, MemoryStore, type Store } from '../lib/cache.ts';
import { ApiError } from '../lib/errors.ts';
import { log } from '../log.ts';
import { pictureType, type Picture } from './disk.ts';
import type { Found, Lot, Place, Wanted } from './find.ts';
import { adultGenre, neverGenre, sideGenre, web } from './genres.ts';
import { Busy, Gate, Pace } from './pace.ts';

/*
 * Breader's own Komga library (KOMGA_URL, with its KOMGA_API_KEY): one place a search looks
 * (find.ts), its comics read through here, the same for every reader. Only series whose books are
 * pictures (CBZ, CBR and the like) are manga to read; books as text (EPUB) stay out. It's Breader's
 * own library, so every series in it counts as readable. Rated 18 or older, a series is for adults;
 * tagged loli or shota it's never shown, and doujinshi and anthologies show only when asked. Komga
 * is near, so pages and covers come straight from it, kept nowhere.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NAME = 'Komga';

const STATUS = new Map<string, SourceCard['status']>([
  ['ONGOING', 'ongoing'],
  ['ENDED', 'completed'],
  ['ABANDONED', 'cancelled'],
  ['HIATUS', 'hiatus'],
]);

/** Komga's order for each of a search's, when nothing's typed (a typed search comes as Komga finds it). */
const SORT: Record<MangaSort, string> = {
  relevance: 'metadata.titleSort,asc',
  popular: 'metadata.titleSort,asc',
  rated: 'metadata.titleSort,asc',
  latest: 'lastModifiedDate,desc',
  new: 'createdDate,desc',
};

interface RawSeries {
  id: string;
  name: string;
  booksCount: number;
  metadata: {
    title: string;
    status: string;
    ageRating: number | null;
    language: string;
    summary: string;
    genres: string[];
    tags: string[];
    alternateTitles?: Array<{ title: string }>;
    links?: Array<{ url: string }>;
  };
  booksMetadata: { authors?: Array<{ name: string }>; summary?: string; tags?: string[] };
}
interface RawBook {
  id: string;
  seriesId: string;
  created?: string;
  metadata: { number: string; title: string };
  media: { pagesCount: number; mediaProfile?: string; epubDivinaCompatible?: boolean };
}
interface Paged<T> {
  content: T[];
  last: boolean;
}

export interface Komga {
  place(w: Wanted): Place;
  series(id: string, adult: boolean): Promise<SourceSeries>;
  chapters(id: string): Promise<MangaChapters>;
  /** How many pages a book has. */
  pages(bookId: string): Promise<number>;
  /** Page n of a book, from 0. */
  page(bookId: string, n: number): Promise<Picture>;
  cover(id: string): Promise<Picture>;
}

export interface KomgaOptions {
  url: string;
  key: string;
  fetch?: typeof fetch;
  /** Calls a window. Tests go faster. */
  pace?: [number, number];
  /** Where its answers are kept: Redis, when the server has one. Without, in memory. */
  store?: Store | null;
}

const notFound = () => new ApiError(404, 'manga_not_found', 'That series isn’t in the library any more.');
const noPage = () => new ApiError(404, 'manga_not_found', 'That chapter has no page there.');
const busy = () => new ApiError(503, 'manga_busy', 'The library is busy just now. Try again in a minute.');
const unreachable = () => new ApiError(503, 'manga_unreachable', 'Breader can’t reach its library just now. Try again in a minute.');
const adultOnly = () => new ApiError(403, 'manga_adult', 'This series is for adults. Turn on Show 18+ to see it.');

/** Pictures, page by page, rather than text. */
function pictures(b: RawBook): boolean {
  if (b.media.mediaProfile === 'DIVINA') return true;
  return b.media.epubDivinaCompatible === true;
}

function genresOf(s: RawSeries): string[] {
  return [...new Set([...s.metadata.genres, ...s.metadata.tags, ...(s.booksMetadata.tags ?? [])])];
}

function cardOf(s: RawSeries): SourceCard {
  let status: SourceCard['status'] = null;
  const known = STATUS.get(s.metadata.status);
  if (known) status = known;
  const genres = genresOf(s);
  let adult = adultGenre(genres);
  if (s.metadata.ageRating !== null && s.metadata.ageRating >= 18) adult = true;
  let title = s.metadata.title.trim();
  if (!title) title = s.name;
  return { id: `kg:${s.id}`, title, cover: `/v1/manga/source/kg:${s.id}/cover`, status, adult, side: sideGenre(genres) };
}

function namesOf(s: RawSeries): string[] {
  const out = [s.metadata.title, s.name];
  for (const alt of s.metadata.alternateTitles ?? []) out.push(alt.title);
  return out;
}

function chapterOf(b: RawBook): MangaChapter {
  let chapter: string | null = null;
  const number = b.metadata.number.trim();
  if (number) chapter = number;
  let at = Date.parse(b.created ?? '');
  if (!Number.isFinite(at)) at = 0;
  return { id: `kg:${b.id}`, chapter, volume: null, title: b.metadata.title.trim() || null, pages: b.media.pagesCount, external: null, groups: [], at };
}

export function makeKomga(opts: KomgaOptions): Komga {
  const fetchFn = opts.fetch ?? fetch;
  const base = opts.url.replace(/\/+$/, '');
  const [count, per] = opts.pace ?? [4, 1000];
  const pace = new Pace(count, per, 20_000);
  const images = new Gate(8, 30_000);

  /** Answers of a kind, kept so long: in the store when there's one, or else in memory, up to `max` of them. */
  function memo<T>(kind: string, ttl: number, max: number): Memo<T> {
    let store: Store;
    if (opts.store) store = opts.store;
    else store = new MemoryStore(max);
    return new Memo<T>(store, `manga:v1:kg-${kind}`, ttl);
  }
  // Komga is Breader's own, so what it says is kept only a minute: new books show soon.
  const lists = memo<Paged<RawSeries>>('search', MINUTE, 300);
  const seriesMemo = memo<RawSeries>('series', MINUTE, 3000);
  const bookLists = memo<RawBook[]>('books', MINUTE, 300);
  const bookMemo = memo<RawBook>('book', MINUTE, 3000);
  /** Whether a series' books are pictures, by its first. */
  const kinds = memo<boolean>('pictures', 6 * HOUR, 20_000);

  async function send(path: string, accept: string): Promise<Response> {
    try {
      return await fetchFn(`${base}${path}`, { headers: { 'x-api-key': opts.key, accept }, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      log.warn({ err }, 'Komga didn’t answer');
      throw unreachable();
    }
  }

  async function call<T>(path: string): Promise<T> {
    try {
      await pace.take();
    } catch {
      throw busy();
    }
    const res = await send(path, 'application/json');
    if (res.status === 404 || res.status === 400) throw notFound();
    if (!res.ok) {
      log.warn({ status: res.status, path }, 'Komga refused a call');
      throw unreachable();
    }
    const body = await res.json().catch(() => null);
    if (body === null) throw unreachable();
    return body as T;
  }

  const rawSeries = (id: string) => seriesMemo.get(id, () => call<RawSeries>(`/api/v1/series/${id}`));
  const rawBook = (id: string) => bookMemo.get(id, () => call<RawBook>(`/api/v1/books/${id}`));

  /** Its books, in order. */
  function books(id: string): Promise<RawBook[]> {
    return bookLists.get(id, async () => {
      const r = await call<Paged<RawBook>>(`/api/v1/series/${id}/books?unpaged=true&sort=metadata.numberSort,asc`);
      for (const b of r.content) bookMemo.set(b.id, b);
      return r.content;
    });
  }

  /** The series' books are pictures, by its first. */
  function readAsPictures(id: string): Promise<boolean> {
    return kinds.get(id, async () => {
      const r = await call<Paged<RawBook>>(`/api/v1/series/${id}/books?page=0&size=1&sort=metadata.numberSort,asc`);
      const first = r.content[0];
      if (!first) return false;
      return pictures(first);
    });
  }

  /** A series that can be shown at all. */
  async function allowed(id: string): Promise<RawSeries> {
    const s = await rawSeries(id);
    if (neverGenre(genresOf(s))) throw notFound();
    if (!(await readAsPictures(id))) throw notFound();
    return s;
  }

  /** A book of pictures in a series that can be shown. */
  async function allowedBook(id: string): Promise<RawBook> {
    const b = await rawBook(id);
    if (!pictures(b)) throw notFound();
    await allowed(b.seriesId);
    return b;
  }

  /** A series a search found, when it's one to show. */
  async function foundOf(s: RawSeries, w: Wanted): Promise<Found | null> {
    seriesMemo.set(s.id, s);
    if (s.booksCount === 0) return null;
    if (neverGenre(genresOf(s))) return null;
    const card = cardOf(s);
    if (card.adult && !w.adult) return null;
    if (card.side && !w.doujinshi) return null;
    const lang = s.metadata.language.trim().toLowerCase();
    if (w.lang && lang && lang !== w.lang) return null;
    if (!(await readAsPictures(s.id))) return null;
    return { item: { kind: 'source', source: NAME, card }, names: namesOf(s) };
  }

  /** A search's next lot from the library: a page of ten series, Komga's pages counting from 0. */
  async function lot(w: Wanted, at: string): Promise<Lot> {
    const page = Number(at);
    const params = new URLSearchParams({ page: String(page), size: String(MANGA_PAGE) });
    if (w.q) params.set('search', w.q);
    else params.set('sort', SORT[w.sort ?? 'popular']);
    const listed = await lists.get(params.toString(), () => call<Paged<RawSeries>>(`/api/v1/series?${params}`));
    let failed: unknown = null;
    const each = await Promise.all(
      listed.content.map((s) =>
        foundOf(s, w).catch((e) => {
          failed = e;
          return null;
        }),
      ),
    );
    const found: Found[] = [];
    for (const f of each) {
      if (f) found.push(f);
    }
    if (found.length === 0 && failed) throw failed;
    let next: string | null = null;
    if (!listed.last && listed.content.length > 0) next = String(page + 1);
    return { found, next };
  }

  /** A picture from Komga: a page, or a cover. */
  async function picture(path: string): Promise<Picture> {
    try {
      return await images.run(async () => {
        const res = await send(path, 'image/*');
        if (res.status === 404 || res.status === 400) throw notFound();
        if (!res.ok) throw unreachable();
        const data = new Uint8Array(await res.arrayBuffer());
        const type = pictureType(data);
        if (!type) throw unreachable();
        return { data, type };
      });
    } catch (e) {
      if (e instanceof Busy) throw busy();
      throw e;
    }
  }

  return {
    place(w) {
      return { key: 'kg', name: NAME, lot: (at) => lot(w, at) };
    },

    async series(id, adult) {
      const s = await allowed(id);
      const card = cardOf(s);
      if (card.adult && !adult) throw adultOnly();
      const authors: string[] = [];
      for (const a of s.booksMetadata.authors ?? []) {
        const name = a.name.trim();
        if (name && !authors.includes(name)) authors.push(name);
      }
      let description = s.metadata.summary.trim();
      if (!description) description = (s.booksMetadata.summary ?? '').trim();
      const link = web(s.metadata.links?.[0]?.url);
      return { ...card, source: NAME, authors, description: description.slice(0, 6000), genres: genresOf(s), link };
    },

    async chapters(id) {
      const s = await allowed(id);
      let lang = s.metadata.language.trim().toLowerCase();
      if (!/^[a-z]{2,3}(-[a-z]{2,3})?$/.test(lang)) lang = 'en';
      const list = (await books(id)).filter(pictures).map(chapterOf);
      return { lang, chapters: list };
    },

    async pages(bookId) {
      const b = await allowedBook(bookId);
      return b.media.pagesCount;
    },

    async page(bookId, n) {
      const b = await allowedBook(bookId);
      if (n >= b.media.pagesCount) throw noPage();
      // Komga counts pages from 1.
      return picture(`/api/v1/books/${bookId}/pages/${n + 1}`);
    },

    async cover(id) {
      await allowed(id);
      return picture(`/api/v1/series/${id}/thumbnail`);
    },
  };
}
