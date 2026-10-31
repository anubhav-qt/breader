import type { AniCard, AniListAbout, AniListPage, AniListSort, AniRelated, AniRelation, MangaCard, MangaKind } from '@breader/shared';
import { both, Memo, MemoryStore, type Store } from '../lib/cache.ts';
import { ApiError } from '../lib/errors.ts';
import { log } from '../log.ts';
import type { Cover, Covers, CoverWidth } from './covers.ts';
import { pictureType, type Picture } from './disk.ts';
import { USER_AGENT } from './mangadex.ts';
import { Pace } from './pace.ts';

/*
 * AniList (docs.anilist.co), as its terms ask: free below $150 a month of revenue, no hoarding, and
 * its rate limit kept to (30 calls a minute while it's degraded, 90 otherwise). It gives Browse its
 * Popular, Trending and Top rated lists, and a series' page what came before and after it and what
 * readers say is like it. Every answer is kept a while (in Redis when there's one), its covers on
 * disk as the sites' are (covers.ts), so the laptop asks AniList little. Series tagged lolicon or
 * shotacon are never shown, as on MangaDex.
 */

const API = 'https://graphql.anilist.co';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Cards a list page holds. */
const PER_PAGE = 30;
/** Similar series a page shows at most. */
const MOST_SIMILAR = 12;
const NEVER_TAGS = new Set(['lolicon', 'shotacon']);
/** Where AniList's covers are, so the laptop fetches nothing else for one. */
const COVER_HOSTS = /(^|\.)(anilist\.co|anili\.st)$/;

const SORT: Record<AniListSort, string> = { popular: 'POPULARITY_DESC', trending: 'TRENDING_DESC', rated: 'SCORE_DESC' };
const COUNTRY: Record<string, MangaKind> = { JP: 'manga', KR: 'manhwa', CN: 'manhua', TW: 'manhua', HK: 'manhua' };
/** The one country a kind is asked for by, when it's the only kind wanted. */
const COUNTRY_OF: Partial<Record<MangaKind, string>> = { manga: 'JP', manhwa: 'KR', manhua: 'CN' };
const FORMAT: Record<string, string> = { MANGA: 'Manga', ONE_SHOT: 'One shot', NOVEL: 'Novel' };
const STATUS: Record<string, MangaCard['status']> = { RELEASING: 'ongoing', FINISHED: 'completed', HIATUS: 'hiatus', CANCELLED: 'cancelled' };
const RELATION: Record<string, AniRelation> = {
  PREQUEL: 'prequel',
  SEQUEL: 'sequel',
  PARENT: 'parent',
  SIDE_STORY: 'side_story',
  SPIN_OFF: 'spin_off',
  ALTERNATIVE: 'alternative',
  CHARACTER: 'character',
  SUMMARY: 'summary',
  OTHER: 'other',
  COMPILATION: 'other',
  CONTAINS: 'other',
};
/** Related series in this order: what comes before and after first. */
const RELATION_ORDER: AniRelation[] = ['prequel', 'sequel', 'parent', 'side_story', 'spin_off', 'alternative', 'character', 'summary', 'other'];

const CARD = `fragment card on Media {
  id type format status countryOfOrigin isAdult
  title { romaji english native }
  synonyms
  coverImage { extraLarge large }
  startDate { year }
  tags { name }
}`;
const LIST = `query ($page: Int, $sort: [MediaSort], $adult: Boolean, $country: CountryCode) {
  Page(page: $page, perPage: ${PER_PAGE}) {
    pageInfo { hasNextPage }
    media(type: MANGA, sort: $sort, isAdult: $adult, countryOfOrigin: $country, format_not_in: [NOVEL]) { ...card }
  }
}
${CARD}`;
const ABOUT_FIELDS = `...card
    relations { edges { relationType(version: 2) node { ...card } } }
    recommendations(sort: [RATING_DESC], perPage: 25) { nodes { rating mediaRecommendation { ...card } } }`;
