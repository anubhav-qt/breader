import { AsyncLocalStorage } from 'node:async_hooks';
import { gzipSync } from 'node:zlib';
import { MANGA_PAGE, type MangaChapter, type MangaChapters, type SourceCard, type SourceSeries } from '@breader/shared';
import { freshly, Memo, MemoryStore, type Store } from '../lib/cache.ts';
import { ApiError } from '../lib/errors.ts';
import { log } from '../log.ts';
import type { Cover, Covers, CoverWidth } from './covers.ts';
import { pictureType, type Disk, type Picture } from './disk.ts';
import { wantedKind, wantedName, type Found, type Lot, type Place, type Wanted } from './find.ts';
import { adultGenre, kindGenre, neverGenre, sideGenre, sideTitle, web } from './genres.ts';
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
 * isn't kept out whole. Pages and covers are kept on disk.
 *
 * Browsing reads each English source's shelves: its Popular and Updated lists, a few hundred series
 * deep, every one checked ahead of readers (warm), so Browse is shown them without asking the site
 * anything, however slow it is. Some sites let only so many calls through, so a lot that does ask
 * one is timed (speed.ts), and browsing past a shelf, or a source with none yet, leaves out a source
 * too slow, or keeps the quickest when every one is; a search by name asks every one.
 *
 * A series goes by its source and its address on the site (sw:<source>:<address>), and a chapter
 * by its series' and its own address, never by the number one Suwayomi has it by: so any Suwayomi
 * reads it, the laptop's or the one Render asks while the laptop is away. One that hasn't the
 * series yet takes it in from its site by its address.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** How long lists, series, chapters and verdicts are kept on past their time, as MangaDex's are (mangadex.ts). */
const KEPT = 3 * DAY;
/** How long a chapter's pages are kept on: reopened in a week, it opens without asking the site first. */
const PAGES_KEPT = 7 * DAY;
/**
 * How long a lot it hasn't seen may take a source for it to be browsed, past its shelves or before
 * it has any. A lot waits only so long for each place (find.ts), and one that's late shows with the
 * next.
 */
const BROWSE_WITHIN = 25_000;
/** How many of a list's series a shelf looks at: Browse's first screens of every kind, and a good way past. */
const SHELF = 300;
/** The most series a lot takes from each shelf: with two or three sources, some 50 cards of any one kind. */
const SHELF_LOT = 40;
/** Series checked at once for a shelf, so a reader's own calls to that site never wait long behind them. */
const SHELVING = 3;
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
const SEARCH = 'mutation($input: FetchSourceMangaInput!) { fetchSourceManga(input: $input) { hasNextPage mangas { id title url } } }';
const SERIES = 'mutation($id: Int!) { fetchManga(input: { id: $id }) { manga { id title url status genre author artist description realUrl source { id name } } } }';
const CHAPTERS = 'mutation($id: Int!) { fetchChapters(input: { mangaId: $id }) { chapters { id url name chapterNumber scanlator uploadDate sourceOrder } } }';
const PAGES = 'mutation($id: Int!) { fetchChapterPages(input: { chapterId: $id }) { pages } }';
// These two ask only what Suwayomi has already, not the site: a series and a chapter by their addresses.
const SERIES_AT = 'query($source: LongString!, $url: String!) { mangas(condition: { sourceId: $source, url: $url }) { nodes { id } } }';
const CHAPTER_AT = 'query($series: Int!, $url: String!) { chapters(condition: { mangaId: $series, url: $url }) { nodes { id } } }';
// A series taken in from a backup of it alone (bring()), then out of Suwayomi's library.
const RESTORE = 'mutation($backup: Upload!) { restoreBackup(input: { backup: $backup }) { id } }';
const RESTORED = 'query($id: String!) { restoreStatus(id: $id) { state } }';
const OUT_OF_LIBRARY = 'mutation($id: Int!) { updateManga(input: { id: $id, patch: { inLibrary: false } }) { manga { id } } }';
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
/** A series a list has, by the number Suwayomi has it by, and its address on the site. */
interface Listed {
  id: number;
  title: string;
  url: string;
}
interface SearchPage {
  mangas: Listed[];
  hasNextPage: boolean;
}
interface RawSeries {
  id: number;
  title: string;
  url: string;
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
  url: string;
  name: string;
  /** -1 when it has none. */
  chapterNumber: number;
  scanlator: string | null;
  uploadDate: string;
  sourceOrder: number;
}

