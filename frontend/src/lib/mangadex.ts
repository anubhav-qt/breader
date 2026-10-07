import type { MangaChapters, MangaSearchResult, MangaSeries, MangaSort, MangaState, SourceSeries } from '@breader/shared/manga';
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
  /** Doujinshi and anthologies too, which stay out unless asked for. */
  doujinshi?: boolean;
  /** Where the search carries on, as the last answer said. */
  next?: string;
}

const query = (q: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const mangadex = {
  state: () => ask(() => api.laptop.get<MangaState>('/v1/manga')),
  search: (s: MangaSearch) =>
    ask(() => api.laptop.get<MangaSearchResult>(`/v1/manga/search${query({ q: s.q?.trim(), lang: s.lang, sort: s.sort, adult: s.adult ? 1 : undefined, doujinshi: s.doujinshi ? 1 : undefined, next: s.next })}`, 20_000)),
  series: (id: string, adult: boolean) => ask(() => api.laptop.get<MangaSeries>(`/v1/manga/series/${id}${adult ? '?adult=1' : ''}`, 20_000)),
  /** Every chapter in a language. A long series is several calls to MangaDex, so it can take a while. */
  chapters: (id: string, lang: string) => ask(() => api.laptop.get<MangaChapters>(`/v1/manga/series/${id}/chapters?lang=${lang}`, 60_000)),
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
 * How this device looks for manga: in what language and order, whether 18+ series and doujinshi
 * (and anthologies) show, and data saver.
 */
export interface MangaPrefs {
  lang: string;
  adult: boolean;
  /** Doujinshi (fan-made works) and anthologies show in the results too. */
  doujinshi: boolean;
  sort: MangaSort;
  saver: boolean;
}

const PREFS = 'breader.mangadex.v1';
const DEFAULTS: MangaPrefs = { lang: 'en', adult: false, doujinshi: false, sort: 'popular', saver: false };

export const readMangaPrefs = (): MangaPrefs => ({ ...DEFAULTS, ...readLocal<Partial<MangaPrefs>>(PREFS, {}) });
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