const ABOUT = `query ($id: Int) { Media(id: $id, type: MANGA) { ${ABOUT_FIELDS} } }
${CARD}`;
const FIND = `query ($search: String) { Media(search: $search, type: MANGA, format_not_in: [NOVEL]) { ${ABOUT_FIELDS} } }
${CARD}`;
const COVER = `query ($id: Int) { Media(id: $id) { id coverImage { extraLarge large } } }`;

interface RawMedia {
  id: number;
  type?: string | null;
  format?: string | null;
  status?: string | null;
  countryOfOrigin?: string | null;
  isAdult?: boolean | null;
  title?: { romaji?: string | null; english?: string | null; native?: string | null } | null;
  synonyms?: Array<string | null> | null;
  coverImage?: { extraLarge?: string | null; large?: string | null } | null;
  startDate?: { year?: number | null } | null;
  tags?: Array<{ name?: string | null } | null> | null;
}
interface RawAbout extends RawMedia {
  relations?: { edges?: Array<{ relationType?: string | null; node?: RawMedia | null } | null> | null } | null;
  recommendations?: { nodes?: Array<{ rating?: number | null; mediaRecommendation?: RawMedia | null } | null> | null } | null;
}

/** A list of AniList's, as Browse asks for it. */
export interface AniListAsk {
  sort: AniListSort;
  page: number;
  adult: boolean;
  adultOnly: boolean;
  kinds: MangaKind[];
}

export interface AniList {
  list(ask: AniListAsk): Promise<AniListPage>;
  /** A series by its AniList id; adult: 18+ series among those it names too. */
  about(id: number, adult: boolean): Promise<AniListAbout>;
  /** The series AniList finds by this title, or null when it finds none. */
  find(title: string, adult: boolean): Promise<AniListAbout | null>;
  cover(id: number, size: CoverWidth): Promise<Cover>;
  /** A series' card by its AniList id: from a list or page it came in, else asked of AniList. */
  card(id: number): Promise<AniCard>;
}

export interface AniListOptions {
  covers: Covers;
  fetch?: typeof fetch;
  store?: Store | null;
  /** Calls a window. Tests go faster. */
  pace?: [number, number];
}

const busy = () => new ApiError(503, 'anilist_busy', 'AniList is busy just now. Try again in a minute.');
const unreachable = () => new ApiError(503, 'anilist_unreachable', 'Breader can’t reach AniList just now. Try again in a minute.');
const notFound = () => new ApiError(404, 'anilist_not_found', 'AniList doesn’t have that.');

const never = (m: RawMedia) => (m.tags ?? []).some((t) => NEVER_TAGS.has((t?.name ?? '').trim().toLowerCase()));

function namesOf(m: RawMedia): string[] {
  const all = [m.title?.english, m.title?.romaji, m.title?.native, ...(m.synonyms ?? [])];
  return [...new Set(all.map((t) => (t ?? '').trim()).filter(Boolean))].slice(0, 20);
}

/** AniList's cover for a series: the biggest it has. */
const coverOf = (m: RawMedia) => m.coverImage?.extraLarge || m.coverImage?.large || null;

function cardOf(m: RawMedia): AniCard {
  const names = namesOf(m);
  let kind: MangaKind | null = null;
  if (m.countryOfOrigin) kind = COUNTRY[m.countryOfOrigin] ?? 'comics';
  return {
    id: m.id,
    title: m.title?.english?.trim() || m.title?.romaji?.trim() || names[0] || 'Untitled',
    names,
    cover: !!coverOf(m),
    kind,
    format: FORMAT[m.format ?? ''] ?? 'Manga',
    status: STATUS[m.status ?? ''] ?? null,
    year: m.startDate?.year ?? null,
    adult: !!m.isAdult,
  };
}