/** A source's lists Browse shows: Popular, and Updated (New too) when it has one. */
type List = 'POPULAR' | 'LATEST';

/** A series on a shelf: its card, and the name it goes by there. */
interface Shelved {
  card: SourceCard;
  names: string[];
  /** Its author and artist; not on shelves kept from before they were. */
  people?: string[];
}

/**
 * One of a source's lists, as far as SHELF series, in its order. Only series that can be shown at
 * all are on it, 18+ and doujinshi of every kind too, as what a reader asks for is picked from it.
 */
interface Shelf {
  items: Shelved[];
  /** The list's page after the last one shelved, or null when the list ended there. */
  more: number | null;
}

/** Each by its id (SourceId: sw:<source>:<address>, and a chapter's own address after it). */
export interface Suwayomi {
  /** A place for each source a search looks in. */
  places(w: Wanted): Promise<Place[]>;
  series(id: string, adult: boolean): Promise<SourceSeries>;
  chapters(id: string): Promise<MangaChapters>;
  /** How many pages a chapter has. */
  pages(chapterId: string): Promise<number>;
  /** Page n of a chapter, from 0. */
  /** quiet: not counted as read (disk.ts). */
  page(chapterId: string, n: number, quiet?: boolean): Promise<Picture>;
  /** A series' cover at a width; early: the prefetch's (covers.ts). */
  cover(id: string, width: CoverWidth, early?: number): Promise<Cover>;
  /** Shelves every English source's Popular and Updated lists ahead of readers, their covers too. */
  warm(): Promise<void>;
}

export interface SuwayomiOptions {
  url: string;
  /** Where pages are kept. */
  disk: Disk;
  covers: Covers;
  fetch?: typeof fetch;
  /** Calls a window to each source. Tests go faster. */
  pace?: [number, number];
  /** Where its answers are kept: Redis, when the server has one. Without, in memory. */
  store?: Store | null;
  /** How long a lot it hasn't seen may take a source for it to be browsed (BROWSE_WITHIN). Tests go faster. */
  browseWithin?: number;
}

const notFound = () => new ApiError(404, 'manga_not_found', 'That series isn’t there any more.');
const noPage = () => new ApiError(404, 'manga_not_found', 'That chapter has no page there.');
const busy = () => new ApiError(503, 'manga_busy', 'That source is busy just now. Try again in a minute.');
const unreachable = () => new ApiError(503, 'manga_unreachable', 'Breader can’t reach that source just now. Try again in a minute.');
const refused = () => new ApiError(503, 'manga_source_down', 'That source isn’t answering just now. Try again later.');
const adultOnly = () => new ApiError(403, 'manga_adult', 'This series is for adults. Turn on Show 18+ to see it.');

/**
 * Suwayomi's address, and the login it asks for, when it has one: https://user:password@host, as
 * the one Render reads through over the open internet. The login goes as a header, as fetch takes
 * no address with one in it.
 */
export function suwayomiAddress(url: string): { base: string; login: Record<string, string> } {
  const u = new URL(url);
  const login: Record<string, string> = {};
  if (u.username) {
    const pair = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
    login.authorization = `Basic ${Buffer.from(pair).toString('base64')}`;
  }
  u.username = '';
  u.password = '';
  return { base: u.toString().replace(/\/+$/, ''), login };
}

/** What Suwayomi said went wrong, without the trace that follows. */
function firstLine(message: string | undefined): string {
  const line = String(message ?? '').split(/\r?\n/)[0];
  return line.replace(/^Exception while fetching data \([^)]*\) : /, '').slice(0, 300);
}

/** An address on a site, as it goes in an id: base64url, which is safe in a path. */
function encoded(address: string): string {
  return Buffer.from(address, 'utf8').toString('base64url');
}

function decoded(part: string): string {
  return Buffer.from(part, 'base64url').toString('utf8');
}

/** A series' id, the same on every Suwayomi: its source, and its address there. */
export function seriesId(source: string, url: string): string {
  return `sw:${source}:${encoded(url)}`;
}

