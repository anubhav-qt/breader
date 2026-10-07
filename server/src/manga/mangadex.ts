import {
  ADULT_RATINGS,
  MANGA_PAGE,
  type MangaCard,
  type MangaChapter,
  type MangaChapters,
  type MangaLink,
  type MangaRating,
  type MangaSearchResult,
  type MangaSeries,
  type MangaSort,
} from '@breader/shared';
import { ApiError } from '../lib/errors.ts';
import { log } from '../log.ts';
import { Disk, pictureType, type Picture } from './disk.ts';
import { Busy, Gate, Memo, Pace } from './pace.ts';

/*
 * MangaDex, as its rules ask (api.mangadex.org/docs): a User-Agent that says who's asking, about
 * five calls a second from one address and forty a minute for a chapter's pages, every page
 * fetched from MangaDex@Home reported back, and its scanlation groups credited (the app shows them
 * with each chapter). Answers are kept a while, pages on disk (disk.ts), so readers ask it little.
 * Series tagged loli or shota are never shown, whatever else is allowed.
 */

export const USER_AGENT = 'Breader/1.0 (+https://breader.site)';
const API = 'https://api.mangadex.org';
const UPLOADS = 'https://uploads.mangadex.org';
const REPORT = 'https://api.mangadex.network/report';

const NEVER_NAMES = new Set(['loli', 'shota']);
const NEVER_IDS = ['2d1f5d56-a1e5-4d0d-a961-2193588b08ec', 'ddefd648-5140-4e5f-ba18-4eca4071d19b'];
/** MangaDex's "Doujinshi" format tag: fan-made works, left out of a search unless it asks for them. */
export const DOUJINSHI_ID = 'b13b2a48-c720-44a9-9c77-39c9979373fb';
const SAFE: MangaRating[] = ['safe', 'suggestive'];
const ALL: MangaRating[] = [...SAFE, ...ADULT_RATINGS];
/** A chapter list comes this many at a time, MangaDex's most. */
const FEED = 500;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const ORDER: Record<MangaSort, string> = {
  relevance: 'relevance',
  popular: 'followedCount',
  latest: 'latestUploadedChapter',
  new: 'createdAt',
  rated: 'rating',
};

interface Rel {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
}
interface RawTag {
  id: string;
  attributes?: { name?: Record<string, string>; group?: string };
}
interface RawManga {
  id: string;
  attributes: {
    title?: Record<string, string>;
    altTitles?: Array<Record<string, string>>;
    description?: Record<string, string>;
    links?: Record<string, string> | null;
    originalLanguage?: string;
    publicationDemographic?: string | null;
    status?: string | null;
    year?: number | null;
    contentRating?: MangaRating;
    tags?: RawTag[];
    availableTranslatedLanguages?: Array<string | null>;
  };
  relationships?: Rel[];
}
interface RawChapter {
  id: string;
  attributes: {
    volume?: string | null;
    chapter?: string | null;
    title?: string | null;
    externalUrl?: string | null;
    publishAt?: string;
    readableAt?: string;
    pages?: number;
    isUnavailable?: boolean;
  };
  relationships?: Rel[];
}
interface AtHome {
  baseUrl: string;
  chapter: { hash: string; data: string[]; dataSaver: string[] };
}

export interface Manga {
  search(q: { q?: string; lang?: string; sort?: MangaSort; adult?: boolean; doujinshi?: boolean; offset: number }): Promise<MangaSearchResult>;
  series(id: string, adult: boolean): Promise<MangaSeries>;
  chapters(id: string, lang: string): Promise<MangaChapters>;
  /** Page n of a chapter (from 0), or its data-saver copy. */
  page(chapterId: string, n: number, saver: boolean): Promise<Picture>;
  cover(mangaId: string, file: string, size: '256' | '512'): Promise<Picture>;
}

export interface MangaOptions {
  dir: string;
  cacheBytes: number;
  fetch?: typeof fetch;
  /** Calls a window: MangaDex's API overall, and its page servers' addresses. Tests go faster. */
  pace?: { api: [number, number]; home: [number, number] };
}

