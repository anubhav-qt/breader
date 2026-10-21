import { BOOK_KINDS, CATALOGUE_URL, type BookFound, type BookItem, type BookKind, type BookSearchEvent, type BookSearchResult, type BooksState, type BookSubject, type BookVolumeState } from '@breader/shared/books';
import { api, ApiError, laptopUrl } from './api';
import { eventsOf, query } from './mangadex';
import { readLocal, writeLocal } from './store';

/*
 * Books, through Breader's own computer (server routes/books.ts): web and light novels from their
 * sites, Project Gutenberg's books and Open Library's free ones, found as manga are. A volume is
 * made into an EPUB there and fetched whole, then added as a book like any other.
 */

const OFF = 'Breader’s computer can’t be reached right now. Books already added still open.';

async function ask<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError && e.code === 'laptop_off') throw new ApiError(503, 'laptop_off', OFF);
    throw e;
  }
}

export type BookOrder = 'popular' | 'latest';

export interface BookSearch {
  q?: string;
  lang?: string;
  sort?: BookOrder | 'relevance';
  /** Only these kinds; every kind when left out. */
  kinds?: BookKind[];
  subject?: BookSubject;
  /** Only books going by one of these names (seriesName keys): a sheet looking for a book's other copies. */
  names?: string[];
  /** Where the search carries on, as the last answer said. */
  next?: string;
}

/** The kinds as a search asks for them, or nothing when it's every kind. */
function kindsOf(kinds: BookKind[] | undefined): string | undefined {
  if (!kinds) return undefined;
  if (kinds.length === BOOK_KINDS.length) return undefined;
  return kinds.join(',');
}

const searchPath = (s: BookSearch, stream = false) =>
  `/v1/catalogue/search${query({ q: s.q?.trim(), lang: s.lang, sort: s.sort, kinds: kindsOf(s.kinds), subject: s.subject, names: s.names?.join(','), next: s.next, stream: stream ? 1 : undefined })}`;

export const catalogue = {
  state: () => ask(() => api.laptop.get<BooksState>('/v1/catalogue')),
  search: (s: BookSearch) => ask(() => api.laptop.get<BookSearchResult>(searchPath(s), 20_000)),
  /** The same lot, with what's found so far given to onSome each time a place brings something. */
  async searchAsItComes(s: BookSearch, onSome: (items: BookFound[]) => void): Promise<BookSearchResult> {
    const res = await ask(() => api.laptop.raw(searchPath(s, true), undefined, 20_000));
    for await (const e of eventsOf<BookSearchEvent>(res)) {
      if (e.kind === 'some') onSome(e.items);
      else if (e.kind === 'lot') return { items: e.items, next: e.next };
      else throw new ApiError(e.status, e.code, e.message);
    }
    throw new ApiError(503, 'books_cut', 'The search was cut off. Try again.');
  },
  /** A book's sheet. A novel's site is asked for its chapters, so it can take a while. */
  item: (id: string) => ask(() => api.laptop.get<BookItem>(`/v1/catalogue/item/${id}`, 45_000)),
  /** A cover's address on the laptop, from its path in a card (/v1/catalogue/item/pg:1342/cover). */
  coverUrl: (path: string, size: 256 | 512) => laptopUrl(`${path}?size=${size}`),
  async cover(path: string): Promise<Blob | undefined> {
    try {
      const res = await fetch(catalogue.coverUrl(path, 512));
      if (!res.ok) return undefined;
      return await res.blob();
    } catch {
      return undefined;
    }
  },
  /** A volume's EPUB: ready, being made (asking starts it), or not to be had. */
  volume: (id: string, n: number) => ask(() => api.laptop.get<BookVolumeState>(`/v1/catalogue/item/${id}/volume/${n}`, 20_000)),
  /** A ready volume's EPUB, and how many chapters it holds. For browsers signed in to a library. */
  async file(id: string, n: number): Promise<{ data: Blob; chapters: number }> {
    const res = await ask(() => api.laptop.raw(`/v1/catalogue/item/${id}/volume/${n}/file`, undefined, 120_000));
    const data = await res.blob();
    return { data, chapters: Number(res.headers.get('x-chapters') ?? '0') };
  },
};

/** A volume added from the catalogue, as its url in a library names it (CATALOGUE_URL). */
export interface CatalogueVolume {
  book: string;
  n: number;
  /** The chapters it held when it was added. */
  chapters: number;
}

export function catalogueUrl(v: CatalogueVolume): string {
  return `cat:${v.book}#v${v.n}-${v.chapters}`;
}

/** Which volume of which book a url names, or null when it's no catalogue volume's. */
export function volumeOfUrl(url: string | undefined): CatalogueVolume | null {
  if (!url || !CATALOGUE_URL.test(url)) return null;
  const hash = url.lastIndexOf('#v');
  const dash = url.lastIndexOf('-');
  return { book: url.slice('cat:'.length, hash), n: Number(url.slice(hash + 2, dash)), chapters: Number(url.slice(dash + 1)) };
}

/** How this device looks for books: in what language and order, which kinds, and about what. */
export interface BookPrefs {
  lang: string;
  /** At least one, in BOOK_KINDS' order. */
  kinds: BookKind[];
  sort: BookOrder;
  /** Only books about this, or '' for any. */
  subject: BookSubject | '';
}

const PREFS = 'breader.catalogue.v1';
const DEFAULTS: BookPrefs = { lang: 'en', kinds: [...BOOK_KINDS], sort: 'popular', subject: '' };

export function readBookPrefs(): BookPrefs {
  const prefs = { ...DEFAULTS, ...readLocal<Partial<BookPrefs>>(PREFS, {}) };
  let kinds: BookKind[] = [];
  if (Array.isArray(prefs.kinds)) kinds = BOOK_KINDS.filter((k) => prefs.kinds.includes(k));
  if (kinds.length === 0) kinds = [...BOOK_KINDS];
  let sort = prefs.sort;
  if (sort !== 'popular' && sort !== 'latest') sort = 'popular';
  let lang = prefs.lang;
  if (!lang) lang = 'en';
  return { ...prefs, lang, kinds, sort };
}
export const writeBookPrefs = (p: BookPrefs) => writeLocal(PREFS, p);

/** One book's kind, under its title. */
export const BOOK_KIND_NAME: Record<BookKind, string> = { light: 'Light novel', web: 'Web novel', book: 'Book' };
