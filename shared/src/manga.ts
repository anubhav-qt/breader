import { z } from 'zod';

/*
 * Manga through the laptop (server routes/manga.ts): one search across every place it looks
 * (MangaDex and the sources of Breader's Suwayomi server), each series' chapters, and each
 * chapter's pages as pictures. Their own shapes are the server's business; these are what
 * it answers. Scanlation groups made the chapters, so they're credited wherever a chapter is read,
 * and a MangaDex series' official releases are linked from it.
 */

/** MangaDex's ids are UUIDs. */
export const MangaId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'Not a MangaDex id');
/** A language as MangaDex names them: en, ja, pt-br, es-la. */
export const MangaLang = z.string().regex(/^[a-z]{2,3}(-[a-z]{2,3})?$/, 'Not a language');
const Flag = z.enum(['0', '1']).transform((v) => v === '1');

export const MANGA_SORTS = ['relevance', 'popular', 'latest', 'new', 'rated'] as const;
export type MangaSort = (typeof MANGA_SORTS)[number];

/** Results a search looks at a time in each place, keeping only those that can be read here. */
export const MANGA_PAGE = 10;
/** The furthest into MangaDex's results a search can ask, as it stops at 10,000. */
export const MANGA_LAST_OFFSET = 9_900;

/** A series on Breader's Suwayomi (sw:12), or one of its chapters. */
export const SourceId = z.string().regex(/^sw:[1-9]\d{0,9}$/, 'Not a series or chapter of a source');
/**
 * Where a search carries on, place by place: md:30 (MangaDex's offset), sw<source>:3.10 (a
 * Suwayomi source's page, and how many of it were looked at). A place left out has nothing more.
 */
const Next = z.string().regex(/^[a-z]{2}\d{0,20}:\d{1,6}(\.\d{1,4})?(,[a-z]{2}\d{0,20}:\d{1,6}(\.\d{1,4})?){0,49}$/, 'Not where a search carries on');

export const MangaSearchQuery = z.object({
  q: z.string().trim().max(200).optional(),
  /** Only series with chapters in this language; any language when left out. */
  lang: MangaLang.optional(),
  /** relevance when there's a search, popular when there isn't. */
  sort: z.enum(MANGA_SORTS).optional(),
  /** 18+ series too (erotica and pornographic). The loli and shota tags stay out whatever this says. */
  adult: Flag.optional(),
  /** Doujinshi (fan-made works) and anthologies too, which stay out unless asked. */
  doujinshi: Flag.optional(),
  /** Where the last lot said to carry on from; the first lot without it. */
  next: Next.optional(),
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
  /** A doujinshi or an anthology, which a search shows only when asked, after the rest. */
  side: boolean;
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

/** A series on one of Breader's Suwayomi sources, as a search lists it. */
export interface SourceCard {
  /** sw:12. */
  id: string;
  title: string;
  /** Its cover through the laptop (/v1/manga/source/:id/cover), or null when it has none. */
  cover: string | null;
  status: MangaCard['status'];
  /** From a source for adults, or for adults by its genres. */
  adult: boolean;
  /** A doujinshi or an anthology, by its genres. */
  side: boolean;
}

export interface SourceSeries extends SourceCard {
  /** Where it's from: the source's name (Asura Scans). */
  source: string;
  authors: string[];
  description: string;
  genres: string[];
  /** Its page on its source's own site, when there's one. */
  link: string | null;
}

/**
 * A series a search found, and where: the same series found in two places is two of these, each
 * naming its own. source is the place's name, shown under the title.
 */
export type MangaFound = { kind: 'mangadex'; source: string; card: MangaCard } | { kind: 'source'; source: string; card: SourceCard };

/**
 * A lot from every place at once, the real series first. Only series every chapter of can be read
 * here (an ongoing one may lack its newest two), so a lot can hold fewer than it looked at, or
 * none. next says where to carry on, or null once every place is done.
 */
export interface MangaSearchResult {
  items: MangaFound[];
  next: string | null;
}

export interface MangaChapters {
  lang: string;
  chapters: MangaChapter[];
}