const notFound = () => new ApiError(404, 'manga_not_found', 'MangaDex doesn’t have that, or it’s been taken down.');
const busy = () => new ApiError(503, 'manga_busy', 'MangaDex is busy just now. Try again in a minute.');
const unreachable = () => new ApiError(503, 'manga_unreachable', 'Breader can’t reach MangaDex just now. Try again in a minute.');
const adultOnly = () => new ApiError(403, 'manga_adult', 'This series is for adults. Turn on Show 18+ to see it.');

/** The text in a language, English when there's no such, or whatever there is. */
function pick(text: Record<string, string> | undefined, lang = 'en'): string | undefined {
  if (!text) return undefined;
  return text[lang] || text.en || Object.values(text).find(Boolean);
}

const rels = (x: { relationships?: Rel[] }, type: string) => (x.relationships ?? []).filter((r) => r.type === type);
const names = (x: { relationships?: Rel[] }, type: string) =>
  [...new Set(rels(x, type).map((r) => String(r.attributes?.name ?? '').trim()).filter(Boolean))];

/** Only web links: MangaDex's are typed in by its users. */
function web(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Markdown and BBCode, as MangaDex's descriptions are written, to plain text. */
export function plain(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\/?[a-z*]+(=[^\]]*)?\]/gi, '')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/gm, '$1$2')
    .replace(/^[ \t]*#+[ \t]*/gm, '')
    .replace(/^[ \t]*([-*_][ \t]*){3,}$/gm, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, '’')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 6000);
}

const LINKS: Record<string, { kind: MangaLink['kind']; label: string; url: (v: string) => string }> = {
  engtl: { kind: 'official', label: 'Official English', url: (v) => v },
  raw: { kind: 'official', label: 'Official original', url: (v) => v },
  bw: { kind: 'store', label: 'BookWalker', url: (v) => `https://bookwalker.jp/${v.replace(/^\/+/, '')}` },
  amz: { kind: 'store', label: 'Amazon', url: (v) => v },
  ebj: { kind: 'store', label: 'eBookJapan', url: (v) => v },
  cdj: { kind: 'store', label: 'CDJapan', url: (v) => v },
  al: { kind: 'info', label: 'AniList', url: (v) => `https://anilist.co/manga/${encodeURIComponent(v)}` },
  mal: { kind: 'info', label: 'MyAnimeList', url: (v) => `https://myanimelist.net/manga/${encodeURIComponent(v)}` },
  mu: {
    kind: 'info',
    label: 'MangaUpdates',
    url: (v) => (/^\d+$/.test(v) ? `https://www.mangaupdates.com/series.html?id=${v}` : `https://www.mangaupdates.com/series/${encodeURIComponent(v)}`),
  },
  ap: { kind: 'info', label: 'Anime-Planet', url: (v) => `https://www.anime-planet.com/manga/${encodeURIComponent(v)}` },
  kt: { kind: 'info', label: 'Kitsu', url: (v) => `https://kitsu.app/manga/${encodeURIComponent(v)}` },
  nu: { kind: 'info', label: 'Novel Updates', url: (v) => `https://www.novelupdates.com/series/${encodeURIComponent(v)}` },
};

function linksOf(links: Record<string, string> | null | undefined): MangaLink[] {
  const out: MangaLink[] = [];
  for (const [k, def] of Object.entries(LINKS)) {
    const v = links?.[k]?.trim();
    const url = v ? web(def.url(v)) : null;
    if (url) out.push({ kind: def.kind, label: def.label, url });
  }
  return out;
}

/** Sexual content with children: never shown, by tag. */
export function never(m: RawManga): boolean {
  return (m.attributes.tags ?? []).some((t) => NEVER_IDS.includes(t.id) || NEVER_NAMES.has((t.attributes?.name?.en ?? '').trim().toLowerCase()));
}

const STATUS = new Set(['ongoing', 'completed', 'hiatus', 'cancelled']);
const DEMOGRAPHIC = new Set(['shounen', 'shoujo', 'josei', 'seinen']);
const TAG_GROUPS = new Set(['genre', 'theme', 'format', 'content']);

