import { MANGA_KINDS, type MangaChapters, type MangaCopies, type MangaFound, type MangaKind, type MangaSearchEvent, type MangaSearchResult, type MangaSeries, type MangaSort, type MangaState, type SourceSeries } from '@breader/shared/manga';
import { api, ApiError, laptopUrl } from './api';
import { readLocal, writeLocal } from './store';

/*
 * Manga, through Breader's own computer (server routes/manga.ts): MangaDex lets only its own site
 * fetch its pages in a browser, and Breader's Suwayomi isn't open to readers. The laptop alone has
 * them, so it's asked and nothing else.
 */

const OFF = 'Manga comes through Breader’s own computer, which can’t be reached just now. Chapters kept offline still open.';

async function ask<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError && e.code === 'laptop_off') throw new ApiError(503, 'laptop_off', OFF);
    throw e;
  }
}

export interface MangaSearch {
  q?: string;
  lang?: string;
  sort?: MangaSort;
  adult?: boolean;
  /** 18+ series and nothing else. */
  adultOnly?: boolean;
  /** Doujinshi and anthologies too, which stay out unless asked for. */
  doujinshi?: boolean;
  /** Only these kinds; every kind when left out. */
  kinds?: MangaKind[];
  /** Only series going by one of these names (seriesName keys): a sheet looking for a series' other copies. */
  names?: string[];
  /** Where the search carries on, as the last answer said. */
  next?: string;
}

/** The kinds as a search asks for them, or nothing when it's every kind. */
function kindsOf(kinds: MangaKind[] | undefined): string | undefined {
  if (!kinds) return undefined;
  if (kinds.length === MANGA_KINDS.length) return undefined;
  return kinds.join(',');
}

const query = (q: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

const searchPath = (s: MangaSearch, stream = false) =>
  `/v1/manga/search${query({ q: s.q?.trim(), lang: s.lang, sort: s.sort, adult: s.adult ? 1 : undefined, adultOnly: s.adultOnly ? 1 : undefined, doujinshi: s.doujinshi ? 1 : undefined, kinds: kindsOf(s.kinds), names: s.names?.join(','), next: s.next, stream: stream ? 1 : undefined })}`;

/** A streamed search's events, as the server sends them (routes/manga.ts). */
async function* eventsOf(res: Response): AsyncGenerator<MangaSearchEvent> {
  const reader = res.body!.getReader();
  const text = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += text.decode(value, { stream: true });
    for (let end = buf.indexOf('\n\n'); end >= 0; end = buf.indexOf('\n\n')) {
      const event = buf.slice(0, end);
      buf = buf.slice(end + 2);
      const data = event.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
      if (data) yield JSON.parse(data) as MangaSearchEvent;
    }
  }
}

export const mangadex = {
  state: () => ask(() => api.laptop.get<MangaState>('/v1/manga')),
  search: (s: MangaSearch) => ask(() => api.laptop.get<MangaSearchResult>(searchPath(s), 20_000)),
  /** The same lot, with what's found so far given to onSome each time a place brings something. */
  async searchAsItComes(s: MangaSearch, onSome: (items: MangaFound[]) => void): Promise<MangaSearchResult> {
    const res = await ask(() => api.laptop.raw(searchPath(s, true), undefined, 20_000));
    // A server from before streaming answers with the whole lot at once.
    if (!res.body || !res.headers.get('content-type')?.includes('text/event-stream')) return res.json() as Promise<MangaSearchResult>;
    for await (const e of eventsOf(res)) {
      if (e.kind === 'some') onSome(e.items);
      else if (e.kind === 'lot') return { items: e.items, next: e.next };
      else throw new ApiError(e.status, e.code, e.message);
    }
    throw new ApiError(503, 'manga_cut', 'The search was cut off. Try again.');
  },
  series: (id: string, adult: boolean) => ask(() => api.laptop.get<MangaSeries>(`/v1/manga/series/${id}${adult ? '?adult=1' : ''}`, 20_000)),
  /** Every chapter in a language. A long series is several calls to MangaDex, so it can take a while. */
  chapters: (id: string, lang: string) => ask(() => api.laptop.get<MangaChapters>(`/v1/manga/series/${id}/chapters?lang=${lang}`, 60_000)),
  /** Its copies in a language, each group's pages measured: a few pages fetched the first time. */
  copies: (id: string, lang: string) => ask(() => api.laptop.get<MangaCopies>(`/v1/manga/series/${id}/copies?lang=${lang}`, 90_000)),
  /** A page's picture; the data saver's copy is smaller. */
  page: async (chapterId: string, n: number, saver: boolean) =>
    (await ask(() => api.laptop.raw(`/v1/manga/chapter/${chapterId}/${n}${saver ? '?saver=1' : ''}`, undefined, 45_000))).blob(),
  coverUrl: (id: string, file: string, size: 256 | 512) => laptopUrl(`/v1/manga/cover/${id}/${encodeURIComponent(file)}?size=${size}`),
  async cover(id: string, file: string, size: 256 | 512): Promise<Blob | undefined> {
    try {
      const res = await fetch(mangadex.coverUrl(id, file, size));
      return res.ok ? await res.blob() : undefined;
    } catch {
      return undefined;
    }
  },
};

