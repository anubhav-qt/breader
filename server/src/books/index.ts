import { BOOK_KINDS, CATALOGUE_URL, type BookFound, type BookFoundIn, type BookItem, type BookKind, type BookSearchResult, type BookSort, type BookSubject, type BookVolumeState } from '@breader/shared';
import { freshly, Memo, MemoryStore, type Store } from '../lib/cache.ts';
import { ApiError } from '../lib/errors.ts';
import { log } from '../log.ts';
import { Covers, webp, type Cover, type CoverWidth } from '../manga/covers.ts';
import { Disk, pictureType, type Picture } from '../manga/disk.ts';
import { DEADLINE, find, GRACE, type Place } from '../manga/find.ts';
import { inTurn } from '../manga/suwayomi.ts';
import { isZip, makeEpub, type EpubChapter } from './epub.ts';
import { makeGutenberg } from './gutendex.ts';
import { notFound } from './http.ts';
import { makeNovels, novelOf, type Novel, type Novels } from './novels.ts';
import { makeOpenLibrary } from './openlibrary.ts';
import { makeRanobe } from './ranobedb.ts';
import { wantedKind, type BookWanted } from './wanted.ts';

/*
 * Books through the laptop: one search across the novel sites (novels.ts), Project Gutenberg
 * (gutendex.ts) and Open Library (openlibrary.ts), found as manga are (find.ts), and each book's
 * volumes made into EPUBs to read: a novel's from its chapters, a hundred or so at a time, a whole
 * book's as it comes. A volume's EPUB is kept on disk with what it was made of, and made again
 * only when that's grown: an ongoing novel's last volume, as chapters come out. What a book in any
 * library has is kept for good (keeper.ts), every volume of it made ahead.
 */

export interface BookSearch {
  q?: string;
  lang?: string;
  sort?: BookSort;
  kinds?: BookKind[];
  subject?: BookSubject;
  names?: string[];
  next?: string;
}

/** A volume's EPUB, and how many chapters it holds (0 for a whole book). */
export interface VolumeFile {
  data: Uint8Array;
  chapters: number;
}

export interface Books {
  /** onSome: what's found so far, each time a place brings something, before the lot's whole. */
  search(q: BookSearch, onSome?: (items: BookFound[]) => void): Promise<BookSearchResult>;
  item(id: string): Promise<BookItem>;
  cover(id: string, width: CoverWidth, early?: number): Promise<Cover>;
  /** A volume's EPUB: ready, being made (from now, when it wasn't), or failed. */
  volume(id: string, n: number): Promise<BookVolumeState>;
  /** A volume's EPUB that's ready. */
  volumeFile(id: string, n: number): Promise<VolumeFile>;
  /** Ahead of readers: RanobeDB's list read, the novel sites' lists shelved, the books' first lists kept. */
  warm(): Promise<void>;
  /**
   * A book in a library kept for good: its cover and every volume made ahead, a novel's chapters
   * and pictures with them. Volumes made already cost nothing. Returns how many it has, and how
   * many were made just now.
   */
  keepBook(id: string, signal?: AbortSignal): Promise<{ volumes: number; made: number }>;
  /** Only these books' files kept for good (disk.ts keepOnly). Returns how many files went back. */
  keepOnly(ids: string[]): Promise<number>;
  kept(): Disk['size'];
}

export interface BooksOptions {
  /** Where volumes, chapters and covers are kept, up to so many bytes. */
  dir: string;
  cacheBytes: number;
  /** The novel host; without it, there are no novels. */
  novels?: string;
  fetch?: typeof fetch;
  /** Calls a window to each place. Tests go faster. */
  pace?: [number, number];
  store?: Store | null;
  /** Gutendex, or another of its kind. */
  gutendex?: string;
}

