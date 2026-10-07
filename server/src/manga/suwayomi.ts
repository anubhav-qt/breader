import { AsyncLocalStorage } from 'node:async_hooks';
import { MANGA_KINDS, MANGA_PAGE, type MangaChapter, type MangaChapters, type MangaSort, type SourceCard, type SourceSeries } from '@breader/shared';
import { Memo, MemoryStore, type Store } from '../lib/cache.ts';
import { ApiError } from '../lib/errors.ts';
import { log } from '../log.ts';
import { pictureType, type Disk, type Picture } from './disk.ts';
import { DEADLINE, WARM, wantedKind, wantedName, type Found, type Lot, type Place, type Wanted } from './find.ts';
import { adultGenre, kindGenre, neverGenre, sideGenre, web } from './genres.ts';
import { Busy, Gate, Pace } from './pace.ts';
import { caughtUp, firstMissing, highest } from './readable.ts';
import { Speeds } from './speed.ts';

/*
 * The sources of Breader's own Suwayomi server (SUWAYOMI_URL): each extension installed there is a
 * place a search looks (find.ts), and its series are read through here, the same for every reader.
 * Suwayomi fetches from each site as its extension says, keeping to that site's own limits; on top
 * of that, Breader asks each source no faster than it asks MangaDex. As with MangaDex, a search
 * shows only series every chapter of can be read (readable.ts), never one tagged loli or shota,
 * those for adults only with 18+, doujinshi and anthologies only when asked, and only the kinds
 * asked for. Each series is judged by its own genres: a site that has some series for adults
 * isn't kept out whole. Pages and covers are kept on disk. Some sites let only so many calls
 * through, so each lot is timed (speed.ts), and browsing leaves out a source too slow for find.ts's
 * DEADLINE; a search by name asks every one.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Suwayomi's own folder of files, not a site: never a place to look. */
const LOCAL = '0';
/** The calls a lot is making of its source's site, counted as they're made, to time it by (lot()). */
const tally = new AsyncLocalStorage<{ calls: number }>();

const STATUS = new Map<string, SourceCard['status']>([
  ['ONGOING', 'ongoing'],
  ['COMPLETED', 'completed'],
  ['PUBLISHING_FINISHED', 'completed'],
  ['CANCELLED', 'cancelled'],
  ['ON_HIATUS', 'hiatus'],
]);

const SOURCES = 'query { sources { nodes { id name lang supportsLatest } } }';
const SEARCH = 'mutation($input: FetchSourceMangaInput!) { fetchSourceManga(input: $input) { hasNextPage mangas { id title } } }';
const SERIES = 'mutation($id: Int!) { fetchManga(input: { id: $id }) { manga { id title status genre author artist description realUrl source { id name } } } }';
const CHAPTERS = 'mutation($id: Int!) { fetchChapters(input: { mangaId: $id }) { chapters { id name chapterNumber scanlator uploadDate sourceOrder } } }';
const PAGES = 'mutation($id: Int!) { fetchChapterPages(input: { chapterId: $id }) { pages } }';
// These two ask only what Suwayomi has already, not the site.
const SOURCE_OF = 'query($id: Int!) { manga(id: $id) { source { id } } }';
const SERIES_OF = 'query($id: Int!) { chapter(id: $id) { mangaId } }';
/** Only the page pictures Suwayomi serves. */
const PAGE_PATH = /^\/api\/v1\/manga\/\d+\/chapter\/\d+\/page\/\d+$/;

interface Reply<T> {
  data?: T | null;
  errors?: Array<{ message?: string }>;
}
interface RawSource {
  id: string;
  name: string;
  lang: string;
  supportsLatest: boolean;
}
interface SearchPage {
  mangas: Array<{ id: number; title: string }>;
  hasNextPage: boolean;
}
interface RawSeries {
  id: number;
  title: string;
  status: string;
  genre: string[];
  author: string | null;
  artist: string | null;
  description: string | null;
  realUrl: string | null;
  source: { id: string; name: string } | null;
}
interface RawChapter {
  id: number;
  name: string;
  /** -1 when it has none. */
  chapterNumber: number;
  scanlator: string | null;
  uploadDate: string;
  sourceOrder: number;
}

