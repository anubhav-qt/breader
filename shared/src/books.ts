import { z } from 'zod';
import type { SeriesNames } from './manga.ts';

/*
 * Books through the laptop (server routes/books.ts), found as manga are: one search across every
 * place it looks, each book shown once with every place it's in. Web and light novels come from
 * their sites through LNReader's plugins, chapter by chapter, and are read by volume: each volume
 * made into an EPUB, added as a book of its own. Other books come whole, as their EPUBs: Project
 * Gutenberg's through Gutendex, and Open Library's free ones from Standard Ebooks or the Internet
 * Archive. Their own shapes are the server's business; these are what it answers.
 */

const Flag = z.enum(['0', '1']).transform((v) => v === '1');

/** Light novels (RanobeDB knows them), web novels (any other on a novel site), and every other book. */
export const BOOK_KINDS = ['light', 'web', 'book'] as const;
export type BookKind = (typeof BOOK_KINDS)[number];
const Kinds = z
  .string()
  .regex(/^(light|web|book)(,(light|web|book)){0,2}$/, 'Not kinds of book')
  .transform((v) => [...new Set(v.split(','))] as BookKind[]);

export const BOOK_SORTS = ['relevance', 'popular', 'latest'] as const;
export type BookSort = (typeof BOOK_SORTS)[number];

/** What Browse's books are about, as a reader picks them: a novel by its genres, a book by its subjects. */
export const BOOK_SUBJECTS = [
  { id: 'fantasy', name: 'Fantasy' },
  { id: 'romance', name: 'Romance' },
  { id: 'scifi', name: 'Science fiction' },
  { id: 'mystery', name: 'Mystery' },
  { id: 'horror', name: 'Horror' },
  { id: 'adventure', name: 'Adventure' },
  { id: 'drama', name: 'Drama' },
  { id: 'humour', name: 'Humour' },
  { id: 'selfhelp', name: 'Self-help' },
  { id: 'philosophy', name: 'Philosophy' },
  { id: 'psychology', name: 'Psychology' },
  { id: 'history', name: 'History' },
  { id: 'biography', name: 'Biography' },
  { id: 'science', name: 'Science' },
  { id: 'economics', name: 'Economics' },
  { id: 'religion', name: 'Religion' },
  { id: 'travel', name: 'Travel' },
  { id: 'poetry', name: 'Poetry' },
  { id: 'children', name: 'Children’s' },
] as const;
export type BookSubject = (typeof BOOK_SUBJECTS)[number]['id'];
const SUBJECT_IDS = BOOK_SUBJECTS.map((s) => s.id) as [BookSubject, ...BookSubject[]];

/**
 * A book in one place: a novel on a site (nv:<plugin>:<its path there, base64url>), a Project
 * Gutenberg book (pg:1342), or an Open Library work (ol:OL66554W).
 */
export const BookId = z.string().regex(/^(nv:[\w.-]{1,40}:[\w-]{1,1400}|pg:[1-9]\d{0,6}|ol:OL[1-9]\d{0,9}W)$/, 'Not a book');

/** Where a search carries on, place by place, as manga's does: nv-<plugin>:s40, pg:3, ol:2. */
const PLACE = String.raw`(nv-[\w.-]{1,40}|pg|ol):(s\d{1,6}|\d{1,6}(\.\d{1,4})?)`;
const Next = z.string().max(20_000).regex(new RegExp(`^${PLACE}(,${PLACE}){0,299}$`), 'Not where a search carries on');

/** Book names as seriesName keys them, comma separated. */
const Names = z
  .string()
  .max(4000)
  .regex(/^[\p{L}\p{N}]{1,200}(,[\p{L}\p{N}]{1,200}){0,39}$/u, 'Not book names')
  .transform((v) => [...new Set(v.split(','))]);

const BookLang = z.string().regex(/^[a-z]{2,3}(-[a-z]{2,3})?$/, 'Not a language');