function card(m: RawManga): MangaCard {
  const a = m.attributes;
  const file = rels(m, 'cover_art')[0]?.attributes?.fileName;
  return {
    id: m.id,
    title: pick(a.title)?.trim() || pick(a.altTitles?.[0])?.trim() || 'Untitled',
    cover: typeof file === 'string' && /^[\w-]{1,80}\.(jpe?g|png|webp|gif)$/i.test(file) ? file : null,
    rating: a.contentRating && ALL.includes(a.contentRating) ? a.contentRating : 'safe',
    status: a.status && STATUS.has(a.status) ? (a.status as MangaCard['status']) : null,
    year: typeof a.year === 'number' ? a.year : null,
    langs: [...new Set((a.availableTranslatedLanguages ?? []).filter((l): l is string => !!l))],
    original: a.originalLanguage ?? 'ja',
    authors: names(m, 'author'),
  };
}

function details(m: RawManga): MangaSeries {
  const a = m.attributes;
  const base = card(m);
  const alt = (a.altTitles ?? []).flatMap((t) => Object.values(t)).map((t) => t.trim()).filter((t) => t && t !== base.title);
  return {
    ...base,
    altTitles: [...new Set(alt)].slice(0, 12),
    description: plain(pick(a.description) ?? ''),
    tags: (a.tags ?? [])
      .map((t) => ({ name: pick(t.attributes?.name)?.trim() ?? '', group: (t.attributes?.group ?? 'genre') as MangaSeries['tags'][number]['group'] }))
      .filter((t) => t.name && TAG_GROUPS.has(t.group)),
    demographic: a.publicationDemographic && DEMOGRAPHIC.has(a.publicationDemographic) ? (a.publicationDemographic as MangaSeries['demographic']) : null,
    artists: names(m, 'artist'),
    links: linksOf(a.links),
    page: `https://mangadex.org/title/${m.id}`,
  };
}

function chapterOf(c: RawChapter): MangaChapter | null {
  const a = c.attributes;
  if (a.isUnavailable) return null;
  const external = web(a.externalUrl);
  const pages = typeof a.pages === 'number' && a.pages > 0 ? Math.floor(a.pages) : 0;
  if (!external && !pages) return null;
  // Held back by its group for a while: not readable yet.
  const at = Date.parse(a.readableAt ?? a.publishAt ?? '');
  if (at > Date.now()) return null;
  return {
    id: c.id,
    chapter: a.chapter?.trim() || null,
    volume: a.volume?.trim() || null,
    title: a.title?.trim() || null,
    pages: external ? 0 : pages,
    external,
    groups: rels(c, 'scanlation_group').map((g) => ({ id: g.id, name: String(g.attributes?.name ?? '').trim() || 'A group' })),
    at: Number.isFinite(at) ? at : 0,
  };
}

type Query = Record<string, string | number | string[] | undefined>;
/** MangaDex's lists go as name[]=a&name[]=b. */
const query = (q: Query): Array<[string, string]> =>
  Object.entries(q).flatMap(([k, v]): Array<[string, string]> =>
    v === undefined ? [] : Array.isArray(v) ? v.map((x) => [`${k}[]`, x]) : [[k, String(v)]],
  );

