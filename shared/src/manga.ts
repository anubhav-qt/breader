/*
 * Manga through the laptop (server routes/manga.ts): one search across every place it looks
 * (MangaDex and the sources of Breader's Suwayomi server), each series' chapters, and each
 * chapter's pages as pictures. Their own shapes are the server's business; these are what
 * it answers. Scanlation groups made the chapters, so they're credited wherever a chapter is read,
 * and a MangaDex series' official releases are linked from it.
 */

export const MANGA_SORTS = ['relevance', 'popular', 'latest', 'new', 'rated'] as const;
export type MangaSort = (typeof MANGA_SORTS)[number];

/**
 * Where a series is from, as a reader tells them apart: manga (Japan), manhwa (Korea, mostly
 * webtoons), manhua (China) and comics (everywhere else).
 */
export const MANGA_KINDS = ['manga', 'manhwa', 'manhua', 'comics'] as const;
export type MangaKind = (typeof MANGA_KINDS)[number];

/** Results a search looks at a time in each place, keeping only those that can be read here. */
export const MANGA_PAGE = 10;
/** The furthest into MangaDex's results a search can ask, as it stops at 10,000. */
export const MANGA_LAST_OFFSET = 9_900;

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
  /** sw:<source>:<address> (SourceId). */
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
  /**
   * The main titles of its names that have a subtitle, keyed: "Frieren" of "Frieren: Beyond
   * Journey's End". A series going by one of these is the same only if its people are too (sameNames).
   */
  stems: string[];
  /** Who made it, as personKey keys them, when the place says. */
  people: string[];
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