export interface Suwayomi {
  /** A place for each source a search looks in. */
  places(w: Wanted): Promise<Place[]>;
  series(id: number, adult: boolean): Promise<SourceSeries>;
  chapters(id: number): Promise<MangaChapters>;
  /** How many pages a chapter has. */
  pages(chapterId: number): Promise<number>;
  /** Page n of a chapter, from 0. */
  page(chapterId: number, n: number): Promise<Picture>;
  cover(id: number): Promise<Picture>;
  /** Checks the Popular and Updated first lots of each source quick enough to browse, ahead of readers. */
  warm(): Promise<void>;
}

export interface SuwayomiOptions {
  url: string;
  /** Where pages and covers are kept. */
  disk: Disk;
  fetch?: typeof fetch;
  /** Calls a window to each source. Tests go faster. */
  pace?: [number, number];
  /** Where its answers are kept: Redis, when the server has one. Without, in memory. */
  store?: Store | null;
  /** How long a lot it hasn't seen may take a source for it to be browsed: find.ts's DEADLINE. Tests go faster. */
  browseWithin?: number;
}

const notFound = () => new ApiError(404, 'manga_not_found', 'That series isn’t there any more.');
const noPage = () => new ApiError(404, 'manga_not_found', 'That chapter has no page there.');
const busy = () => new ApiError(503, 'manga_busy', 'That source is busy just now. Try again in a minute.');
const unreachable = () => new ApiError(503, 'manga_unreachable', 'Breader can’t reach that source just now. Try again in a minute.');
const refused = () => new ApiError(503, 'manga_source_down', 'That source isn’t answering just now. Try again later.');
const adultOnly = () => new ApiError(403, 'manga_adult', 'This series is for adults. Turn on Show 18+ to see it.');

/** What Suwayomi said went wrong, without the trace that follows. */
function firstLine(message: string | undefined): string {
  const line = String(message ?? '').split(/\r?\n/)[0];
  return line.replace(/^Exception while fetching data \([^)]*\) : /, '').slice(0, 300);
}

function cardOf(m: RawSeries): SourceCard {
  let status: SourceCard['status'] = null;
  const known = STATUS.get(m.status);
  if (known) status = known;
  return {
    id: `sw:${m.id}`,
    title: m.title.trim() || 'Untitled',
    cover: `/v1/manga/source/sw:${m.id}/cover`,
    status,
    adult: adultGenre(m.genre),
    side: sideGenre(m.genre),
    kind: kindGenre(m.genre),
  };
}

/** Its author and artist, each named once. */
function people(m: RawSeries): string[] {
  const out: string[] = [];
  for (const field of [m.author, m.artist]) {
    for (const name of (field ?? '').split(',')) {
      const clean = name.trim();
      if (clean && !out.includes(clean)) out.push(clean);
    }
  }
  return out;
}

function about(m: RawSeries): string {
  const text = (m.description ?? '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n');
  return text.trim().slice(0, 6000);
}

function chapterOf(c: RawChapter): MangaChapter {
  let chapter: string | null = null;
  if (c.chapterNumber >= 0) chapter = String(c.chapterNumber);
  const groups = [];
  const by = c.scanlator?.trim();
  if (by) groups.push({ id: by, name: by });
  let at = Number(c.uploadDate);
  if (!Number.isFinite(at)) at = 0;
  // Its pages are counted once it's opened (/v1/manga/source/chapter/:id).
  return { id: `sw:${c.id}`, chapter, volume: null, title: c.name.trim() || null, pages: 0, external: null, groups, at };
}

/** By number, oldest first, those without one first of all. */
function byNumber(a: RawChapter, b: RawChapter): number {
  if (a.chapterNumber !== b.chapterNumber) return a.chapterNumber - b.chapterNumber;
  return a.sourceOrder - b.sourceOrder;
}

