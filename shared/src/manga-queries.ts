import { z } from 'zod';
import { ANILIST_SORTS, MANGA_SORTS, MOST_KEPT, type MangaKind } from './manga.ts';

/*
 * What the manga routes (server routes/manga.ts) take, checked. Apart from manga.ts so the app,
 * which only reads the answers, loads none of zod.
 */

/** MangaDex's ids are UUIDs. */
export const MangaId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'Not a MangaDex id');
/** A language as MangaDex names them: en, ja, pt-br, es-la. */
export const MangaLang = z.string().regex(/^[a-z]{2,3}(-[a-z]{2,3})?$/, 'Not a language');
const Flag = z.enum(['0', '1']).transform((v) => v === '1');

/** Some kinds, as a search asks for them: manga,manhwa. */
const Kinds = z
  .string()
  .regex(/^(manga|manhwa|manhua|comics)(,(manga|manhwa|manhua|comics)){0,3}$/, 'Not kinds of series')
  .transform((v) => [...new Set(v.split(','))] as MangaKind[]);

/**
 * A series on one of Breader's Suwayomi sources, by the source and its address on the site, the
 * same on every Suwayomi: sw:<source>:<address>, the address in base64url so it's safe in a path.
 * One of its chapters adds its own address after another colon.
 */
export const SourceId = z.string().regex(/^sw:\d{1,20}:[\w-]{1,400}(:[\w-]{1,400})?$/, 'Not a series or chapter of a source');
/**
 * Where a search carries on, place by place: md:30 (MangaDex's offset), sw<source>:3.10 (a
 * Suwayomi source's page, and how many of it were looked at), sw<source>:s40 (past the first 40 on
 * its shelf). A place left out has nothing more.
 */
const Next = z.string().regex(/^[a-z]{2}\d{0,20}:(s\d{1,6}|\d{1,6}(\.\d{1,4})?)(,[a-z]{2}\d{0,20}:(s\d{1,6}|\d{1,6}(\.\d{1,4})?)){0,49}$/, 'Not where a search carries on');

/** Series names as seriesName keys them, or a group's key (server manga/same.ts), comma separated. */
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
  /** 18+ series and nothing else: adult, without the rest. */
  adultOnly: Flag.optional(),
  /** Doujinshi (fan-made works) and anthologies too, which stay out unless asked. */
  doujinshi: Flag.optional(),
  /** Only these kinds; every kind when left out. A series of no known kind shows only then. */
  kinds: Kinds.optional(),
  /** Only series going by one of these names: a series' sheet, looking for its other copies with its title. */
  names: Names.optional(),
  /** Each place's series as they come, as server-sent events (MangaSearchEvent), before the whole lot. */
  stream: Flag.optional(),
  /** Where the last lot said to carry on from; the first lot without it. */
  next: Next.optional(),
});
export type MangaSearchQuery = z.input<typeof MangaSearchQuery>;

export const MangaSeriesQuery = z.object({ adult: Flag.optional() });
export const MangaChaptersQuery = z.object({ lang: MangaLang.default('en') });
/** Data saver: MangaDex's smaller, more compressed copy of each page. */
export const MangaPageQuery = z.object({ saver: Flag.optional() });
export const MangaCoverQuery = z.object({ size: z.enum(['256', '512']).default('512') });

/** AniList's ids are numbers. */
export const AniListId = z.string().regex(/^\d{1,9}$/, 'Not an AniList id').transform(Number);

export const AniListQuery = z.object({
  sort: z.enum(ANILIST_SORTS).default('popular'),
  page: z.coerce.number().int().min(1).max(100).default(1),
  adult: Flag.optional(),
  adultOnly: Flag.optional(),
  kinds: Kinds.optional(),
});
export type AniListQuery = z.input<typeof AniListQuery>;

/** AniList's best matches for a search typed in Browse, which takes spaces and spelling loosely ("full metal alchemist"). */
export const AniListSearchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  adult: Flag.optional(),
  adultOnly: Flag.optional(),
  kinds: Kinds.optional(),
});
export type AniListSearchQuery = z.input<typeof AniListSearchQuery>;

export const AniListAboutQuery = z.object({ adult: Flag.optional() });
/** A series looked up on AniList by its title, when nothing gave its AniList id. */
export const AniListFindQuery = z.object({ title: z.string().trim().min(1).max(200), adult: Flag.optional() });
/** Where a series AniList knows can be read: in this language (any, left out), 18+ copies too or not. */
export const AniListFoundQuery = z.object({ lang: MangaLang.optional(), adult: Flag.optional() });

/** Where some series are read, as far as the server already knows, by their AniList ids: 1,2,3. */
export const AniListKeptQuery = AniListFoundQuery.extend({
  ids: z
    .string()
    .regex(/^\d{1,9}(,\d{1,9})*$/, 'Not AniList ids')
    .transform((v) => [...new Set(v.split(',').map(Number))])
    .refine((ids) => ids.length <= MOST_KEPT, `At most ${MOST_KEPT} at once`),
});
export type AniListKeptQuery = z.input<typeof AniListKeptQuery>;