/** The most places one search asks: every novel site of a language, and the books' two. */
const MOST_PLACES = 200;
/** A novel's chapters fetched at once for a volume. */
const FETCHING = 2;
/** Tries at a chapter before its volume fails. */
const TRIES = 2;
/** How wide a chapter's pictures are kept: a page on a laptop at two pixels to the point. */
const PICTURE_WIDTH = 1600;
/** How long what a volume was made of is remembered: as long as it's kept. */
const BUILT_FOR = 10 * 365 * 24 * 3_600_000;

const novelsOff = () => new ApiError(404, 'book_not_found', 'Novels aren’t on, on this server.');
const notReady = () => new ApiError(409, 'book_not_ready', 'That volume isn’t ready yet.');

/** What the disk keeps: pictures, EPUBs, and chapters gzipped. */
export function bookFileType(b: Uint8Array): string | null {
  const pic = pictureType(b);
  if (pic) return pic;
  if (isZip(b)) return 'application/epub+zip';
  if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) return 'application/gzip';
  return null;
}

/** The book a library's url names (cat:pg:1342#v1-0), or null for any other. */
export function bookOfUrl(url: string): string | null {
  if (!CATALOGUE_URL.test(url)) return null;
  return url.slice('cat:'.length, url.indexOf('#'));
}

/** A chapter's page on its site, for the pictures it names by path. */
function pageOf(site: string, path: string): string | null {
  try {
    return new URL(path, site).href;
  } catch {
    return null;
  }
}

function messageOf(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return 'That volume couldn’t be made just now. Try again in a minute.';
}

/** What a volume is to be made of: a novel's chapters, or a whole book (0). */
interface Wanted {
  chapters: number;
  novel: Novel | null;
}

interface Making {
  done: number;
  total: number;
  /** Null once it's made, or why it couldn't be. */
  going: Promise<string | null>;
}

interface Built {
  chapters: number;
  bytes: number;
}

