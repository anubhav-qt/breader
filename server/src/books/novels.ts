import { AsyncLocalStorage } from 'node:async_hooks';
import { gunzipSync, gzipSync } from 'node:zlib';
import { seriesName, type BookCard, type BookFoundIn, type BookItem } from '@breader/shared';
import { freshly, Memo, MemoryStore, type Store } from '../lib/cache.ts';
import { log } from '../log.ts';
import type { Cover, Covers, CoverWidth } from '../manga/covers.ts';
import { pictureType, type Disk, type Picture } from '../manga/disk.ts';
import { namedLike, wantedName, type Found, type Lot, type Place } from '../manga/find.ts';
import { Pace } from '../manga/pace.ts';
import { Speeds } from '../manga/speed.ts';
import { inTurn } from '../manga/suwayomi.ts';
import { busy, notFound, refused, unreachable } from './http.ts';
import type { Ranobe } from './ranobedb.ts';
import { chapterNumber, oldestFirst, plan, type Planned } from './volumes.ts';
import { novelAbout, novelsWanted, statusOf, wantedKind, type BookWanted } from './wanted.ts';

/*
 * Web and light novels from their sites, through LNReader's plugins in the novel host (novels/app.ts,
 * NOVELS_URL), as manga come from Suwayomi's sources (manga/suwayomi.ts): each plugin of the
 * language asked is a place a search looks (find.ts), and a novel shows only when its site gives
 * its newest chapter's text. Browsing reads a few sites' shelves, their Popular and Latest lists
 * checked ahead of readers (warm), so Browse opens without asking any site; a search by name asks
 * every site of its language that's up, checking only the novels going by what was searched for.
 * A novel RanobeDB knows by one of its names is a light novel, any other a web novel. Chapters'
 * text is kept on disk, gzipped, as manga's pages are.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** How long lists and verdicts are kept on past their time. */
const KEPT = 3 * DAY;
/** How long a novel and its chapters are kept on: one in a library is read again in a month too. */
const NOVEL_KEPT = 30 * DAY;
/** A plugin call waits this long for the host, which gives its own up after 90 s. */
const CALL_WAIT = 100_000;
/** Novels a lot looks at from a site's list. */
const LOT = 10;
/** How far down a site's list a shelf goes. */
const SHELF = 60;
/** The most novels a lot takes from each shelf. */
const SHELF_LOT = 12;
/** Novels checked at once for a shelf. */
const SHELVING = 2;
/** The sites browsed, their shelves made ahead (warm): those that answered well when tried. */
const SHELVED = ['novelbin', 'novelfire', 'readnovelfull', 'novelbuddy', 'novelcool', 'wuxiaworld', 'royalroad', 'scribblehub'];
/** How long a site that couldn't be searched is left out of searches. */
const DOWN_FOR = 6 * HOUR;
/** A list's pages asked at most, should a site go on giving its last one. */
const MOST_LIST_PAGES = 50;
/** A novel's chapter pages asked at most, for a site that lists them so. */
const MOST_CHAPTER_PAGES = 300;
/** A chapter's text shorter than this is a site's notice, not a chapter. */
const LEAST_TEXT = 200;
/** How long a lot it hasn't seen may take a site for it to be browsed past its shelf. */
const BROWSE_WITHIN = 25_000;
/** Plugins for machine translated novels, by their names. */
const MTL = /mtl|machine/i;
const MTL_IDS = new Set(['WTRLAB']);
/** The calls a lot is making of its site, counted as they're made, to time it by. */
const tally = new AsyncLocalStorage<{ calls: number }>();

interface RawPlugin {
  id: string;
  name: string;
  site: string;
  lang: string;
  version: string;
}
interface RawItem {
  name: string;
  path: string;
  cover: string | null;
}
interface RawChapter {
  name: string;
  path: string;
  number: number | null;
  page: string | null;
  at: string | null;
}
interface RawNovel extends RawItem {
  author: string;
  artist: string;
  status: string;
  genres: string;
  summary: string;
  chapters: RawChapter[];
  totalPages: number;
  link: string | null;
}

/** What a novel's check found, kept a day: whether it can be read here, and what its card shows. */
interface Checked {
  ok: boolean;
  title: string;
  /** Its cover on its site. */
  cover: string | null;
  authors: string[];
  status: BookCard['status'];
  genres: string[];
  chapters: number;
}