/**
 * A series on Breader's Suwayomi, by its id there (sw:44), and its chapters (ids like that too) and
 * its pages.
 */
export const sources = {
  series: (id: string, adult: boolean) => ask(() => api.laptop.get<SourceSeries>(`/v1/manga/source/${id}${adult ? '?adult=1' : ''}`, 20_000)),
  /** Every chapter. Suwayomi asks its source for them, so it can take a while. */
  chapters: (id: string) => ask(() => api.laptop.get<MangaChapters>(`/v1/manga/source/${id}/chapters`, 60_000)),
  /** Its copies, each group's pages measured: a few pages fetched the first time. */
  copies: (id: string) => ask(() => api.laptop.get<MangaCopies>(`/v1/manga/source/${id}/copies`, 90_000)),
  /** How many pages a chapter has. Suwayomi learns it from its source, a chapter at a time. */
  async pages(chapterId: string): Promise<number> {
    const r = await ask(() => api.laptop.get<{ pages: number }>(`/v1/manga/source/chapter/${chapterId}`, 45_000));
    return r.pages;
  },
  /** Page n of a chapter (from 0), as a picture. */
  async page(chapterId: string, n: number): Promise<Blob> {
    const res = await ask(() => api.laptop.raw(`/v1/manga/source/chapter/${chapterId}/${n}`, undefined, 45_000));
    return res.blob();
  },
  /** A cover's address on the laptop, from its path in a card (/v1/manga/source/sw:44/cover). */
  coverUrl: (path: string) => laptopUrl(path),
  async cover(path: string): Promise<Blob | undefined> {
    try {
      const res = await fetch(sources.coverUrl(path));
      if (!res.ok) return undefined;
      return await res.blob();
    } catch {
      return undefined;
    }
  },
};

/**
 * How this device looks for manga: in what language and order, which kinds, whether 18+ series (or
 * only they) and doujinshi (and anthologies) show, and data saver.
 */
export interface MangaPrefs {
  lang: string;
  adult: boolean;
  /** With 18+ on, those series alone, not mixed in with the rest. */
  adultOnly: boolean;
  /** Doujinshi (fan-made works) and anthologies show in the results too. */
  doujinshi: boolean;
  /** At least one, in MANGA_KINDS' order. */
  kinds: MangaKind[];
  sort: MangaSort;
  saver: boolean;
}

const PREFS = 'breader.mangadex.v1';
const DEFAULTS: MangaPrefs = { lang: 'en', adult: false, adultOnly: false, doujinshi: false, kinds: [...MANGA_KINDS], sort: 'popular', saver: false };

