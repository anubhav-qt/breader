import { z } from 'zod';

/*
 * MangaDex through the laptop (server routes/manga.ts): series to find, their chapters in a
 * language, and each chapter's pages as pictures. MangaDex's own shapes are the server's business;
 * these are what it answers. Scanlation groups made the chapters, so they're credited wherever a
 * chapter is read, and a series' official releases are linked from it.
 */

/** MangaDex's ids are UUIDs. */
export const MangaId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'Not a MangaDex id');
/** A language as MangaDex names them: en, ja, pt-br, es-la. */
export const MangaLang = z.string().regex(/^[a-z]{2,3}(-[a-z]{2,3})?$/, 'Not a language');
const Flag = z.enum(['0', '1']).transform((v) => v === '1');

export const MANGA_SORTS = ['relevance', 'popular', 'latest', 'new', 'rated'] as const;
export type MangaSort = (typeof MANGA_SORTS)[number];

/** MangaDex's results a search looks at a time, keeping only those that can be read here. */
export const MANGA_PAGE = 10;
/** The furthest into MangaDex's results a search can ask, as it stops at 10,000. */
export const MANGA_LAST_OFFSET = 9_900;

export const MangaSearchQuery = z.object({
  q: z.string().trim().max(200).optional(),
  /** Only series with chapters in this language; any language when left out. */
  lang: MangaLang.optional(),
  /** relevance when there's a search, popular when there isn't. */
  sort: z.enum(MANGA_SORTS).optional(),
  /** 18+ series too (erotica and pornographic). The loli and shota tags stay out whatever this says. */
  adult: Flag.optional(),
  /** Doujinshi too (fan-made works, MangaDex's Doujinshi format tag), which stay out unless asked. */
  doujinshi: Flag.optional(),
  offset: z.coerce.number().int().min(0).max(MANGA_LAST_OFFSET).default(0),
});
export type MangaSearchQuery = z.input<typeof MangaSearchQuery>;

export const MangaSeriesQuery = z.object({ adult: Flag.optional() });
export const MangaChaptersQuery = z.object({ lang: MangaLang.default('en') });
/** Data saver: MangaDex's smaller, more compressed copy of each page. */
export const MangaPageQuery = z.object({ saver: Flag.optional() });
export const MangaCoverQuery = z.object({ size: z.enum(['256', '512']).default('512') });

export type MangaRating = 'safe' | 'suggestive' | 'erotica' | 'pornographic';
export const ADULT_RATINGS: MangaRating[] = ['erotica', 'pornographic'];

export interface MangaState {
  /** MangaDex is on, on this server. */
  on: boolean;
}

/** A series as a search lists it. */
export interface MangaCard {
  id: string;
  title: string;
  /** Its cover's file at MangaDex, for /v1/manga/cover/:id/:file. */
  cover: string | null;
  rating: MangaRating;
  status: 'ongoing' | 'completed' | 'hiatus' | 'cancelled' | null;
  year: number | null;
  /** The languages its chapters are in. */
  langs: string[];
  /** The language it was first published in. */
  original: string;
  authors: string[];
  /** The language a search found every chapter of it readable in here, which its sheet opens in. */
  readIn?: string;
}

export interface MangaLink {
  /** official: read it where its publisher puts it. store: buy it. info: what trackers say about it. */
  kind: 'official' | 'store' | 'info';
  label: string;
  url: string;
}

export interface MangaSeries extends MangaCard {
  /** Its other names, in other languages and scripts. */
  altTitles: string[];
  /** In English when there's one, as plain text. */
  description: string;
  tags: Array<{ name: string; group: 'genre' | 'theme' | 'format' | 'content' }>;
  demographic: 'shounen' | 'shoujo' | 'josei' | 'seinen' | null;
  artists: string[];
  links: MangaLink[];
  /** Its page on MangaDex, which is credited wherever it's read. */
  page: string;
}

export interface MangaGroup {
  id: string;
  name: string;
}

/** One upload of a chapter, in one language, by one group (or a few together). */
export interface MangaChapter {
  id: string;
  /** Its number as MangaDex writes it ("12", "12.5"), or null for a oneshot. */
  chapter: string | null;
  volume: string | null;
  title: string | null;
  pages: number;
  /** Read on its publisher's own site (MANGA Plus and the like), so there are no pages here. */
  external: string | null;
  groups: MangaGroup[];
  /** When it went up, in ms. */
  at: number;
}

/**
 * Only series every chapter of can be read here (an ongoing one may lack its newest two), so a lot
 * can hold fewer than it looked at. next is the offset to ask for after it, or null at the end.
 */
export interface MangaSearchResult {
  total: number;
  offset: number;
  next: number | null;
  items: MangaCard[];
}

export interface MangaChapters {
  lang: string;
  chapters: MangaChapter[];
}
