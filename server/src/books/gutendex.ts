import type { BookCard, BookFoundIn, BookItem } from '@breader/shared';
import { Memo, MemoryStore, type Store } from '../lib/cache.ts';
import type { Cover, Covers, CoverWidth } from '../manga/covers.ts';
import { pictureType } from '../manga/disk.ts';
import { wantedName, type Found, type Lot, type Place } from '../manga/find.ts';
import { Pace } from '../manga/pace.ts';
import { isZip } from './epub.ts';
import { bytesFrom, jsonFrom, notFound, refused } from './http.ts';
import { subjectIn, type BookWanted } from './wanted.ts';

/*
 * Project Gutenberg's books, through Gutendex (gutendex.com), its catalogue as JSON: whole books,
 * each its own EPUB, found by title or author, by language and by topic. Only those with an EPUB
 * are asked for. Lists are kept a day, a book's details a week, as they hardly ever change.
 */

const DAY = 24 * 3_600_000;
const LIST_FOR = DAY;
const LIST_KEPT = 7 * DAY;
const BOOK_FOR = 7 * DAY;
const BOOK_KEPT = 30 * DAY;
/** The most pages of a list asked, as each holds 32 books. */
const MOST_PAGES = 100;
const EPUB = 'application/epub+zip';
const JPEG = 'image/jpeg';
/** Its subjects shown at most, as genres. */
const MOST_GENRES = 8;

interface RawBook {
  id: number;
  title: string;
  authors: Array<{ name: string }>;
  summaries?: string[];
  subjects: string[];
  bookshelves: string[];
  languages: string[];
  formats: Record<string, string>;
}

interface RawPage {
  next: string | null;
  results: RawBook[];
}

export interface Gutenberg {
  place(w: BookWanted): Place<BookFoundIn>;
  item(n: number): Promise<BookItem>;
  /** Its EPUB. */
  file(n: number): Promise<Uint8Array>;
  cover(n: number, width: CoverWidth, early?: number): Promise<Cover>;
  /** The first page of its Popular list kept ahead of readers, with its covers. */
  warm(): Promise<void>;
}

export interface GutenbergOptions {
  covers: Covers;
  fetch?: typeof fetch;
  pace?: [number, number];
  store?: Store | null;
  /** Gutendex, or another of its kind. */
  url?: string;
}

/** An author as Gutenberg files them ("Doyle, Arthur Conan") as they're written: Arthur Conan Doyle. */
export function authorName(said: string): string {
  // Their full names, in brackets: C. S. (Clive Staples).
  const bare = said.replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  const comma = bare.indexOf(',');
  if (comma === -1) return bare;
  const last = bare.slice(0, comma).trim();
  const first = bare.slice(comma + 1).trim();
  if (!first) return last;
  return `${first} ${last}`;
}

/** Its title on one line. */
function titleOf(b: RawBook): string {
  return b.title.replace(/\s+/g, ' ').trim();
}

/** The names it goes by: its title, and the part before its subtitle. */
function namesOf(title: string): string[] {
  const names = [title];
  const short = title.split(/[;:]/)[0].trim();
  if (short && short !== title) names.push(short);
  return names;
}

/** Its subjects as genres: "Love stories -- Fiction" is Love stories. */
function genresOf(b: RawBook): string[] {
  const out: string[] = [];
  for (const s of b.subjects) {
    const g = s.split(' -- ')[0].trim();
    if (g && !out.includes(g)) out.push(g);
    if (out.length >= MOST_GENRES) break;
  }
  return out;
}