export function readMangaPrefs(): MangaPrefs {
  const prefs = { ...DEFAULTS, ...readLocal<Partial<MangaPrefs>>(PREFS, {}) };
  // Kept before there were kinds, or by hand: only real ones, and every one when none is left.
  let kinds: MangaKind[] = [];
  if (Array.isArray(prefs.kinds)) kinds = MANGA_KINDS.filter((k) => prefs.kinds.includes(k));
  if (kinds.length === 0) kinds = [...MANGA_KINDS];
  // New is gone from Browse: kept on it, Browse opens on Updated, which lists the same series.
  let sort = prefs.sort;
  if (sort === 'new') sort = 'latest';
  return { ...prefs, kinds, sort, adultOnly: prefs.adult && !!prefs.adultOnly };
}
export const writeMangaPrefs = (p: MangaPrefs) => writeLocal(PREFS, p);

/** Languages by name, as MangaDex has them. */
const NAMES: Record<string, string> = {
  en: 'English',
  ja: 'Japanese',
  'ja-ro': 'Japanese (romaji)',
  ko: 'Korean',
  'ko-ro': 'Korean (romaji)',
  zh: 'Chinese',
  'zh-hk': 'Chinese (Hong Kong)',
  'zh-ro': 'Chinese (romaji)',
  es: 'Spanish',
  'es-la': 'Spanish (Latin America)',
  pt: 'Portuguese',
  'pt-br': 'Portuguese (Brazil)',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  ru: 'Russian',
  uk: 'Ukrainian',
  pl: 'Polish',
  tr: 'Turkish',
  ar: 'Arabic',
  fa: 'Persian',
  he: 'Hebrew',
  hi: 'Hindi',
  bn: 'Bengali',
  ta: 'Tamil',
  th: 'Thai',
  vi: 'Vietnamese',
  id: 'Indonesian',
  ms: 'Malay',
  tl: 'Filipino',
  my: 'Burmese',
  mn: 'Mongolian',
  kk: 'Kazakh',
  nl: 'Dutch',
  sv: 'Swedish',
  da: 'Danish',
  no: 'Norwegian',
  fi: 'Finnish',
  cs: 'Czech',
  sk: 'Slovak',
  hu: 'Hungarian',
  ro: 'Romanian',
  bg: 'Bulgarian',
  sr: 'Serbian',
  hr: 'Croatian',
  lt: 'Lithuanian',
  lv: 'Latvian',
  et: 'Estonian',
  el: 'Greek',
  ca: 'Catalan',
  eo: 'Esperanto',
  la: 'Latin',
  ne: 'Nepali',
  az: 'Azerbaijani',
  ka: 'Georgian',
  be: 'Belarusian',
};

export const langName = (code: string) => NAMES[code] ?? code.toUpperCase();
/** Every language a search can ask for, English first. */
export const LANGS = Object.keys(NAMES).filter((l) => !l.endsWith('-ro'));

/** Languages in the order to offer them: English, this device's own, then by name. */
export function byLang(langs: string[], own = 'en'): string[] {
  const rank = (l: string) => (l === 'en' ? 0 : l === own ? 1 : 2);
  return [...new Set(langs)].sort((a, b) => rank(a) - rank(b) || langName(a).localeCompare(langName(b)));
}

/** MangaDex's genre tags as Breader's genres, for a series added to My manga. */
const GENRE_OF: Record<string, string> = {
  fantasy: 'fantasy',
  'sci-fi': 'scifi',
  mystery: 'mystery',
  crime: 'crime',
  thriller: 'thriller',
  horror: 'horror',
  romance: 'romance',
  historical: 'historical',
  adventure: 'adventure',
  comedy: 'humour',
  philosophical: 'philosophy',
};
export const genreOf = (tags: Array<{ name: string }>) =>
  [...new Set(tags.map((t) => GENRE_OF[t.name.toLowerCase()]).filter(Boolean))].join(',');

export const STATUS_NAME: Record<string, string> = { ongoing: 'Ongoing', completed: 'Completed', hiatus: 'On hiatus', cancelled: 'Cancelled' };
export const RATING_NAME: Record<string, string> = { safe: 'All ages', suggestive: 'Suggestive', erotica: '18+', pornographic: '18+ explicit' };
/** One series' kind, under its title. */
export const KIND_NAME: Record<MangaKind, string> = { manga: 'Manga', manhwa: 'Manhwa', manhua: 'Manhua', comics: 'Comic' };
