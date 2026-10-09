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

/**
 * Where a series is from, as a reader tells them apart: manga (Japan), manhwa (Korea, mostly
 * webtoons), manhua (China) and comics (everywhere else).
 */
export const MANGA_KINDS = ['manga', 'manhwa', 'manhua', 'comics'] as const;
export type MangaKind = (typeof MANGA_KINDS)[number];
/** Some kinds, as a search asks for them: manga,manhwa. */
const Kinds = z
  .string()
  .regex(/^(manga|manhwa|manhua|comics)(,(manga|manhwa|manhua|comics)){0,3}$/, 'Not kinds of series')
  .transform((v) => [...new Set(v.split(','))] as MangaKind[]);

/** Results a search looks at a time in each place, keeping only those that can be read here. */
export const MANGA_PAGE = 10;
/** The furthest into MangaDex's results a search can ask, as it stops at 10,000. */
export const MANGA_LAST_OFFSET = 9_900;

/** A series on Breader's Suwayomi (sw:12), or one of its chapters. */
export const SourceId = z.string().regex(/^sw:[1-9]\d{0,9}$/, 'Not a series or chapter of a source');
/**
 * Where a search carries on, place by place: md:30 (MangaDex's offset), sw<source>:3.10 (a
 * Suwayomi source's page, and how many of it were looked at), sw<source>:s40 (past the first 40 on
 * its shelf). A place left out has nothing more.
 */
const Next = z.string().regex(/^[a-z]{2}\d{0,20}:(s\d{1,6}|\d{1,6}(\.\d{1,4})?)(,[a-z]{2}\d{0,20}:(s\d{1,6}|\d{1,6}(\.\d{1,4})?)){0,49}$/, 'Not where a search carries on');

/** Series names as seriesName keys them, comma separated. */
const Names = z
  .string()
  .max(4000)
  .regex(/^[\p{L}\p{N}]{1,200}(,[\p{L}\p{N}]{1,200}){0,39}$/u, 'Not series names')
  .transform((v) => [...new Set(v.split(','))]);

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
  /** Only these kinds; every kind when left out. A series of no known kind shows only then. */
  kinds: Kinds.optional(),
  /** Only series going by one of these names: a series' sheet, looking for its other copies with its title. */
  names: Names.optional(),
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
  /** By the language it was first published in. */
  kind: MangaKind;
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
  /** For adults, by its genres. */
  adult: boolean;
  /** A doujinshi or an anthology, by its genres. */
  side: boolean;
  /** By its genres, or null when they don't say. */
  kind: MangaKind | null;
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

/** A series a place found, and the place's name (source), shown under the title. */
export type MangaFoundIn = { kind: 'mangadex'; source: string; card: MangaCard } | { kind: 'source'; source: string; card: SourceCard };

/** The names a series goes by, as seriesName keys them, to tell it on another site. */
export interface SeriesNames {
  keys: string[];
  /** An edition its title names (Color), or null. */
  edition: string | null;
}

/**
 * A series a search found, and where. The same series found in two places, or twice in one, is
 * two of these, each naming its own place; they share a key, so the app shows them as one.
 */
export type MangaFound = MangaFoundIn & SeriesNames;

/** An edition named at the end of a title: Haikyu!! (Color), One Piece: Digital Colored Comics. */
const EDITION = /[\s([{:.\-\u2013\u2014]*\b(?:official\s+)?(?:digital\s+)?(?:full[\s-]+)?colou?r(?:ed|ized)?(?:\s+edition)?(?:\s+comics?)?\s*[)\]}]?\s*$/i;

/**
 * A series' name as every site spells it: letters and digits only, in lower case, without accents
 * or a leading The, and with the doubled vowels romaji is spelt both ways shortened (Haikyuu and
 * Haikyu, Shounen and Shonen). An edition named at its end isn't part of the name, but said apart.
 */
export function seriesName(title: string): { key: string; edition: string | null } {
  let edition: string | null = null;
  let name = title;
  const named = EDITION.exec(title);
  if (named && named.index > 0) {
    edition = 'Color';
    name = title.slice(0, named.index);
  }
  let bare = name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  bare = bare.replace(/^\s*the\s+/, '');
  const parts = bare.match(/[\p{L}\p{N}]+/gu);
  if (!parts) return { key: '', edition };
  const key = parts.join('').replace(/uu/g, 'u').replace(/ou/g, 'o');
  return { key, edition };
}

/** Two kinds one series could have: the same, or either not known. */
export function sameKind(a: MangaKind | null, b: MangaKind | null): boolean {
  if (a === null || b === null) return true;
  return a === b;
}

/** Every name a series goes by, keyed; its edition as its first name says. */
export function namesOf(titles: string[]): SeriesNames {
  const keys: string[] = [];
  for (const t of titles) {
    const { key } = seriesName(t);
    if (key && !keys.includes(key)) keys.push(key);
  }
  let edition: string | null = null;
  if (titles.length > 0) edition = seriesName(titles[0]).edition;
  return { keys, edition };
}

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

/**
 * One way to read a series in one place: the uploads of one group that made most of its chapters,
 * or, when no group did, the series as it comes. Its pages are measured on one of its chapters.
 */
export interface MangaCopy {
  /** Null when no one group made most of it. */
  group: MangaGroup | null;
  /** How many of its chapters this copy has. */
  chapters: number;
  /** A page's size in pixels, or null when none could be measured. */
  width: number | null;
  height: number | null;
}

export interface MangaCopies {
  /** How many chapters the series has in this place, so a copy with fewer can say so. */
  chapters: number;
  copies: MangaCopy[];
}