export function makeManga(opts: MangaOptions): Manga {
  const fetchFn = opts.fetch ?? fetch;
  const disk = new Disk(opts.dir, opts.cacheBytes);
  const [apiCount, apiPer] = opts.pace?.api ?? [4, 1000];
  const [homeCount, homePer] = opts.pace?.home ?? [35, MINUTE];
  const apiPace = new Pace(apiCount, apiPer, 20_000);
  const homePace = new Pace(homeCount, homePer, 30_000);
  const images = new Gate(8, 30_000);

  const searches = new Memo<MangaSearchResult>(10 * MINUTE, 300);
  const seriesMemo = new Memo<RawManga>(HOUR, 3000);
  const feeds = new Memo<MangaChapters>(10 * MINUTE, 200);
  const homes = new Memo<AtHome>(10 * MINUTE, 500);
  const chapterInfo = new Memo<string>(HOUR, 5000);
  const tags = new Memo<string[]>(24 * HOUR, 1);
  /** The series each chapter seen in a list is in, so its pages can be checked without asking. */
  const chapterSeries = new Map<string, string>();
  const fetching = new Map<string, Promise<Picture>>();

  async function get(url: string, timeout: number, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetchFn(url, { ...init, headers: { 'user-agent': USER_AGENT, ...(init.headers as Record<string, string>) }, signal: AbortSignal.timeout(timeout) });
    } catch (err) {
      log.warn({ err, host: new URL(url).host }, 'MangaDex didn’t answer');
      throw unreachable();
    }
  }

  async function call<T>(path: string, params: Array<[string, string]>): Promise<T> {
    try {
      await apiPace.take();
    } catch {
      throw busy();
    }
    const qs = new URLSearchParams(params).toString();
    const res = await get(`${API}${path}${qs ? `?${qs}` : ''}`, 15_000, { headers: { accept: 'application/json' } });
    if (res.status === 429) {
      const at = Number(res.headers.get('x-ratelimit-retry-after')) * 1000;
      apiPace.hold(Math.min(Date.now() + MINUTE, at > Date.now() ? at : Date.now() + 10_000));
      throw busy();
    }
    if (res.status === 404) throw notFound();
    if (!res.ok) {
      log.warn({ status: res.status, path }, 'MangaDex refused a call');
      throw res.status === 400 ? notFound() : unreachable();
    }
    const body = (await res.json().catch(() => null)) as { result?: string } | null;
    if (body?.result !== 'ok') throw unreachable();
    return body as T;
  }

  const neverIds = () =>
    tags
      .get('never', async () => {
        const r = await call<{ data: RawTag[] }>('/manga/tag', []);
        const ids = r.data.filter((t) => NEVER_NAMES.has((t.attributes?.name?.en ?? '').trim().toLowerCase())).map((t) => t.id);
        return [...new Set([...NEVER_IDS, ...ids])];
      })
      .catch(() => NEVER_IDS);

  const rawSeries = (id: string) =>
    seriesMemo.get(id, async () => (await call<{ data: RawManga }>(`/manga/${id}`, query({ includes: ['cover_art', 'author', 'artist'] }))).data);

  /** The series is one that can be shown at all. */
  async function allowed(id: string): Promise<RawManga> {
    const m = await rawSeries(id);
    if (never(m)) throw notFound();
    return m;
  }

  function remember(chapterId: string, seriesId: string) {
    chapterSeries.delete(chapterId);
    chapterSeries.set(chapterId, seriesId);
    if (chapterSeries.size > 100_000) chapterSeries.delete(chapterSeries.keys().next().value!);
  }

  async function allowChapter(chapterId: string) {
    const seriesId =
      chapterSeries.get(chapterId) ??
      (await chapterInfo.get(chapterId, async () => {
        const r = await call<{ data: RawChapter }>(`/chapter/${chapterId}`, query({ includes: ['manga'] }));
        const id = rels(r.data, 'manga')[0]?.id;
        if (!id) throw notFound();
        return id;
      }));
    remember(chapterId, seriesId);
    await allowed(seriesId);
  }

  const atHome = (chapterId: string, fresh: boolean) =>
    homes.get(
      chapterId,
      async () => {
        try {
          await homePace.take();
        } catch {
          throw busy();
        }
        return call<AtHome>(`/at-home/server/${chapterId}`, []);
      },
      fresh,
    );

  /** MangaDex@Home asks for every page fetched from it, so it can tell which of its servers work. */
  function report(r: { url: string; success: boolean; bytes: number; duration: number; cached: boolean }) {
    void fetchFn(REPORT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
      body: JSON.stringify(r),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
  }

  /** A picture from one of MangaDex's servers, as long as it is one. */
  async function picture(url: string, fromHome: boolean): Promise<Picture> {
    try {
      return await images.run(async () => {
        const start = Date.now();
        let res: Response | null = null;
        let data: Uint8Array | null = null;
        try {
          res = await get(url, 20_000);
          if (res.ok) data = new Uint8Array(await res.arrayBuffer());
        } catch {
          // As a failure, below.
        }
        const type = data && pictureType(data);
        if (fromHome) {
          report({ url, success: !!type, bytes: data?.byteLength ?? 0, duration: Date.now() - start, cached: (res?.headers.get('x-cache') ?? '').startsWith('HIT') });
        }
        if (!data || !type) throw unreachable();
        return { data, type };
      });
    } catch (e) {
      throw e instanceof Busy ? busy() : e;
    }
  }

  /** Kept on disk, or fetched once however many ask for it at the same time, then kept. */
  async function kept(key: string, make: () => Promise<Picture>): Promise<Picture> {
    const hit = await disk.get(key);
    if (hit) return hit;
    let going = fetching.get(key);
    if (!going) {
      going = make()
        .then(async (pic) => {
          await disk.put(key, pic.data);
          return pic;
        })
        .finally(() => fetching.delete(key));
      fetching.set(key, going);
    }
    return going;
  }

  return {
    async search({ q, lang, sort, adult, doujinshi, offset }) {
      const by = ORDER[sort ?? (q ? 'relevance' : 'popular')];
      // Relevance needs words to be relevant to.
      const field = by === 'relevance' && !q ? 'followedCount' : by;
      const key = JSON.stringify([q ?? '', lang ?? '', field, !!adult, !!doujinshi, offset]);
      return searches.get(key, async () => {
        // A new list, so the kept never-list stays as it is.
        const excluded = [...(await neverIds())];
        if (!doujinshi) excluded.push(DOUJINSHI_ID);
        const r = await call<{ data: RawManga[]; total: number }>('/manga', [
          ...query({
            limit: MANGA_PAGE,
            offset,
            title: q || undefined,
            includes: ['cover_art', 'author', 'artist'],
            contentRating: adult ? ALL : SAFE,
            excludedTags: excluded,
            excludedTagsMode: 'OR',
            availableTranslatedLanguage: lang ? [lang] : undefined,
            hasAvailableChapters: 'true',
          }),
          [`order[${field}]`, 'desc'],
        ]);
        const shown = r.data.filter((m) => !never(m));
        for (const m of shown) seriesMemo.set(m.id, m);
        return { total: Math.min(r.total, 10_000), offset, items: shown.map(card) };
      });
    },

    async series(id, adult) {
      const m = await allowed(id);
      if (!adult && ADULT_RATINGS.includes(m.attributes.contentRating ?? 'safe')) throw adultOnly();
      return details(m);
    },

    async chapters(id, lang) {
      await allowed(id);
      return feeds.get(`${id}:${lang}`, async () => {
        const chapters: MangaChapter[] = [];
        for (let offset = 0; offset < 10_000; offset += FEED) {
          const r = await call<{ data: RawChapter[]; total: number }>(`/manga/${id}/feed`, [
            ...query({ limit: FEED, offset, translatedLanguage: [lang], includes: ['scanlation_group'], contentRating: ALL }),
            ['order[volume]', 'asc'],
            ['order[chapter]', 'asc'],
          ]);
          for (const raw of r.data) {
            const c = chapterOf(raw);
            if (!c) continue;
            chapters.push(c);
            remember(c.id, id);
          }
          if (offset + FEED >= r.total) break;
        }
        return { lang, chapters };
      });
    },

    async page(chapterId, n, saver) {
      await allowChapter(chapterId);
      return kept(`page:${chapterId}:${saver ? 's' : 'd'}:${n}`, async () => {
        const from = async (fresh: boolean) => {
          const home = await atHome(chapterId, fresh);
          const files = saver ? home.chapter.dataSaver : home.chapter.data;
          if (!(n < files.length)) throw notFound();
          const url = `${home.baseUrl}/${saver ? 'data-saver' : 'data'}/${home.chapter.hash}/${files[n]}`;
          return picture(url, !home.baseUrl.startsWith(UPLOADS));
        };
        try {
          return await from(false);
        } catch (e) {
          if (e instanceof ApiError && e.code !== 'manga_unreachable') throw e;
          // Its server stopped answering, or the address expired: MangaDex gives another.
          return from(true);
        }
      });
    },

    async cover(mangaId, file, size) {
      await allowed(mangaId);
      return kept(`cover:${mangaId}:${file}:${size}`, () => picture(`${UPLOADS}/covers/${mangaId}/${file}.${size}.jpg`, false));
    },
  };
}