export const BookSearchQuery = z.object({
  q: z.string().trim().max(200).optional(),
  /** Books in this language; English when left out. */
  lang: BookLang.optional(),
  /** relevance when there's a search, popular when there isn't. */
  sort: z.enum(BOOK_SORTS).optional(),
  /** Only these kinds; every kind when left out. */
  kinds: Kinds.optional(),
  /** Only books about this. */
  subject: z.enum(SUBJECT_IDS).optional(),
  /** Only books going by one of these names: a book's sheet, looking for its other copies. */
  names: Names.optional(),
  /** Each place's books as they come, as server-sent events (BookSearchEvent), before the whole lot. */
  stream: Flag.optional(),
  next: Next.optional(),
});
export type BookSearchQuery = z.input<typeof BookSearchQuery>;

export const BookCoverQuery = z.object({ size: z.enum(['256', '512']).default('512') });
/** A volume, from 1. */
export const BookVolumeN = z.coerce.number().int().min(1).max(10_000);

export interface BooksState {
  /** Books are on, on this server. */
  on: boolean;
}

/** A book as a search lists it. */
export interface BookCard {
  id: string;
  title: string;
  /** Its cover through the laptop (/v1/books/item/:id/cover), or null when it has none. */
  cover: string | null;
  authors: string[];
  status: 'ongoing' | 'completed' | 'hiatus' | 'cancelled' | null;
  /** Null when not known. */
  kind: BookKind | null;
  /** Never set aside, as manga's doujinshi are: there for the search they share with manga. */
  side: false;
  /** Machine translated: its site says so. */
  mtl: boolean;
  /** A novel's chapters; null for a book that comes whole. */
  chapters: number | null;
  year: number | null;
}

/** A book a place found, and the place's name (source), shown under the title. */
export interface BookFoundIn {
  source: string;
  card: BookCard;
}

/** A book a search found, and where; the same book in two places shares a key, so the app shows it as one. */
export type BookFound = BookFoundIn & SeriesNames;

export interface BookSearchResult {
  items: BookFound[];
  next: string | null;
}

export type BookSearchEvent =
  | { kind: 'some'; items: BookFound[] }
  | { kind: 'lot'; items: BookFound[]; next: string | null }
  | { kind: 'error'; status: number; code: string; message: string };

/** One volume of a book: a novel's (its site's, or 100 chapters), or a whole book as its only one. */
export interface BookVolume {
  /** From 1. */
  n: number;
  title: string;
  /** A novel's chapters in it; 0 for a whole book. */
  chapters: number;
  /** Its first and last chapters' names, for a novel. */
  first: string | null;
  last: string | null;
  /** Still growing: an ongoing novel's last, which gains chapters as they come out. */
  open: boolean;
}

/** A book as its sheet shows it. */
export interface BookItem extends BookCard {
  /** Where it's from: the site's name (NovelBin), Project Gutenberg, Standard Ebooks. */
  source: string;
  description: string;
  genres: string[];
  /** Its page on its own site, which is credited wherever it's read. */
  link: string | null;
  volumes: BookVolume[];
  /** Its page on RanobeDB, for a light novel it knows. */
  ranobe: string | null;
}

/** A volume's EPUB: made and ready, being made (a novel's chapters fetched so far), or not to be had. */
export type BookVolumeState =
  | { state: 'ready'; bytes: number }
  | { state: 'making'; done: number; total: number }
  | { state: 'failed'; message: string };

/**
 * A book added from the catalogue: its file's book (BookId), the volume, and how many chapters it
 * held, so a volume that's grown since can be brought up to date: cat:nv:wtrlab:L25vdmVs#v3-100.
 */
export const CATALOGUE_URL = /^cat:(nv:[\w.-]{1,40}:[\w-]{1,1400}|pg:[1-9]\d{0,6}|ol:OL[1-9]\d{0,9}W)#v[1-9]\d{0,4}-\d{1,6}$/;