/** Where a name's subtitle starts: "Frieren: Beyond…", "Frieren - Beyond…", "Frieren (Beyond…)". */
const SUBTITLE = /\s*:\s*|\s+[-–—~]\s+|\s*[([]/;
/** A main title this short ("Ao", "One") names too many series to go by. */
const SHORT_STEM = 4;

/**
 * A person's name as every site spells it: its words in lower case, without accents, in any order
 * (Yamada Kanehito, Kanehito YAMADA).
 */
export function personKey(name: string): string {
  const parts = name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!parts) return '';
  return parts.sort().join(' ');
}

/** Every name a series goes by, keyed, and who made it; its edition as its first name says. */
export function namesOf(titles: string[], people: string[] = []): SeriesNames {
  const keys: string[] = [];
  const stems: string[] = [];
  for (const t of titles) {
    const { key } = seriesName(t);
    if (key && !keys.includes(key)) keys.push(key);
    const cut = SUBTITLE.exec(t);
    if (!cut || cut.index === 0) continue;
    const stem = seriesName(t.slice(0, cut.index)).key;
    if (stem.length >= SHORT_STEM && stem !== key && !stems.includes(stem)) stems.push(stem);
  }
  const who: string[] = [];
  for (const p of people) {
    const k = personKey(p);
    if (k && !who.includes(k)) who.push(k);
  }
  let edition: string | null = null;
  if (titles.length > 0) edition = seriesName(titles[0]).edition;
  return { keys, stems: stems.filter((x) => !keys.includes(x)), people: who, edition };
}

/**
 * Whether two places' series go by the same name: one of their names, or one's whole name the
 * other's main title ("Frieren", "Frieren: Beyond Journey's End") when someone made both. Without
 * that, "Attack on Titan" would be "Attack on Titan: Before the Fall" too.
 */
export function sameNames(a: SeriesNames, b: SeriesNames): boolean {
  if (a.keys.some((k) => b.keys.includes(k))) return true;
  if (!(a.people ?? []).some((p) => (b.people ?? []).includes(p))) return false;
  return (a.stems ?? []).some((s) => b.keys.includes(s)) || (b.stems ?? []).some((s) => a.keys.includes(s));
}

/** Whether this is the same series as those found: the same name, side works with side works, no clash of kinds. One card in Browse. */
export function sameSeries(found: MangaFound[], f: MangaFound): boolean {
  if (found.length === 0) return false;
  if (found[0].card.side !== f.card.side) return false;
  for (const x of found) {
    if (!sameKind(x.card.kind, f.card.kind)) return false;
  }
  return found.some((x) => sameNames(x, f));
}

/** The most names a search for a series' other copies takes (MangaSearchQuery names). */
export const MOST_NAMES = 40;

/** Every name a series goes by where it was found, main titles too, for a search for its other copies. */
export function namesIn(found: MangaFound[]): string[] {
  const out: string[] = [];
  for (const f of found) {
    for (const k of [...f.keys, ...(f.stems ?? [])]) {
      if (k.length === 0 || k.length > 200) continue;
      if (!out.includes(k)) out.push(k);
    }
  }
  return out.slice(0, MOST_NAMES);
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

/**
 * A streamed search's events: what's found so far, each time a place brings something, then the
 * whole lot, as a plain search answers it; or what went wrong.
 */
export type MangaSearchEvent =
  | { kind: 'some'; items: MangaFound[] }
  | { kind: 'lot'; items: MangaFound[]; next: string | null }
  | { kind: 'error'; status: number; code: string; message: string };

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

/*
 * A series' chapters as Read lays them out (frontend books/remote.ts), here so the laptop keeping a
 * library's manga on its disk ahead of its readers (server manga/keeper.ts) keeps the very uploads
 * the app will open.
 */

/** Its number: 12, 12.5; null for a oneshot or an extra. */
export function numberOf(c: { chapter: string | null }): number | null {
  const n = parseFloat(c.chapter ?? '');
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const keyOf = (c: MangaChapter) => {
  const n = numberOf(c);
  return n !== null ? `n${n}` : `x${(c.title ?? '').trim().toLowerCase() || 'oneshot'}`;
};

/** By number, extras after, each as it came. */
const ofSort = (a: MangaChapter, b: MangaChapter) => {
  const x = numberOf(a);
  const y = numberOf(b);
  if (x !== null && y !== null) return x - y || a.at - b.at;
  return x !== null ? -1 : y !== null ? 1 : a.at - b.at;
};

/**
 * One upload of each chapter, in order. Of several, one that can be read here before one read on
 * its publisher's site; then the one by the group picked (the copy it's read in), where it has
 * one; then the one by the group that made the most of the series, so names and style carry on
 * from chapter to chapter; then the newest.
 */
export function pickChapters(all: MangaChapter[], prefer: string | null = null): MangaChapter[] {
  const made = new Map<string, Set<string>>();
  for (const c of all) for (const g of c.groups) {
    if (!made.has(g.id)) made.set(g.id, new Set());
    made.get(g.id)!.add(keyOf(c));
  }
  const weight = (c: MangaChapter) => Math.max(0, ...c.groups.map((g) => made.get(g.id)?.size ?? 0));
  const preferred = (c: MangaChapter) => Number(c.groups.some((g) => g.id === prefer));
  const better = (a: MangaChapter, b: MangaChapter) =>
    Number(!a.external) - Number(!b.external) || preferred(a) - preferred(b) || weight(a) - weight(b) || a.at - b.at;
  const best = new Map<string, MangaChapter>();
  for (const c of all) {
    const k = keyOf(c);
    const had = best.get(k);
    if (!had || better(c, had) > 0) best.set(k, c);
  }
  // Extras after the numbered chapters, as they came.
  return [...best.values()].sort(ofSort);
}

/** A copy filling in, its chapters picked one of each (pickChapters), and the site it's on, to credit with them. */
export interface Fill {
  site: string;
  chapters: MangaChapter[];
}

/**
 * A copy's chapters, picked one of each, with those it hasn't got (or only links to on its
 * publisher's site) from the next copies in turn, credited with the groups that made them, as
 * Breader's own: which site it came from isn't said. Only numbered
 * chapters fill in: extras go by their names, which sites write differently.
 */
export function filledIn(own: MangaChapter[], fills: Fill[]): MangaChapter[] {
  if (!fills.length) return own;
  const at = new Map<string, MangaChapter>();
  for (const c of own) at.set(keyOf(c), c);
  let added = false;
  for (const f of fills) {
    for (const c of f.chapters) {
      if (numberOf(c) === null || c.external) continue;
      const k = keyOf(c);
      const had = at.get(k);
      if (had && !had.external) continue;
      at.set(k, c);
      added = true;
    }
  }
  if (!added) return own;
  return [...at.values()].sort(ofSort);
}

/** A remote manga's place is kept by its chapter's number and its page in it: block = (number × 100 + 1) × PLACE_PER + page. */
export const PLACE_PER = 1000;
export const placeKey = (n: number) => Math.round(n * 100);

/** The number of the chapter a place is in, or null when it names none. It's the same on every site. */
export function placeChapter(pos: { block: number } | undefined | null): number | null {
  if (!pos || pos.block < PLACE_PER) return null;
  return (Math.floor(pos.block / PLACE_PER) - 1) / 100;
}

/*
 * AniList (graphql.anilist.co), through the laptop: Browse's Popular, Trending and Top rated lists,
 * and what a series' page says came before and after it and what's like it. AniList knows series,
 * not where to read them, so a card from it is opened by looking for its names in the places a
 * search looks (the app's found.ts).
 */

/** Browse's lists AniList makes. */
export const ANILIST_SORTS = ['popular', 'trending', 'rated'] as const;
export type AniListSort = (typeof ANILIST_SORTS)[number];

/** The most series one ask may say where they're read (AniListKeptQuery): two of a list's pages. */
export const MOST_KEPT = 60;
/** Each series the server knows where it's read, by its AniList id; one it doesn't is left out, to be asked alone. */
export interface AniListKept {
  found: Record<string, MangaFound[]>;
}

/** A series as AniList has it. */
export interface AniCard {
  id: number;
  /** Its English title, or its romaji one. */
  title: string;
  /** Every name it goes by: romaji, English, native and the rest, to look for it with. */
  names: string[];
  /** Its cover is at /v1/manga/anilist/cover/:id. */
  cover: boolean;
  kind: MangaKind | null;
  /** AniList's format, as words: Manga, One shot, Novel. */
  format: string;
  status: MangaCard['status'];
  year: number | null;
  adult: boolean;
}

/** How a related series is related, from the series' side: its prequel, its sequel. */
export type AniRelation = 'prequel' | 'sequel' | 'parent' | 'side_story' | 'spin_off' | 'alternative' | 'character' | 'summary' | 'other';

export interface AniRelated extends AniCard {
  relation: AniRelation;
}

export interface AniListPage {
  items: AniCard[];
  /** The next page, or null at the end. */
  next: number | null;
}

/** What AniList says of one series: what's before and after it and beside it, and what's like it. */
export interface AniListAbout extends AniCard {
  related: AniRelated[];
  similar: AniCard[];
}