/** One of its chapters' ids: the series', and the chapter's own address. */
export function chapterId(series: string, url: string): string {
  return `${series}:${encoded(url)}`;
}

/** What an id names: a series, by its source and address, and maybe one of its chapters. */
interface SourceRef {
  source: string;
  url: string;
  /** The series' id. */
  series: string;
  /** The chapter's address, when it names one. */
  chapter: string | null;
}

const SOURCE_REF = /^sw:(\d{1,20}):([\w-]{1,400})(?::([\w-]{1,400}))?$/;

/** What an id names. Not one at all, it names nothing there is. */
function refOf(id: string): SourceRef {
  const m = SOURCE_REF.exec(id);
  if (!m) throw notFound();
  let chapter: string | null = null;
  if (m[3]) chapter = decoded(m[3]);
  return { source: m[1], url: decoded(m[2]), series: `sw:${m[1]}:${m[2]}`, chapter };
}

/** A number as protobuf writes it: seven bits a byte, the lowest first, the top bit saying more follow. */
function varint(n: bigint): Buffer {
  const bytes: number[] = [];
  let rest = n;
  while (rest > 127n) {
    bytes.push(Number(rest & 127n) | 128);
    rest >>= 7n;
  }
  bytes.push(Number(rest));
  return Buffer.from(bytes);
}

/** A protobuf field holding a number. */
function numberField(field: number, n: bigint): Buffer {
  return Buffer.concat([varint(BigInt(field << 3)), varint(n)]);
}

/** A protobuf field holding bytes: a string, or a message inside. */
function bytesField(field: number, data: Buffer): Buffer {
  return Buffer.concat([varint(BigInt((field << 3) | 2)), varint(BigInt(data.length)), data]);
}

/**
 * A Mihon backup of one series, gzipped, with all Suwayomi needs to take it in: its source and its
 * address (Backup.backupManga, field 1, whose source and url are fields 1 and 2).
 */
export function backupOf(source: string, url: string): Buffer {
  const series = Buffer.concat([numberField(1, BigInt(source)), bytesField(2, Buffer.from(url, 'utf8'))]);
  return gzipSync(bytesField(1, series));
}

function cardOf(m: RawSeries, source: string): SourceCard {
  let status: SourceCard['status'] = null;
  const known = STATUS.get(m.status);
  if (known) status = known;
  const id = seriesId(source, m.url);
  return {
    id,
    title: m.title.trim() || 'Untitled',
    cover: `/v1/manga/source/${id}/cover`,
    status,
    adult: adultGenre(m.genre),
    side: sideGenre(m.genre) || sideTitle(m.title),
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

/**
 * A chapter's name without the number it starts with, which the reader shows already: "Ch. 4 - Message"
 * is "Message", and "Chapter 4" is no title at all. A name that's only its number is none.
 */
export function chapterTitle(name: string, n: number): string | null {
  const t = name.trim();
  if (n < 0) return t || null;
  const num = String(n).replace('.', '\\.');
  const lead = new RegExp(`^(?:vol(?:ume)?\\.?\\s*\\d+\\s*[-:,.]?\\s*)?(?:ch(?:apter|ap)?|ep(?:isode)?)\\.?\\s*0*${num}(?!\\d|\\.\\d)\\s*(?:[-:|.\\u2013\\u2014]\\s*)?`, 'i');
  const only = new RegExp(`^0*${num}$`);
  if (only.test(t)) return null;
  const rest = t.replace(lead, '').trim();
  return rest || null;
}

/** A chapter of a series, by the series' id. */
function chapterOf(c: RawChapter, series: string): MangaChapter {
  let chapter: string | null = null;
  if (c.chapterNumber >= 0) chapter = String(c.chapterNumber);
  const groups = [];
  const by = c.scanlator?.trim();
  if (by) groups.push({ id: by, name: by });
  let at = Number(c.uploadDate);
  if (!Number.isFinite(at)) at = 0;
  // Its pages are counted once it's opened (/v1/manga/source/chapter/:id).
  return { id: chapterId(series, c.url), chapter, volume: null, title: chapterTitle(c.name, c.chapterNumber), pages: 0, external: null, groups, at };
}

/** A tag in brackets at the start of a title ("(1r0n) f2"), a scanlator's mark more than a title. */
const TAG = /^\s*[([{][^)\]}]{1,24}[)\]}]\s*/;