export function makeGutenberg(opts: GutenbergOptions): Gutenberg {
  const fetchFn = opts.fetch ?? fetch;
  const base = (opts.url ?? 'https://gutendex.com').replace(/\/+$/, '');
  const [count, per] = opts.pace ?? [2, 1000];
  const pace = new Pace(count, per, 20_000);

  function memo<T>(kind: string, ttl: number, keep: number, max: number): Memo<T> {
    let store: Store;
    if (opts.store) store = opts.store;
    else store = new MemoryStore(max);
    return new Memo<T>(store, `books:v1:pg-${kind}`, ttl, keep);
  }
  const lists = memo<RawPage>('list', LIST_FOR, LIST_KEPT, 300);
  const books = memo<RawBook>('book', BOOK_FOR, BOOK_KEPT, 2000);

  /** A page of books with an EPUB, as a search asks. */
  function listPage(w: BookWanted, page: number): Promise<RawPage> {
    const params = new URLSearchParams({ languages: w.lang, mime_type: EPUB, page: String(page) });
    if (w.q) params.set('search', w.q);
    if (w.subject) params.set('topic', subjectIn(w.subject).gutenberg);
    // Newest first: its latest books. Otherwise the most downloaded first, as Gutendex has them.
    if (w.sort === 'latest') params.set('sort', 'descending');
    else params.set('sort', 'popular');
    params.sort();
    const url = `${base}/books/?${params}`;
    return lists.get(url, () => jsonFrom<RawPage>(fetchFn, url, pace));
  }

  function book(n: number): Promise<RawBook> {
    return books.get(String(n), () => jsonFrom<RawBook>(fetchFn, `${base}/books/${n}`, pace));
  }

  function cardOf(b: RawBook): BookCard {
    const id = `pg:${b.id}`;
    let cover: string | null = null;
    if (b.formats[JPEG]) cover = `/v1/catalogue/item/${id}/cover`;
    const authors = b.authors.map((a) => authorName(a.name));
    return { id, title: titleOf(b), cover, authors, status: null, kind: 'book', side: false, mtl: false, chapters: null, year: null };
  }

  async function lot(w: BookWanted, at: string): Promise<Lot<BookFoundIn>> {
    let page = Number(at);
    if (page < 1) page = 1;
    const r = await listPage(w, page);
    const found: Found<BookFoundIn>[] = [];
    for (const b of r.results) {
      if (!b.formats[EPUB]) continue;
      const card = cardOf(b);
      const names = namesOf(card.title);
      if (!wantedName(names, w)) continue;
      found.push({ item: { source: 'Project Gutenberg', card }, names });
    }
    let next: string | null = null;
    if (r.next && page < MOST_PAGES) next = String(page + 1);
    return { found, next };
  }

  async function coverOf(n: number, width: CoverWidth, early?: number): Promise<Cover> {
    const b = await book(n);
    const url = b.formats[JPEG];
    if (!url) throw notFound();
    const id = `pg:${n}`;
    return opts.covers.get(id, id, width, async () => {
      const data = await bytesFrom(fetchFn, url, pace);
      const type = pictureType(data);
      if (!type) throw refused();
      return { data, type };
    }, early);
  }

  return {
    place(w) {
      return { key: 'pg', name: 'Project Gutenberg', lot: (at) => lot(w, at) };
    },

    async item(n) {
      const b = await book(n);
      const card = cardOf(b);
      let description = '';
      if (b.summaries && b.summaries.length > 0) description = b.summaries[0];
      return {
        ...card,
        source: 'Project Gutenberg',
        description,
        genres: genresOf(b),
        link: `https://www.gutenberg.org/ebooks/${n}`,
        volumes: [{ n: 1, title: card.title, chapters: 0, first: null, last: null, open: false }],
        ranobe: null,
      };
    },

    async file(n) {
      const b = await book(n);
      const url = b.formats[EPUB];
      if (!url) throw notFound();
      const data = await bytesFrom(fetchFn, url, pace);
      if (!isZip(data)) throw refused();
      return data;
    },

    cover: coverOf,

    async warm() {
      const w: BookWanted = { lang: 'en', kinds: ['book'], sort: 'popular' };
      const first = await lot(w, '0');
      for (const f of first.found) {
        const id = f.item.card.id;
        if (!f.item.card.cover) continue;
        if (await opts.covers.has(id)) continue;
        await coverOf(Number(id.slice(3)), 512).catch(() => {});
      }
    },
  };
}