/** A site's lists Browse shows. */
type List = 'popular' | 'latest';

interface Shelved {
  path: string;
  checked: Checked;
}

/** One of a site's lists, as far as SHELF novels, in its order: only those that can be read. */
interface Shelf {
  items: Shelved[];
  /** The list's page after the last one shelved, or null when the list ended there. */
  more: number | null;
}

/** A chapter in reading order, with its number when it has one. */
export interface NovelChapter {
  name: string;
  path: string;
  number: number | null;
}

export interface Novel {
  item: BookItem;
  chapters: NovelChapter[];
  /** Its volumes and the chapters each holds (volumes.ts). */
  volumes: Planned[];
  /** Its cover on its site. */
  cover: string | null;
  /** Its site, that its chapters' paths are on. */
  site: string;
  /** Its site's language (en). */
  lang: string;
}

export interface Novels {
  /** A place for each site a search looks in. */
  places(w: BookWanted): Promise<Place<BookFoundIn>[]>;
  /** A novel (nv:<plugin>:<path>), its chapters and its volumes. */
  novel(id: string): Promise<Novel>;
  /** A chapter's HTML. keepFor: kept for good with that book's files (disk.ts pin). */
  chapter(plugin: string, path: string, keepFor?: string): Promise<string>;
  /** A picture in a chapter, or null when it can't be had. */
  picture(plugin: string, url: string, keepFor?: string): Promise<Picture | null>;
  cover(id: string, width: CoverWidth, early?: number): Promise<Cover>;
  /** Shelves the browsed sites' lists ahead of readers. */
  warm(): Promise<void>;
}

export interface NovelsOptions {
  /** The novel host. */
  url: string;
  disk: Disk;
  covers: Covers;
  ranobe: Ranobe;
  fetch?: typeof fetch;
  /** Calls a window to each site. Tests go faster. */
  pace?: [number, number];
  store?: Store | null;
}

/** A novel's id: its plugin, and its path there. */
export function novelId(plugin: string, path: string): string {
  return `nv:${plugin}:${Buffer.from(path).toString('base64url')}`;
}

/** The plugin and path an id names. */
export function novelOf(id: string): { plugin: string; path: string } {
  const m = /^nv:([\w.-]{1,40}):([\w-]{1,1400})$/.exec(id);
  if (!m) throw notFound();
  return { plugin: m[1], path: Buffer.from(m[2], 'base64url').toString() };
}

/** Machine translated, by its plugin. */
function mtlOf(p: RawPlugin): boolean {
  if (MTL_IDS.has(p.id)) return true;
  return MTL.test(p.id) || MTL.test(p.name);
}