export function makeBooks(opts: BooksOptions): Books {
  const disk = new Disk(opts.dir, opts.cacheBytes, bookFileType);
  const store = opts.store ?? null;
  let kept: Store = new MemoryStore(20_000);
  if (store) kept = store;
  const covers = new Covers(disk, kept);
  const ranobe = makeRanobe({ store: kept, fetch: opts.fetch });
  const gutenberg = makeGutenberg({ covers, fetch: opts.fetch, pace: opts.pace, store, url: opts.gutendex });
  const openLibrary = makeOpenLibrary({ covers, fetch: opts.fetch, pace: opts.pace, store });
  let novels: Novels | null = null;
  if (opts.novels) novels = makeNovels({ url: opts.novels, disk, covers, ranobe, fetch: opts.fetch, pace: opts.pace, store });
  const built = new Memo<Built>(kept, 'books:v1:built', BUILT_FOR);
  const making = new Map<string, Making>();
  /** Why a volume a reader asked for couldn't be made, said once, then it's tried again. */
  const failures = new Map<string, string>();
  let warming = false;

  function novelsOn(): Novels {
    if (!novels) throw novelsOff();
    return novels;
  }

  function volumeKey(id: string, n: number) {
    return `vol:v1:${id}:${n}`;
  }

  /** What the volume is to be made of now. */
  async function wantedOf(id: string, n: number, novel?: Novel): Promise<Wanted> {
    if (!id.startsWith('nv:')) {
      if (n !== 1) throw notFound();
      return { chapters: 0, novel: null };
    }
    const found = novel ?? (await novelsOn().novel(id));
    const vol = found.volumes[n - 1];
    if (!vol) throw notFound();
    return { chapters: vol.chapters, novel: found };
  }

  /** What it was made of, when it's kept and made of what it's to be now. */
  async function readyOf(id: string, n: number, w: Wanted): Promise<Built | null> {
    const key = volumeKey(id, n);
    const b = await built.peek(key);
    if (!b || b.chapters !== w.chapters) return null;
    if (!(await disk.has(key))) return null;
    return b;
  }

  /** A chapter's picture, made WebP to keep, or null when it can't be had. */
  async function pictureFor(plugin: string, url: string, keepFor?: string): Promise<Picture | null> {
    const pic = await novelsOn().picture(plugin, url, keepFor);
    if (!pic) return null;
    return webp(pic, PICTURE_WIDTH);
  }

  async function chapterOf(plugin: string, path: string, keepFor?: string): Promise<string> {
    let last: unknown = null;
    for (let i = 0; i < TRIES; i++) {
      try {
        return await novelsOn().chapter(plugin, path, keepFor);
      } catch (err) {
        last = err;
      }
    }
    throw last;
  }

  /** A novel's volume as an EPUB, from its chapters. */
  async function novelVolume(id: string, n: number, novel: Novel, m: Making, keepFor?: string): Promise<Uint8Array> {
    const vol = novel.volumes[n - 1];
    const { plugin } = novelOf(id);
    const some = novel.chapters.slice(vol.from, vol.to);
    const chapters = await inTurn(some, FETCHING, async (c): Promise<EpubChapter> => {
      const html = await chapterOf(plugin, c.path, keepFor);
      m.done += 1;
      return { title: c.name, html, base: pageOf(novel.site, c.path) };
    });
    let cover: Picture | null = null;
    if (novel.cover) {
      try {
        cover = (await novelsOn().cover(id, 512)).pic;
      } catch {
        // Made without one.
      }
    }
    const item = novel.item;
    return makeEpub(
      {
        id: `cat:${id}#v${n}-${vol.chapters}`,
        title: `${item.title}: ${vol.title}`,
        series: item.title,
        index: n,
        authors: item.authors,
        lang: novel.lang,
        description: item.description,
        publisher: item.source,
        link: item.link,
        cover,
        chapters,
      },
      (url) => pictureFor(plugin, url, keepFor),
    );
  }

  /** A whole book's EPUB, as it comes. */
  function wholeBook(id: string): Promise<Uint8Array> {
    if (id.startsWith('pg:')) return gutenberg.file(Number(id.slice(3)));
    return openLibrary.file(id.slice(3));
  }

  async function make(id: string, n: number, w: Wanted, m: Making, keepFor?: string): Promise<void> {
    let data: Uint8Array;
    if (w.novel) data = await novelVolume(id, n, w.novel, m, keepFor);
    else data = await wholeBook(id);
    m.done = m.total;
    const key = volumeKey(id, n);
    await disk.put(key, data, keepFor);
    built.set(key, { chapters: w.chapters, bytes: data.byteLength });
  }

  /** The volume being made, from now when it wasn't, once however many ask for it. */
  function start(id: string, n: number, w: Wanted, keepFor?: string): Making {
    const key = volumeKey(id, n);
    const had = making.get(key);
    if (had) return had;
    let total = 1;
    if (w.novel) total = w.chapters;
    const m: Making = { done: 0, total, going: Promise.resolve(null) };
    m.going = make(id, n, w, m, keepFor)
      .then(() => null)
      .catch((err: unknown) => {
        log.warn({ err, book: id, volume: n }, 'a book’s volume couldn’t be made');
        const message = messageOf(err);
        failures.set(key, message);
        return message;
      })
      .finally(() => making.delete(key));
    making.set(key, m);
    return m;
  }

  async function coverOf(id: string, width: CoverWidth, early?: number): Promise<Cover> {
    if (id.startsWith('nv:')) return novelsOn().cover(id, width, early);
    if (id.startsWith('pg:')) return gutenberg.cover(Number(id.slice(3)), width, early);
    return openLibrary.cover(id.slice(3), width, early);
  }

  return {
    async search(q, onSome) {
      // In BOOK_KINDS' order, so the same ask is kept once.
      let kinds: BookKind[] = [...BOOK_KINDS];
      const asked = q.kinds;
      if (asked && asked.length > 0) kinds = BOOK_KINDS.filter((k) => asked.includes(k));
      const w: BookWanted = { lang: q.lang ?? 'en', kinds };
      if (q.q) w.q = q.q;
      if (q.sort) w.sort = q.sort;
      if (q.subject) w.subject = q.subject;
      if (q.names) w.names = q.names;
      const places: Place<BookFoundIn>[] = [];
      if (novels) {
        try {
          places.push(...(await novels.places(w)));
        } catch (err) {
          log.warn({ err }, 'the novel sites couldn’t be listed, so the search goes on without them');
        }
      }
      if (wantedKind('book', w)) {
        places.push(gutenberg.place(w));
        const ol = openLibrary.place(w);
        if (ol) places.push(ol);
      }
      // A sheet looking for its book's other copies waits for every place, as manga's does.
      let grace: number | null = GRACE;
      if (w.names) grace = null;
      return find(places, w.q, q.next, DEADLINE, grace, !w.names, onSome, MOST_PLACES);
    },

    async item(id) {
      if (id.startsWith('nv:')) return (await novelsOn().novel(id)).item;
      if (id.startsWith('pg:')) return gutenberg.item(Number(id.slice(3)));
      return openLibrary.item(id.slice(3));
    },

    cover: coverOf,

    async volume(id, n) {
      const key = volumeKey(id, n);
      const going = making.get(key);
      if (going) return { state: 'making', done: going.done, total: going.total };
      const failed = failures.get(key);
      if (failed !== undefined) {
        failures.delete(key);
        return { state: 'failed', message: failed };
      }
      const w = await wantedOf(id, n);
      const ready = await readyOf(id, n, w);
      if (ready) return { state: 'ready', bytes: ready.bytes };
      const m = start(id, n, w);
      return { state: 'making', done: m.done, total: m.total };
    },

    async volumeFile(id, n) {
      const key = volumeKey(id, n);
      const b = await built.peek(key);
      if (!b) throw notReady();
      const file = await disk.get(key);
      if (!file) throw notReady();
      return { data: file.data, chapters: b.chapters };
    },

    async warm() {
      if (warming) return;
      warming = true;
      try {
        await ranobe.refresh().catch((err: unknown) => log.warn({ err }, 'RanobeDB’s list couldn’t be read'));
        const going: Promise<void>[] = [];
        if (novels) going.push(novels.warm());
        going.push(freshly(() => gutenberg.warm()).catch((err: unknown) => log.warn({ err }, 'Gutenberg’s first list couldn’t be kept')));
        going.push(freshly(() => openLibrary.warm()).catch((err: unknown) => log.warn({ err }, 'Open Library’s first list couldn’t be kept')));
        await Promise.all(going);
      } finally {
        warming = false;
      }
    },

    async keepBook(id, signal) {
      try {
        await coverOf(id, 512);
        await covers.pin(id, id);
      } catch (err) {
        log.debug({ err, book: id }, 'a book’s cover couldn’t be kept');
      }
      let novel: Novel | undefined;
      let count = 1;
      if (id.startsWith('nv:')) {
        // Asked afresh, so new chapters are made into its volumes as they come out.
        novel = await freshly(() => novelsOn().novel(id));
        count = novel.volumes.length;
      }
      const out = { volumes: 0, made: 0 };
      for (let n = 1; n <= count; n++) {
        if (signal?.aborted) break;
        const w = await wantedOf(id, n, novel);
        const key = volumeKey(id, n);
        if (!(await readyOf(id, n, w))) {
          const failed = await start(id, n, w, id).going;
          if (failed !== null) throw new Error(failed);
          out.made += 1;
        }
        // Made for a reader meanwhile: kept for good all the same.
        await disk.pin(key, id);
        out.volumes += 1;
      }
      return out;
    },

    keepOnly: (ids) => disk.keepOnly(ids),
    kept: () => disk.size,
  };
}