/**
 * A source's chapters cleaned of what it fills in when it doesn't know (MangaFire is the worst):
 * a "title" that's the same on many chapters, or a scanlator's tag with a scrap after it, and the
 * date Suwayomi fetched them written as the day each came out, when nearly all came out that day.
 * "Official" and "unofficial" stay as they are, two copies of the series to choose between.
 */
export function tidy(chapters: MangaChapter[]): MangaChapter[] {
  const lower = (t: string | null) => t?.toLowerCase() ?? null;
  const counts = new Map<string, number>();
  const bump = (k: string | null) => { if (k) counts.set(k, (counts.get(k) ?? 0) + 1); };
  const tags = new Map<string, number>();
  for (const c of chapters) {
    bump(lower(c.title));
    const tag = c.title?.match(TAG)?.[0].trim().toLowerCase();
    if (tag) tags.set(tag, (tags.get(tag) ?? 0) + 1);
  }
  const days = new Map<number, number>();
  for (const c of chapters) if (c.at > 0) days.set(Math.floor(c.at / DAY), (days.get(Math.floor(c.at / DAY)) ?? 0) + 1);
  let fetched: number | null = null;
  for (const [day, n] of days) if (chapters.length >= 3 && n >= 0.8 * chapters.length) fetched = day;
  return chapters.map((c) => {
    let title = c.title;
    if (title && (counts.get(title.toLowerCase()) ?? 0) >= 3) title = null;
    const tag = title?.match(TAG)?.[0];
    if (title && tag && (tags.get(tag.trim().toLowerCase()) ?? 0) >= 3) {
      const rest = title.slice(tag.length).trim();
      title = rest.length > 2 ? rest : null;
    }
    let at = c.at;
    if (fetched !== null && Math.floor(at / DAY) === fetched) at = 0;
    const groups = c.groups.map((g) => (/^(un)?official$/i.test(g.name) ? { ...g, name: g.name[0].toUpperCase() + g.name.slice(1).toLowerCase() } : g));
    return { ...c, title, at, groups };
  });
}

/** By number, oldest first, those without one first of all. */
function byNumber(a: RawChapter, b: RawChapter): number {
  if (a.chapterNumber !== b.chapterNumber) return a.chapterNumber - b.chapterNumber;
  return a.sourceOrder - b.sourceOrder;
}

/** The list a browse shows of a source: Updated and New its latest, when it has one, or else its popular. */
function listOf(source: RawSource, w: Wanted): List {
  const newest = w.sort === 'latest' || w.sort === 'new';
  if (newest && source.supportsLatest) return 'LATEST';
  return 'POPULAR';
}

/** A series a search wants by its card: 18+ and doujinshi only when asked (or 18+ alone), and only the kinds asked. */
function wants(card: SourceCard, w: Wanted): boolean {
  if (card.adult && !w.adult) return false;
  if (!card.adult && w.adultOnly) return false;
  if (card.side && !w.doujinshi) return false;
  return wantedKind(card.kind, w);
}

/** fn for each of these, `n` at a time, the answers in their order. */
async function inTurn<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const one = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, one));
  return out;
}