function listOf(s: string): string[] {
  const out: string[] = [];
  for (const part of s.split(/[,;]/)) {
    const t = part.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** The text of a chapter's HTML, roughly: enough to tell a chapter from a site's notice. */
function textLength(html: string): number {
  return html.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().length;
}

export function makeNovels(opts: NovelsOptions): Novels {
  const fetchFn = opts.fetch ?? fetch;
  const base = opts.url.replace(/\/+$/, '');
  const [count, per] = opts.pace ?? [4, 1000];
  const paces = new Map<string, Pace>();
  const speeds = new Speeds();
  /** Sites a search couldn't ask, and until when they're left out. */
  const down = new Map<string, number>();
  let warming = false;

  function memo<T>(kind: string, ttl: number, max: number, keep = ttl): Memo<T> {
    let store: Store;
    if (opts.store) store = opts.store;
    else store = new MemoryStore(max);
    return new Memo<T>(store, `books:v1:nv-${kind}`, ttl, keep);
  }
  const pluginList = memo<RawPlugin[]>('plugins', 10 * MINUTE, 1, KEPT);
  const lists = memo<RawItem[]>('list', 10 * MINUTE, 300, KEPT);
  const novels = memo<RawNovel>('novel', 30 * MINUTE, 2000, NOVEL_KEPT);
  const chapterPages = memo<RawChapter[]>('chapters', 30 * MINUTE, 300, NOVEL_KEPT);
  const verdicts = memo<Checked>('readable', DAY, 20_000, KEPT);
  const shelfMemo = memo<Shelf>('shelf', KEPT, 50);
  const shelves = new Map<string, Shelf>();

  function paceOf(plugin: string): Pace {
    let pace = paces.get(plugin);
    if (!pace) {
      pace = new Pace(count, per, 20_000);
      paces.set(plugin, pace);
    }
    return pace;
  }

  /** A call to the host, taking a turn from the site it asks of. */
  async function call(path: string, params: Record<string, string>, plugin: string | null): Promise<Response> {
    if (plugin !== null) {
      try {
        await paceOf(plugin).take();
      } catch {
        throw busy();
      }
      const counting = tally.getStore();
      if (counting) counting.calls += 1;
    }
    let res: Response;
    try {
      res = await fetchFn(`${base}${path}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(CALL_WAIT) });
    } catch (err) {
      log.warn({ err }, 'the novel host didn’t answer');
      throw unreachable();
    }
    if (res.ok) return res;
    if (res.status === 404 || res.status === 400) throw notFound();
    if (res.status === 504) throw unreachable();
    throw refused();
  }

  async function ask<T>(path: string, params: Record<string, string>, plugin: string | null): Promise<T> {
    const res = await call(path, params, plugin);
    return (await res.json()) as T;
  }

  const plugins = () => pluginList.get('all', () => ask<RawPlugin[]>('/plugins', {}, null));

  async function pluginOf(id: string): Promise<RawPlugin> {
    const all = await plugins();
    const p = all.find((x) => x.id === id);
    if (!p) throw notFound();
    return p;
  }

  /** A page of a site's list, or of what it found for a search, kept a while. */
  function listPage(plugin: string, list: List | 'search', page: number, q = ''): Promise<RawItem[]> {
    const key = [plugin, list, page, q].join(':');
    return lists.get(key, async () => {
      let r: { novels: RawItem[] };
      if (list === 'search') r = await ask('/search', { plugin, q, page: String(page) }, plugin);
      else if (list === 'latest') r = await ask('/popular', { plugin, page: String(page), latest: '1' }, plugin);
      else r = await ask('/popular', { plugin, page: String(page) }, plugin);
      return r.novels;
    });
  }

  function rawNovel(plugin: string, path: string): Promise<RawNovel> {
    return novels.get(`${plugin}:${path}`, () => ask<RawNovel>('/novel', { plugin, path }, plugin));
  }

  /** A page of a novel's chapters, for a site that lists them so. */
  async function pageOfChapters(plugin: string, path: string, page: number): Promise<RawChapter[]> {
    const r = await ask<{ chapters: RawChapter[] }>('/chapters', { plugin, path, page: String(page) }, plugin);
    return r.chapters;
  }

  /** Every chapter of a novel, in reading order. */
  async function allChapters(plugin: string, path: string): Promise<NovelChapter[]> {
    const n = await rawNovel(plugin, path);
    let raw = n.chapters;
    if (n.totalPages > 1) {
      raw = await chapterPages.get(`${plugin}:${path}`, async () => {
        const all = [...n.chapters];
        const seen = new Set(all.map((c) => c.path));
        const last = Math.min(n.totalPages, MOST_CHAPTER_PAGES);
        for (let page = 2; page <= last; page++) {
          for (const c of await pageOfChapters(plugin, path, page)) {
            if (seen.has(c.path)) continue;
            seen.add(c.path);
            all.push(c);
          }
        }
        return all;
      });
    }
    const chapters: NovelChapter[] = [];
    for (const c of raw) {
      if (!c.path) continue;
      chapters.push({ name: c.name || 'Chapter', path: c.path, number: chapterNumber(c.name, c.number) });
    }
    return oldestFirst(chapters);
  }

  function chapterKey(plugin: string, path: string) {
    return `nv-chapter:${plugin}:${path}`;
  }

  /** A chapter's HTML: kept, gzipped, once it's a chapter's worth of text. */
  async function chapterHtml(plugin: string, path: string, keepFor?: string): Promise<string> {
    const key = chapterKey(plugin, path);
    const kept = await opts.disk.get(key);
    if (kept) {
      if (keepFor) await opts.disk.pin(key, keepFor);
      return gunzipSync(kept.data).toString();
    }
    const r = await ask<{ html: string }>('/chapter', { plugin, path }, plugin);
    if (textLength(r.html) >= LEAST_TEXT) await opts.disk.put(key, gzipSync(r.html), keepFor);
    return r.html;
  }

  /** A picture from a site, through the host. */
  async function image(plugin: string, url: string): Promise<Picture> {
    const res = await call('/image', { plugin, url }, plugin);
    const data = new Uint8Array(await res.arrayBuffer());
    const type = pictureType(data);
    if (!type) throw refused();
    return { data, type };
  }

  /**
   * Whether a novel can be read here, kept a day: it has chapters, and its site gives its newest
   * one's text. Its card's details come with it.
   */
  function checked(plugin: string, path: string): Promise<Checked> {
    return verdicts.get(`${plugin}:${path}`, async () => {
      const n = await rawNovel(plugin, path);
      let chapters = n.chapters;
      let count = chapters.length;
      if (n.totalPages > 1) {
        // Its last page has its newest, and says about how many there are.
        const last = await pageOfChapters(plugin, path, Math.min(n.totalPages, MOST_CHAPTER_PAGES));
        count = (n.totalPages - 1) * n.chapters.length + last.length;
        chapters = last;
      }
      const ordered = oldestFirst(chapters.map((c) => ({ ...c, number: chapterNumber(c.name, c.number) })));
      const newest = ordered[ordered.length - 1];
      let ok = false;
      if (newest) {
        const html = await chapterHtml(plugin, newest.path);
        ok = textLength(html) >= LEAST_TEXT;
      }
      const authors = listOf(n.author);
      return { ok, title: n.name, cover: n.cover, authors, status: statusOf(n.status), genres: listOf(n.genres), chapters: count };
    });
  }

  /** A novel's names: its own, and RanobeDB's for it. */
  function namesOf(title: string): { names: string[]; ranobe: number | null } {
    const keys = [seriesName(title).key];
    const ranobe = opts.ranobe.seriesOf(keys);
    const names = [title];
    if (ranobe !== null) {
      for (const n of opts.ranobe.namesOf(ranobe)) {
        if (!names.includes(n)) names.push(n);
      }
    }
    return { names, ranobe };
  }

  function cardOf(p: RawPlugin, path: string, c: Checked): BookCard {
    const id = novelId(p.id, path);
    let cover: string | null = null;
    if (c.cover) cover = `/v1/catalogue/item/${id}/cover`;
    // Not known until RanobeDB's list is read.
    let kind: BookCard['kind'] = null;
    if (opts.ranobe.ready()) {
      kind = 'web';
      if (namesOf(c.title).ranobe !== null) kind = 'light';
    }
    return { id, title: c.title, cover, authors: c.authors, status: c.status, kind, side: false, mtl: mtlOf(p), chapters: c.chapters, year: null };
  }

  /** A novel a search wants, by what its check found. */
  function wanted(card: BookCard, c: Checked, w: BookWanted): boolean {
    if (!wantedKind(card.kind, w)) return false;
    return novelAbout(c.genres, w);
  }

  function foundOf(p: RawPlugin, path: string, c: Checked): Found<BookFoundIn> {
    return { item: { source: p.name, card: cardOf(p, path, c) }, names: namesOf(c.title).names };
  }

  async function shelfOf(plugin: string, list: List): Promise<Shelf | null> {
    const key = `${plugin}:${list}`;
    const had = shelves.get(key);
    if (had) return had;
    const kept = await shelfMemo.peek(key);
    if (!kept) return null;
    shelves.set(key, kept);
    return kept;
  }

  function putShelf(plugin: string, list: List, shelf: Shelf) {
    const key = `${plugin}:${list}`;
    shelves.set(key, shelf);
    shelfMemo.set(key, shelf);
  }

  /** A site's list on its shelf, page by page down to SHELF novels, each checked as a search would. */
  async function shelve(p: RawPlugin, list: List): Promise<Shelved[]> {
    const had = await shelfOf(p.id, list);
    const items: Shelved[] = [];
    const seen = new Set<string>();
    let looked = 0;
    let more: number | null = 1;
    while (more !== null && looked < SHELF) {
      const page: number = more;
      let listed: RawItem[];
      try {
        listed = await listPage(p.id, list, page);
      } catch (err) {
        if (page === 1) throw err;
        break;
      }
      looked += listed.length;
      const fresh = listed.filter((x) => !seen.has(x.path));
      for (const x of listed) seen.add(x.path);
      // One that can't be checked now is left off until next time.
      const each = await inTurn(fresh, SHELVING, (x) => checked(p.id, x.path).catch(() => null));
      for (let i = 0; i < fresh.length; i++) {
        const c = each[i];
        if (c && c.ok) items.push({ path: fresh[i].path, checked: c });
      }
      more = null;
      // A page with nothing new on it: the list ended at the one before.
      if (fresh.length > 0 && page < MOST_LIST_PAGES) more = page + 1;
      if (!had && items.length > 0) putShelf(p.id, list, { items: [...items], more });
    }
    if (items.length > 0) putShelf(p.id, list, { items, more });
    return items;
  }

  /** A site's lists shelved, then their covers kept, one at a time. */
  async function shelveSite(p: RawPlugin) {
    const paths = new Set<string>();
    for (const list of ['popular', 'latest'] as const) {
      try {
        for (const s of await shelve(p, list)) {
          if (s.checked.cover) paths.add(s.path);
        }
      } catch (err) {
        log.warn({ err, site: p.name, list }, 'a site’s list couldn’t be shelved');
      }
    }
    for (const path of paths) {
      const id = novelId(p.id, path);
      if (await opts.covers.has(id)) continue;
      try {
        await coverOf(id, 512);
      } catch {
        // Fetched when a reader's Browse asks for it instead.
      }
    }
  }

  function shelfLot(p: RawPlugin, shelf: Shelf, w: BookWanted, from: number): Lot<BookFoundIn> {
    const found: Found<BookFoundIn>[] = [];
    let i = from;
    while (i < shelf.items.length && found.length < SHELF_LOT) {
      const s = shelf.items[i];
      i += 1;
      const f = foundOf(p, s.path, s.checked);
      if (!wanted(f.item.card, s.checked, w)) continue;
      found.push(f);
    }
    let next: string | null = null;
    if (i < shelf.items.length) next = `s${i}`;
    else if (shelf.more !== null && speeds.quick(p.id, BROWSE_WITHIN)) next = String(shelf.more);
    return { found, next };
  }

  function listFor(w: BookWanted): List {
    if (w.sort === 'latest') return 'latest';
    return 'popular';
  }

  /** Up to LOT of a site's results, from where the search had got to (3.10: page 3, its first ten looked at). */
  async function lotFrom(p: RawPlugin, w: BookWanted, at: string): Promise<Lot<BookFoundIn>> {
    let page = Number(at);
    let seen = 0;
    const dot = at.indexOf('.');
    if (dot !== -1) {
      page = Number(at.slice(0, dot));
      seen = Number(at.slice(dot + 1));
    }
    if (page < 1) page = 1;
    let listed: RawItem[];
    try {
      if (w.q) listed = await listPage(p.id, 'search', page, w.q);
      else listed = await listPage(p.id, listFor(w), page);
    } catch (err) {
      if (page === 1 && w.q) down.set(p.id, Date.now() + DOWN_FOR);
      throw err;
    }
    // A site giving its last page again for any after it: the list ended.
    if (page > 1 && listed.length > 0) {
      const before = await listPage(p.id, w.q ? 'search' : listFor(w), page - 1, w.q ?? '').catch(() => [] as RawItem[]);
      const paths = new Set(before.map((x) => x.path));
      if (listed.every((x) => paths.has(x.path))) return { found: [], next: null };
    }
    const some = listed.slice(seen, seen + LOT);
    // Only those going by what was searched for are checked, as a site's search turns up much else.
    // Looking for one book's copies, its names say which, RanobeDB's other names among them.
    const named = some.filter((x) => {
      if (w.names) return wantedName([x.name], w);
      if (w.q) return namedLike(w.q, [seriesName(x.name).key]);
      return true;
    });
    let failed: unknown = null;
    const each = await Promise.all(
      named.map((x) =>
        checked(p.id, x.path).catch((e) => {
          failed = e;
          return null;
        }),
      ),
    );
    const found: Found<BookFoundIn>[] = [];
    for (let i = 0; i < named.length; i++) {
      const c = each[i];
      if (!c || !c.ok) continue;
      const f = foundOf(p, named[i].path, c);
      if (wanted(f.item.card, c, w)) found.push(f);
    }
    if (found.length === 0 && failed) throw failed;
    const looked = seen + some.length;
    let next: string | null = null;
    if (looked < listed.length) next = `${page}.${looked}`;
    else if (listed.length > 0 && page < MOST_LIST_PAGES) next = String(page + 1);
    return { found, next };
  }

  async function lot(p: RawPlugin, w: BookWanted, at: string): Promise<Lot<BookFoundIn>> {
    if (!w.q && !w.names && (at === '0' || at.startsWith('s'))) {
      const shelf = await shelfOf(p.id, listFor(w));
      let from = 0;
      if (at.startsWith('s')) from = Number(at.slice(1));
      if (shelf) return shelfLot(p, shelf, w, from);
      at = '0';
    }
    const made = { calls: 0 };
    const started = Date.now();
    const answer = await tally.run(made, () => lotFrom(p, w, at));
    speeds.took(p.id, Date.now() - started, made.calls);
    return answer;
  }

  async function coverOf(id: string, width: CoverWidth, early?: number): Promise<Cover> {
    const { plugin, path } = novelOf(id);
    const c = await checked(plugin, path);
    const url = c.cover;
    if (!url) throw notFound();
    return opts.covers.get(id, id, width, () => image(plugin, url), early);
  }

  return {
    async places(w) {
      if (!novelsWanted(w)) return [];
      const now = Date.now();
      let asked: RawPlugin[] = [];
      for (const p of await plugins()) {
        if (p.lang !== w.lang) continue;
        const until = down.get(p.id) ?? 0;
        if (until > now) continue;
        asked.push(p);
      }
      // Browsing, the sites with shelves; with none yet, those meant to have them.
      if (!w.q) {
        const withShelf: RawPlugin[] = [];
        for (const p of asked) {
          if (await shelfOf(p.id, listFor(w))) withShelf.push(p);
        }
        if (withShelf.length > 0) asked = withShelf;
        else asked = asked.filter((p) => SHELVED.includes(p.id));
      }
      const out: Place<BookFoundIn>[] = [];
      for (const p of asked) {
        out.push({ key: `nv-${p.id}`, name: p.name, lot: (at) => lot(p, w, at) });
      }
      return out;
    },

    async novel(id) {
      const { plugin, path } = novelOf(id);
      const p = await pluginOf(plugin);
      const [n, c, chapters] = await Promise.all([rawNovel(plugin, path), checked(plugin, path), allChapters(plugin, path)]);
      const card = cardOf(p, path, { ...c, chapters: chapters.length });
      const volumes = plan(chapters, card.status);
      let ranobe: string | null = null;
      const r = namesOf(n.name).ranobe;
      if (r !== null) ranobe = `https://ranobedb.org/series/${r}`;
      const item: BookItem = {
        ...card,
        source: p.name,
        description: n.summary,
        genres: c.genres,
        link: n.link,
        volumes: volumes.map((v) => ({ n: v.n, title: v.title, chapters: v.chapters, first: v.first, last: v.last, open: v.open })),
        ranobe,
      };
      return { item, chapters, volumes, cover: c.cover, site: p.site, lang: p.lang };
    },

    chapter: chapterHtml,

    async picture(plugin, url, keepFor) {
      const key = `nv-image:${plugin}:${url}`;
      try {
        const pic = await opts.disk.keep(key, () => image(plugin, url));
        if (keepFor) await opts.disk.pin(key, keepFor);
        return pic;
      } catch {
        return null;
      }
    },

    cover: coverOf,

    async warm() {
      if (warming) return;
      warming = true;
      try {
        const all = await plugins();
        const browsed = all.filter((p) => SHELVED.includes(p.id));
        await freshly(() => Promise.all(browsed.map((p) => shelveSite(p))));
      } catch (err) {
        log.warn({ err }, 'shelving the novel sites’ lists stopped');
      } finally {
        warming = false;
      }
    },
  };
}