/** A related or similar series that can be shown: a manga (not an anime), not a novel, and not for adults unless they're shown. */
const showable = (m: RawMedia | null | undefined, adult: boolean): m is RawMedia =>
  !!m && m.type === 'MANGA' && m.format !== 'NOVEL' && !never(m) && (adult || !m.isAdult);

export function makeAniList(opts: AniListOptions): AniList {
  const fetchFn = opts.fetch ?? fetch;
  const [count, per] = opts.pace ?? [25, MINUTE];
  const pace = new Pace(count, per, 20_000);
  // Without a shared store, memory alone keeps them.
  const store: Store = opts.store ?? { get: async () => undefined, set: async () => {} };
  // Each kind kept in memory too (both()), so AniList's limit holds with Redis away.
  const lists = new Memo<AniListPage>(both(new MemoryStore(300), store), 'anilist:v1:list', 6 * HOUR, 3 * DAY);
  const abouts = new Memo<RawAbout>(both(new MemoryStore(500), store), 'anilist:v1:about', DAY, 7 * DAY);
  /** The id a title finds, or 0 when it finds none. */
  const finds = new Memo<number>(both(new MemoryStore(5000), store), 'anilist:v1:find', 7 * DAY, 30 * DAY);
  /**
   * Where each series' cover is, from the lists and series it came in: in this process's memory as
   * well as the store, so a list's covers never ask AniList again, even with Redis away.
   */
  const coverUrls = new Memo<string>(both(new MemoryStore(50_000), store), 'anilist:v1:cover-url', 30 * DAY);
  /** Each series' card, from the lists and series it came in, for looking it up on the sites by its id. */
  const cards = new Memo<AniCard>(both(new MemoryStore(20_000), store), 'anilist:v1:card', 7 * DAY, 30 * DAY);

  async function call<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    try {
      await pace.take();
    } catch {
      throw busy();
    }
    let res: Response;
    try {
      res = await fetchFn(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': USER_AGENT },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      log.warn({ err }, 'AniList didn’t answer');
      throw unreachable();
    }
    if (res.status === 429) {
      const after = Number(res.headers.get('retry-after')) * 1000;
      pace.hold(Date.now() + Math.min(MINUTE, after > 0 ? after : 30_000));
      throw busy();
    }
    const body = (await res.json().catch(() => null)) as { data?: T; errors?: Array<{ status?: number }> } | null;
    if (res.status === 404 || body?.errors?.some((e) => e.status === 404)) throw notFound();
    if (!res.ok || !body?.data) {
      log.warn({ status: res.status }, 'AniList refused a call');
      throw unreachable();
    }
    return body.data;
  }

  /** Keeps where each series' cover is, for its cover's route, and its card. */
  function noteCovers(media: Array<RawMedia | null | undefined>) {
    for (const m of media) {
      if (!m) continue;
      const url = coverOf(m);
      if (url) coverUrls.set(String(m.id), url);
      if (m.type !== 'ANIME' && !never(m)) cards.set(String(m.id), cardOf(m));
    }
  }

  function aboutOf(m: RawAbout, adult: boolean): AniListAbout {
    const related: AniRelated[] = [];
    const seen = new Set<number>([m.id]);
    for (const e of m.relations?.edges ?? []) {
      const relation = RELATION[e?.relationType ?? ''];
      const node = e?.node;
      if (!relation || !showable(node, adult) || seen.has(node.id)) continue;
      seen.add(node.id);
      related.push({ ...cardOf(node), relation });
    }
    related.sort((a, b) => RELATION_ORDER.indexOf(a.relation) - RELATION_ORDER.indexOf(b.relation));
    const similar: AniCard[] = [];
    for (const n of m.recommendations?.nodes ?? []) {
      const r = n?.mediaRecommendation;
      // Rated down by more readers than up: not like it, whatever someone said.
      if ((n?.rating ?? 0) <= 0 || !showable(r, adult) || seen.has(r.id)) continue;
      seen.add(r.id);
      similar.push(cardOf(r));
      if (similar.length === MOST_SIMILAR) break;
    }
    return { ...cardOf(m), related, similar };
  }

  function rawAbout(id: number) {
    return abouts.get(String(id), async () => {
      const r = await call<{ Media: RawAbout | null }>(ABOUT, { id });
      if (!r.Media) throw notFound();
      noteAbout(r.Media);
      return r.Media;
    });
  }

  function noteAbout(m: RawAbout) {
    noteCovers([m, ...(m.relations?.edges ?? []).map((e) => e?.node), ...(m.recommendations?.nodes ?? []).map((n) => n?.mediaRecommendation)]);
  }

  async function coverUrl(id: number): Promise<string> {
    return coverUrls.get(String(id), async () => {
      const r = await call<{ Media: RawMedia | null }>(COVER, { id });
      const url = r.Media && coverOf(r.Media);
      if (!url) throw notFound();
      return url;
    });
  }

  async function picture(url: string): Promise<Picture> {
    let host = '';
    try {
      host = new URL(url).host;
    } catch {
      // Not a url: as below.
    }
    if (!COVER_HOSTS.test(host)) throw notFound();
    try {
      const res = await fetchFn(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(20_000) });
      if (res.ok) {
        const data = new Uint8Array(await res.arrayBuffer());
        const type = pictureType(data);
        if (type) return { data, type };
      }
    } catch {
      // As below.
    }
    throw unreachable();
  }

  async function about(id: number, adult: boolean): Promise<AniListAbout> {
    const m = await rawAbout(id);
    if (never(m) || (!adult && m.isAdult)) throw notFound();
    return aboutOf(m, adult);
  }

  return {
    about,

    card(id) {
      return cards.get(String(id), async () => {
        const m = await rawAbout(id);
        if (never(m)) throw notFound();
        return cardOf(m);
      });
    },

    async list(ask) {
      let adult: boolean | null = false;
      if (ask.adultOnly) adult = true;
      else if (ask.adult) adult = null;
      // One kind is asked for by its country; some kinds but not all are picked out of every one.
      let country: string | null = null;
      if (ask.kinds.length === 1) country = COUNTRY_OF[ask.kinds[0]] ?? null;
      const key = [ask.sort, ask.page, adult === null ? 'any' : adult ? 'only18' : 'safe', [...ask.kinds].sort().join('+')].join(':');
      return lists.get(key, async () => {
        // A filter left null is one AniList matches against null, so one not wanted is left out.
        const vars: Record<string, unknown> = { page: ask.page, sort: [SORT[ask.sort]] };
        if (adult !== null) vars.adult = adult;
        if (country) vars.country = country;
        const r = await call<{ Page: { pageInfo?: { hasNextPage?: boolean }; media?: RawMedia[] } }>(LIST, vars);
        const media = (r.Page.media ?? []).filter((m) => !never(m));
        noteCovers(media);
        let items = media.map(cardOf);
        if (ask.kinds.length < 4) items = items.filter((c) => c.kind !== null && ask.kinds.includes(c.kind));
        let next: number | null = null;
        if (r.Page.pageInfo?.hasNextPage && ask.page < 100) next = ask.page + 1;
        return { items, next };
      });
    },

    async find(title, adult) {
      const id = await finds.get(title.toLowerCase(), async () => {
        try {
          const r = await call<{ Media: RawAbout | null }>(FIND, { search: title });
          if (!r.Media) return 0;
          noteAbout(r.Media);
          abouts.set(String(r.Media.id), r.Media);
          return r.Media.id;
        } catch (e) {
          if (e instanceof ApiError && e.code === 'anilist_not_found') return 0;
          throw e;
        }
      });
      if (!id) return null;
      try {
        return await about(id, adult);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'anilist_not_found') return null;
        throw e;
      }
    },

    async cover(id, size) {
      const url = await coverUrl(id);
      return opts.covers.get(`al:${id}`, `al:${id}`, size, () => picture(url));
    },
  };
}