export function makeSuwayomi(opts: SuwayomiOptions): Suwayomi {
  const fetchFn = opts.fetch ?? fetch;
  const base = opts.url.replace(/\/+$/, '');
  const [count, per] = opts.pace ?? [4, 1000];
  const paces = new Map<string, Pace>();
  const images = new Gate(8, 30_000);
  const speeds = new Speeds();
  const within = opts.browseWithin ?? DEADLINE;
  /** Whether each source timed was quick enough to browse, to say so when that changes. */
  const browsing = new Map<string, boolean>();
  let warming = false;

  /** Answers of a kind, kept so long: in the store when there's one, or else in memory, up to `max` of them. */
  function memo<T>(kind: string, ttl: number, max: number): Memo<T> {
    let store: Store;
    if (opts.store) store = opts.store;
    else store = new MemoryStore(max);
    return new Memo<T>(store, `manga:v1:sw-${kind}`, ttl);
  }
  const sourceList = memo<RawSource[]>('sources', 10 * MINUTE, 1);
  const searches = memo<SearchPage>('search', 10 * MINUTE, 300);
  const seriesMemo = memo<RawSeries>('series', 6 * HOUR, 3000);
  const chapterLists = memo<MangaChapter[]>('chapters', 10 * MINUTE, 300);
  const verdicts = memo<boolean>('readable', DAY, 20_000);
  const pageLists = memo<string[]>('pages', 10 * MINUTE, 500);
  /** Which source each series is from, and which series each chapter is in: they never change. */
  const seriesSource = memo<string>('series-source', 30 * DAY, 100_000);
  const chapterSeries = memo<number>('chapter-series', 30 * DAY, 100_000);

  function paceOf(source: string): Pace {
    let pace = paces.get(source);
    if (!pace) {
      pace = new Pace(count, per, 20_000);
      paces.set(source, pace);
    }
    return pace;
  }

  /** A GraphQL call, taking a turn from the source it asks of, when it asks one. */
  async function ask<T>(query: string, variables: Record<string, unknown>, source: string | null): Promise<T> {
    if (source !== null) {
      try {
        await paceOf(source).take();
      } catch {
        throw busy();
      }
      const counting = tally.getStore();
      if (counting) counting.calls += 1;
    }
    let body: Reply<T> | null = null;
    try {
      const res = await fetchFn(`${base}/api/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30_000),
      });
      body = (await res.json()) as Reply<T>;
    } catch (err) {
      log.warn({ err }, 'Suwayomi didn’t answer');
      throw unreachable();
    }
    const error = body?.errors?.[0];
    if (error) {
      const said = firstLine(error.message);
      // The site said to slow down: nothing more is asked of it for a minute.
      if (source !== null && /\b429\b/.test(said)) {
        paceOf(source).hold(Date.now() + MINUTE);
        throw busy();
      }
      log.warn({ source, said }, 'a Suwayomi source refused');
      throw refused();
    }
    if (!body?.data) throw unreachable();
    return body.data;
  }

  const sources = () =>
    sourceList.get('all', async () => {
      const r = await ask<{ sources: { nodes: RawSource[] } }>(SOURCES, {}, null);
      return r.sources.nodes.filter((s) => s.id !== LOCAL);
    });

  /** The language a source's chapters are in: English for one in many. */
  async function langOf(source: string): Promise<string> {
    const all = await sources();
    const s = all.find((x) => x.id === source);
    if (!s) return 'en';
    const lang = s.lang.toLowerCase();
    if (/^[a-z]{2,3}(-[a-z]{2,3})?$/.test(lang)) return lang;
    return 'en';
  }

  /** The source a series is from, as Suwayomi has it already. */
  function sourceOf(id: number): Promise<string> {
    return seriesSource.get(String(id), async () => {
      let r: { manga: { source: { id: string } | null } | null };
      try {
        r = await ask(SOURCE_OF, { id }, null);
      } catch (e) {
        // Suwayomi hasn't that series.
        if (e instanceof ApiError && e.code === 'manga_source_down') throw notFound();
        throw e;
      }
      const source = r.manga?.source?.id;
      if (!source || source === LOCAL) throw notFound();
      return source;
    });
  }

  /** The series a chapter is in, as Suwayomi has it already. */
  function seriesOf(chapterId: number): Promise<number> {
    return chapterSeries.get(String(chapterId), async () => {
      let r: { chapter: { mangaId: number } | null };
      try {
        r = await ask(SERIES_OF, { id: chapterId }, null);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'manga_source_down') throw notFound();
        throw e;
      }
      if (!r.chapter) throw notFound();
      return r.chapter.mangaId;
    });
  }

  /** A series as its source tells it, kept a while. */
  function rawSeries(id: number, source: string): Promise<RawSeries> {
    return seriesMemo.get(String(id), async () => {
      const r = await ask<{ fetchManga: { manga: RawSeries } }>(SERIES, { id }, source);
      return r.fetchManga.manga;
    });
  }

  /** A series that can be shown at all, and its source. */
  async function allowed(id: number): Promise<{ m: RawSeries; source: string }> {
    const source = await sourceOf(id);
    const m = await rawSeries(id, source);
    if (neverGenre(m.genre)) throw notFound();
    return { m, source };
  }

  function chapterList(id: number, source: string): Promise<MangaChapter[]> {
    return chapterLists.get(String(id), async () => {
      const r = await ask<{ fetchChapters: { chapters: RawChapter[] } }>(CHAPTERS, { id }, source);
      const raw = [...r.fetchChapters.chapters].sort(byNumber);
      return raw.map(chapterOf);
    });
  }

  /** Every chapter of the series can be read here, by its source's own list. Kept a day. */
  function readable(m: RawSeries, source: string): Promise<boolean> {
    return verdicts.get(String(m.id), async () => {
      const list = await chapterList(m.id, source);
      if (list.length === 0) return false;
      return caughtUp(cardOf(m).status, 0, firstMissing(list), highest(list));
    });
  }

  function pageList(chapterId: number, source: string): Promise<string[]> {
    return pageLists.get(String(chapterId), async () => {
      const r = await ask<{ fetchChapterPages: { pages: string[] } }>(PAGES, { id: chapterId }, source);
      return r.fetchChapterPages.pages.filter((p) => PAGE_PATH.test(p));
    });
  }

  /** Its source's results for a search, a page of them, kept a while. */
  function searchPage(source: RawSource, w: Wanted, page: number): Promise<SearchPage> {
    let type = 'POPULAR';
    const newest = w.sort === 'latest' || w.sort === 'new';
    if (w.q) type = 'SEARCH';
    else if (newest && source.supportsLatest) type = 'LATEST';
    const key = [source.id, type, page, w.q ?? ''].join(':');
    return searches.get(key, async () => {
      const input: Record<string, unknown> = { source: source.id, type, page };
      if (w.q) input.query = w.q;
      const r = await ask<{ fetchSourceManga: SearchPage }>(SEARCH, { input }, source.id);
      return r.fetchSourceManga;
    });
  }

  /** A series a search found, when it's one to show. */
  async function foundOf(id: number, source: RawSource, w: Wanted): Promise<Found | null> {
    seriesSource.set(String(id), source.id);
    const m = await rawSeries(id, source.id);
    if (neverGenre(m.genre)) return null;
    const card = cardOf(m);
    if (card.adult && !w.adult) return null;
    if (card.side && !w.doujinshi) return null;
    if (!wantedKind(card.kind, w)) return null;
    const ok = await readable(m, source.id);
    if (!ok) return null;
    return { item: { kind: 'source', source: source.name, card }, names: [m.title] };
  }

  /** Says in the log when a source is left out of browsing, or comes back. */
  function sayIfChanged(source: RawSource) {
    const quick = speeds.quick(source.id, within);
    const was = browsing.get(source.id) ?? true;
    browsing.set(source.id, quick);
    if (quick === was) return;
    const seconds = Math.round((speeds.lotTime(source.id) ?? 0) / 1000);
    if (quick) log.info({ source: source.name, seconds }, 'a source is quick enough to browse again');
    else log.info({ source: source.name, seconds }, 'a source is left out of browsing, as a lot it hasn’t seen takes it too long');
  }

  /** A search's next lot from a source, timed by the calls it made of the site. */
  async function lot(source: RawSource, w: Wanted, at: string): Promise<Lot> {
    const made = { calls: 0 };
    const started = Date.now();
    const answer = await tally.run(made, () => lotFrom(source, w, at));
    speeds.took(source.id, Date.now() - started, made.calls);
    sayIfChanged(source);
    return answer;
  }

  /**
   * Up to ten of a source's results, from where the search had got to (3.10 is page 3, its first
   * ten already looked at). Its pages count from 1.
   */
  async function lotFrom(source: RawSource, w: Wanted, at: string): Promise<Lot> {
    let page = Number(at);
    let seen = 0;
    const dot = at.indexOf('.');
    if (dot !== -1) {
      page = Number(at.slice(0, dot));
      seen = Number(at.slice(dot + 1));
    }
    if (page < 1) page = 1;
    const listed = await searchPage(source, w, page);
    const some = listed.mangas.slice(seen, seen + MANGA_PAGE);
    // Looking for one series' copies, only those of its name are checked.
    const named = some.filter((x) => wantedName([x.title], w));
    let failed: unknown = null;
    const each = await Promise.all(
      named.map((x) =>
        foundOf(x.id, source, w).catch((e) => {
          failed = e;
          return null;
        }),
      ),
    );
    const found: Found[] = [];
    for (const f of each) {
      if (f) found.push(f);
    }
    // Nothing found, and some couldn't be checked: that, not an empty lot.
    if (found.length === 0 && failed) throw failed;
    const looked = seen + some.length;
    let next: string | null = null;
    if (looked < listed.mangas.length) next = `${page}.${looked}`;
    else if (listed.hasNextPage && listed.mangas.length > 0) next = String(page + 1);
    return { found, next };
  }

  /**
   * A source's Popular and Updated first lots, checked ahead of readers as Browse first opens: in
   * English, nothing else on. Lot by lot, timed like a reader's, so a source found too slow is left
   * there.
   */
  async function warmSource(source: RawSource) {
    const sorts: MangaSort[] = ['popular'];
    if (source.supportsLatest) sorts.push('latest');
    try {
      for (const sort of sorts) {
        const w: Wanted = { lang: 'en', sort, adult: false, doujinshi: false, kinds: [...MANGA_KINDS] };
        let at: string | null = '0';
        for (let n = 0; n < WARM / MANGA_PAGE; n++) {
          if (at === null) break;
          if (!speeds.quick(source.id, within)) return;
          const answer: Lot = await lot(source, w, at);
          at = answer.next;
        }
      }
    } catch (err) {
      log.warn({ err, source: source.name }, 'checking a source’s first lots ahead stopped');
    }
  }

  /** A picture Suwayomi serves: a page, or a cover. */
  async function picture(path: string): Promise<Picture> {
    try {
      return await images.run(async () => {
        let data: Uint8Array | null = null;
        try {
          // Suwayomi may fetch it from the site first.
          const res = await fetchFn(`${base}${path}`, { signal: AbortSignal.timeout(60_000) });
          if (res.ok) data = new Uint8Array(await res.arrayBuffer());
        } catch (err) {
          log.warn({ err }, 'Suwayomi didn’t send a picture');
        }
        if (!data) throw unreachable();
        const type = pictureType(data);
        if (!type) throw unreachable();
        return { data, type };
      });
    } catch (e) {
      if (e instanceof Busy) throw busy();
      throw e;
    }
  }

  return {
    async places(w) {
      const out: Place[] = [];
      for (const s of await sources()) {
        if (w.lang && s.lang.toLowerCase() !== w.lang) continue;
        // Browsing, only the sources quick enough. A search by name asks every one.
        if (!w.q && !speeds.quick(s.id, within)) continue;
        out.push({ key: `sw${s.id}`, name: s.name, lot: (at) => lot(s, w, at) });
      }
      return out;
    },

    async warm() {
      if (warming) return;
      warming = true;
      try {
        const english = (await sources()).filter((s) => s.lang.toLowerCase() === 'en');
        await Promise.all(english.map((s) => warmSource(s)));
      } catch (err) {
        log.warn({ err }, 'checking the sources’ first lots ahead stopped');
      } finally {
        warming = false;
      }
    },

    async series(id, adult) {
      const { m } = await allowed(id);
      const card = cardOf(m);
      if (card.adult && !adult) throw adultOnly();
      let source = 'Suwayomi';
      if (m.source) source = m.source.name;
      return { ...card, source, authors: people(m), description: about(m), genres: m.genre, link: web(m.realUrl) };
    },

    async chapters(id) {
      const { source } = await allowed(id);
      return { lang: await langOf(source), chapters: await chapterList(id, source) };
    },

    async pages(chapterId) {
      const { source } = await allowed(await seriesOf(chapterId));
      return (await pageList(chapterId, source)).length;
    },

    async page(chapterId, n) {
      const { source } = await allowed(await seriesOf(chapterId));
      return opts.disk.keep(`sw-page:${chapterId}:${n}`, async () => {
        const paths = await pageList(chapterId, source);
        if (n >= paths.length) throw noPage();
        return picture(paths[n]);
      });
    },

    async cover(id) {
      await allowed(id);
      return opts.disk.keep(`sw-cover:${id}`, () => picture(`/api/v1/manga/${id}/thumbnail`));
    },
  };
}