export function makeSuwayomi(opts: SuwayomiOptions): Suwayomi {
  const fetchFn = opts.fetch ?? fetch;
  const { base, login } = suwayomiAddress(opts.url);
  const [count, per] = opts.pace ?? [4, 1000];
  const paces = new Map<string, Pace>();
  const images = new Gate(8, 30_000);
  const speeds = new Speeds();
  const within = opts.browseWithin ?? BROWSE_WITHIN;
  /** Whether each source timed was quick enough to browse, to say so when that changes. */
  const browsing = new Map<string, boolean>();
  let warming = false;

  /** Answers of a kind, kept so long (and on until `keep`): in the store when there's one, or else in memory, up to `max` of them. */
  function memo<T>(kind: string, ttl: number, max: number, keep = ttl): Memo<T> {
    let store: Store;
    if (opts.store) store = opts.store;
    else store = new MemoryStore(max);
    return new Memo<T>(store, `manga:v2:sw-${kind}`, ttl, keep);
  }
  const sourceList = memo<RawSource[]>('sources', 10 * MINUTE, 1, KEPT);
  const searches = memo<SearchPage>('search', 10 * MINUTE, 300, KEPT);
  const seriesMemo = memo<RawSeries>('series', 6 * HOUR, 3000, KEPT);
  const chapterLists = memo<MangaChapter[]>('chapters', 10 * MINUTE, 300, KEPT);
  const verdicts = memo<boolean>('readable', DAY, 20_000, KEPT);
  const pageLists = memo<string[]>('pages', 10 * MINUTE, 2000, PAGES_KEPT);
  const shelfMemo = memo<Shelf>('shelf', KEPT, 50);
  /** The shelves, as read or last made: this process is the only one making them. */
  const shelves = new Map<string, Shelf>();
  /**
   * The numbers this Suwayomi has each series and chapter by, by their ids: kept in memory only, as
   * they're this Suwayomi's own, and asking it again costs nothing of the site.
   */
  const localSeries = new Memo<number>(new MemoryStore(100_000), 'sw-local-series', 30 * DAY);
  const localChapters = new Memo<number>(new MemoryStore(100_000), 'sw-local-chapter', 30 * DAY);
  /** Series being taken in, one at a time (bring()). */
  let bringing: Promise<unknown> = Promise.resolve();

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
        headers: { 'content-type': 'application/json', accept: 'application/json', ...login },
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

  /** The number Suwayomi has a series by, when it has it already. */
  async function seriesAt(ref: SourceRef): Promise<number | null> {
    const r = await ask<{ mangas: { nodes: Array<{ id: number }> } }>(SERIES_AT, { source: ref.source, url: ref.url }, null);
    const first = r.mangas.nodes[0];
    if (!first) return null;
    return first.id;
  }

  /**
   * The number Suwayomi has a series by. One it hasn't, found on another Suwayomi, is taken in from
   * its site by its address first.
   */
  function localSeriesOf(ref: SourceRef): Promise<number> {
    if (ref.source === LOCAL) return Promise.reject(notFound());
    return localSeries.get(ref.series, async () => {
      const had = await seriesAt(ref);
      if (had !== null) return had;
      await bring(ref);
      const brought = await seriesAt(ref);
      if (brought === null) throw notFound();
      // Out of Suwayomi's library, which it would otherwise keep fetching from the site.
      await ask(OUT_OF_LIBRARY, { id: brought }, null);
      return brought;
    });
  }

  /** Series taken in one at a time, as Suwayomi restores one backup at a time. */
  function bring(ref: SourceRef): Promise<void> {
    const run = bringing.then(() => restore(ref));
    bringing = run.catch(() => {});
    return run;
  }

  /**
   * A series taken in by its source and address, as a backup of it alone (backupOf) restored: the
   * only way Suwayomi takes a series it didn't find itself. Its details come from the site when
   * it's first read.
   */
  async function restore(ref: SourceRef): Promise<void> {
    const form = new FormData();
    form.append('operations', JSON.stringify({ query: RESTORE, variables: { backup: null } }));
    form.append('map', JSON.stringify({ 0: ['variables.backup'] }));
    form.append('0', new Blob([backupOf(ref.source, ref.url)]), 'breader.tachibk');
    let id: string | null = null;
    try {
      const res = await fetchFn(`${base}/api/graphql`, { method: 'POST', headers: login, body: form, signal: AbortSignal.timeout(30_000) });
      const body = (await res.json()) as Reply<{ restoreBackup: { id: string } }>;
      if (body.data) id = body.data.restoreBackup.id;
    } catch (err) {
      log.warn({ err }, 'Suwayomi didn’t take a series in');
    }
    if (!id) throw unreachable();
    // It's done in a moment: asked every half a second, for half a minute at most.
    for (let i = 0; i < 60; i++) {
      const r = await ask<{ restoreStatus: { state: string } | null }>(RESTORED, { id }, null);
      const state = r.restoreStatus?.state;
      if (state === 'SUCCESS') return;
      if (state === 'FAILURE') throw notFound();
      await new Promise((done) => setTimeout(done, 500));
    }
    throw unreachable();
  }

  /** The number Suwayomi has a chapter by: its series' chapters fetched from the site first, when it hasn't it yet. */
  function localChapterOf(id: string, url: string, series: number, source: string): Promise<number> {
    return localChapters.get(id, async () => {
      const had = await chapterAt(series, url);
      if (had !== null) return had;
      await ask(CHAPTERS, { id: series }, source);
      const fetched = await chapterAt(series, url);
      if (fetched === null) throw notFound();
      return fetched;
    });
  }

  async function chapterAt(series: number, url: string): Promise<number | null> {
    const r = await ask<{ chapters: { nodes: Array<{ id: number }> } }>(CHAPTER_AT, { series, url }, null);
    const first = r.chapters.nodes[0];
    if (!first) return null;
    return first.id;
  }

  /** A series as its source tells it, kept a while. */
  function rawSeries(id: number, source: string): Promise<RawSeries> {
    return seriesMemo.get(String(id), async () => {
      const r = await ask<{ fetchManga: { manga: RawSeries } }>(SERIES, { id }, source);
      return r.fetchManga.manga;
    });
  }

  /** A series that can be shown at all, by what its id names, and the number Suwayomi has it by. */
  async function allowed(ref: SourceRef): Promise<{ m: RawSeries; local: number }> {
    const local = await localSeriesOf(ref);
    const m = await rawSeries(local, ref.source);
    if (neverGenre(m.genre)) throw notFound();
    return { m, local };
  }

  /** A chapter by its id: the number Suwayomi has it by, and its series' source. */
  async function chapterOfId(id: string): Promise<{ chapter: number; source: string }> {
    const ref = refOf(id);
    if (ref.chapter === null) throw notFound();
    const { local } = await allowed(ref);
    const chapter = await localChapterOf(id, ref.chapter, local, ref.source);
    return { chapter, source: ref.source };
  }

  async function chapterList(m: RawSeries, source: string): Promise<MangaChapter[]> {
    const list = await chapterLists.get(String(m.id), async () => {
      const r = await ask<{ fetchChapters: { chapters: RawChapter[] } }>(CHAPTERS, { id: m.id }, source);
      const raw = [...r.fetchChapters.chapters].sort(byNumber);
      const series = seriesId(source, m.url);
      return raw.map((c) => chapterOf(c, series));
    });
    // Out of the keeping, so lists kept before are cleaned too.
    return tidy(list);
  }

  /** Every chapter of the series can be read here, by its source's own list. Kept a day. */
  function readable(m: RawSeries, source: string): Promise<boolean> {
    return verdicts.get(String(m.id), async () => {
      const list = await chapterList(m, source);
      if (list.length === 0) return false;
      return caughtUp(cardOf(m, source).status, 0, firstMissing(list), highest(list));
    });
  }

  /** A chapter's pages. fresh: asked of the site again, whatever's kept. */
  function pageList(chapterId: number, source: string, fresh = false): Promise<string[]> {
    const make = async () => {
      const r = await ask<{ fetchChapterPages: { pages: string[] } }>(PAGES, { id: chapterId }, source);
      return r.fetchChapterPages.pages.filter((p) => PAGE_PATH.test(p));
    };
    return pageLists.get(String(chapterId), make, fresh);
  }

  /** A page of one of a source's lists, or of its results for a search, kept a while. */
  function listPage(source: RawSource, type: List | 'SEARCH', page: number, q = ''): Promise<SearchPage> {
    const key = [source.id, type, page, q].join(':');
    return searches.get(key, async () => {
      const input: Record<string, unknown> = { source: source.id, type, page };
      if (q) input.query = q;
      const r = await ask<{ fetchSourceManga: SearchPage }>(SEARCH, { input }, source.id);
      return r.fetchSourceManga;
    });
  }

  function searchPage(source: RawSource, w: Wanted, page: number): Promise<SearchPage> {
    if (w.q) return listPage(source, 'SEARCH', page, w.q);
    return listPage(source, listOf(source, w), page);
  }

  /** A series a search found, when it's one to show. */
  async function foundOf(x: Listed, source: RawSource, w: Wanted): Promise<Found | null> {
    localSeries.set(seriesId(source.id, x.url), x.id);
    const m = await rawSeries(x.id, source.id);
    if (neverGenre(m.genre)) return null;
    const card = cardOf(m, source.id);
    if (!wants(card, w)) return null;
    const ok = await readable(m, source.id);
    if (!ok) return null;
    return { item: { kind: 'source', source: source.name, card }, names: [m.title], people: people(m) };
  }

  /** A series a source lists, when it can be shown at all, whoever asks. */
  async function shelved(x: Listed, source: string): Promise<Shelved | null> {
    localSeries.set(seriesId(source, x.url), x.id);
    const m = await rawSeries(x.id, source);
    if (neverGenre(m.genre)) return null;
    if (!(await readable(m, source))) return null;
    return { card: cardOf(m, source), names: [m.title], people: people(m) };
  }

  async function shelfOf(source: string, list: List): Promise<Shelf | null> {
    const key = `${source}:${list}`;
    const had = shelves.get(key);
    if (had) return had;
    const kept = await shelfMemo.peek(key);
    if (!kept) return null;
    shelves.set(key, kept);
    return kept;
  }

  function putShelf(source: string, list: List, shelf: Shelf) {
    const key = `${source}:${list}`;
    shelves.set(key, shelf);
    shelfMemo.set(key, shelf);
  }

  /**
   * A source's list on its shelf, page by page down to SHELF series, each checked as a search would.
   * The first time, each page shows as soon as it's checked. Its first page not coming, the shelf
   * it had stays; a later one not coming, it ends there.
   */
  async function shelve(source: RawSource, list: List): Promise<Shelved[]> {
    const had = await shelfOf(source.id, list);
    const items: Shelved[] = [];
    const seen = new Set<number>();
    let looked = 0;
    let more: number | null = 1;
    while (more !== null && looked < SHELF) {
      const page: number = more;
      let listed: SearchPage;
      try {
        listed = await listPage(source, list, page);
      } catch (err) {
        if (page === 1) throw err;
        break;
      }
      looked += listed.mangas.length;
      const fresh = listed.mangas.filter((x) => !seen.has(x.id));
      for (const x of fresh) seen.add(x.id);
      // One that can't be checked now is left off until next time.
      const each = await inTurn(fresh, SHELVING, (x) => shelved(x, source.id).catch(() => null));
      for (const s of each) {
        if (s) items.push(s);
      }
      more = null;
      if (listed.hasNextPage && listed.mangas.length > 0) more = page + 1;
      if (!had && items.length > 0) putShelf(source.id, list, { items: [...items], more });
    }
    if (items.length > 0) putShelf(source.id, list, { items, more });
    return items;
  }

  /** A source's lists shelved, then the covers on them kept on disk, one at a time, as pages read come first. */
  async function shelveSource(source: RawSource) {
    const lists: List[] = ['POPULAR'];
    if (source.supportsLatest) lists.push('LATEST');
    const covers = new Set<string>();
    for (const list of lists) {
      try {
        for (const s of await shelve(source, list)) covers.add(s.card.id);
      } catch (err) {
        log.warn({ err, source: source.name, list }, 'a source’s list couldn’t be shelved');
      }
    }
    for (const id of covers) {
      if (await opts.covers.has(id)) continue;
      try {
        await coverOf(id, 512);
      } catch {
        // Fetched when a reader's Browse asks for it instead.
      }
    }
  }

  /**
   * Up to SHELF_LOT of a shelf's series a search wants, from the n-th on. Past the shelf, the list
   * carries on from the site, while it's quick enough to ask.
   */
  function shelfLot(source: RawSource, shelf: Shelf, w: Wanted, from: number): Lot {
    const found: Found[] = [];
    let i = from;
    while (i < shelf.items.length && found.length < SHELF_LOT) {
      const s = shelf.items[i];
      i += 1;
      if (!wants(s.card, w)) continue;
      found.push({ item: { kind: 'source', source: source.name, card: s.card }, names: s.names, people: s.people ?? [] });
    }
    let next: string | null = null;
    if (i < shelf.items.length) next = `s${i}`;
    else if (shelf.more !== null && speeds.quick(source.id, within)) next = String(shelf.more);
    return { found, next };
  }

  /** The sources a browse asks: those quick enough, or when not one is, the quickest. */
  function browsed(all: RawSource[]): RawSource[] {
    const quick = all.filter((s) => speeds.quick(s.id, within));
    if (quick.length > 0) return quick;
    if (all.length === 0) return [];
    let best = all[0];
    let bestMs = speeds.lotTime(best.id) ?? 0;
    for (const s of all) {
      const ms = speeds.lotTime(s.id) ?? 0;
      if (ms < bestMs) {
        best = s;
        bestMs = ms;
      }
    }
    return [best];
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

  /**
   * A search's next lot from a source. Browsing, from its shelf, where s40 is past its first 40;
   * otherwise from its site, timed by the calls it made of it.
   */
  async function lot(source: RawSource, w: Wanted, at: string): Promise<Lot> {
    if (!w.q && !w.names && (at === '0' || at.startsWith('s'))) {
      const shelf = await shelfOf(source.id, listOf(source, w));
      let from = 0;
      if (at.startsWith('s')) from = Number(at.slice(1));
      if (shelf) return shelfLot(source, shelf, w, from);
      // Its shelf is gone: the list from its start.
      at = '0';
    }
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
        foundOf(x, source, w).catch((e) => {
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

  /** A picture Suwayomi serves: a page, or a cover. */
  async function picture(path: string): Promise<Picture> {
    try {
      return await images.run(async () => {
        let data: Uint8Array | null = null;
        try {
          // Suwayomi may fetch it from the site first.
          const res = await fetchFn(`${base}${path}`, { headers: login, signal: AbortSignal.timeout(60_000) });
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

  async function coverOf(id: string, width: CoverWidth, early?: number): Promise<Cover> {
    const { local } = await allowed(refOf(id));
    return opts.covers.get(id, id, width, () => picture(`/api/v1/manga/${local}/thumbnail`), early);
  }

  return {
    async places(w) {
      let asked: RawSource[] = [];
      for (const s of await sources()) {
        if (w.lang && s.lang.toLowerCase() !== w.lang) continue;
        asked.push(s);
      }
      // Browsing, every source with a shelf, and of the rest only those quick enough (or the
      // quickest, when there's no shelf at all). A search by name asks every one.
      if (!w.q) {
        const withShelf: RawSource[] = [];
        const rest: RawSource[] = [];
        for (const s of asked) {
          if (await shelfOf(s.id, listOf(s, w))) withShelf.push(s);
          else rest.push(s);
        }
        let live = rest.filter((s) => speeds.quick(s.id, within));
        if (withShelf.length === 0) live = browsed(rest);
        asked = [...withShelf, ...live];
      }
      const out: Place[] = [];
      for (const s of asked) {
        out.push({ key: `sw${s.id}`, name: s.name, lot: (at) => lot(s, w, at) });
      }
      return out;
    },

    async warm() {
      if (warming) return;
      warming = true;
      try {
        const english = (await sources()).filter((s) => s.lang.toLowerCase() === 'en');
        // Brought up to date and waited for in turn, not all at once behind what's kept.
        await freshly(() => Promise.all(english.map((s) => shelveSource(s))));
      } catch (err) {
        log.warn({ err }, 'shelving the sources’ lists stopped');
      } finally {
        warming = false;
      }
    },

    async series(id, adult) {
      const ref = refOf(id);
      const { m } = await allowed(ref);
      const card = cardOf(m, ref.source);
      if (card.adult && !adult) throw adultOnly();
      let source = 'Suwayomi';
      if (m.source) source = m.source.name;
      return { ...card, source, authors: people(m), description: about(m), genres: m.genre, link: web(m.realUrl) };
    },

    async chapters(id) {
      const ref = refOf(id);
      const { m } = await allowed(ref);
      return { lang: await langOf(ref.source), chapters: await chapterList(m, ref.source) };
    },

    async pages(chapterId) {
      const { chapter, source } = await chapterOfId(chapterId);
      return (await pageList(chapter, source)).length;
    },

    async page(chapterId, n, quiet = false) {
      const { chapter, source } = await chapterOfId(chapterId);
      return opts.disk.keep(`sw-page:${chapterId}:${n}`, async () => {
        const paths = await pageList(chapter, source);
        try {
          if (n >= paths.length) throw noPage();
          return await picture(paths[n]);
        } catch (e) {
          if (e instanceof ApiError && e.code === 'manga_busy') throw e;
          // Its pages kept from a while ago, the site may have moved them since: asked again, once.
          const fresh = await pageList(chapter, source, true);
          if (n >= fresh.length) throw noPage();
          return picture(fresh[n]);
        }
      }, quiet);
    },

    cover: coverOf,
  };
}
