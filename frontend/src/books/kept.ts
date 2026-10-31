import { useEffect, useState } from 'react';
import { createStore, del, get, keys, set } from 'idb-keyval';
import { flush } from '../data/sync';
import { ApiError } from '../lib/api';
import { mangadex, readMangaPrefs, sources } from '../lib/mangadex';
import { filesOf, typeOf, type Page } from './manga';
import type { RemoteChapter } from './types';

/*
 * Manga chapters kept to read offline (books/remote.ts): each chapter a CBZ in this browser, in a
 * database of their own, as they're many and big, with a note per series of the chapters kept. Its
 * pages are kept one by one while it comes, then packed into the CBZ and read from that in place.
 * Chapters kept before that, a page each, still read as they were. Bytes, not Blobs, as Safari on
 * iPhone can lose a Blob kept in IndexedDB (lib/store.ts). A series taken out of the library lets go
 * of its chapters the next time the app opens (sweepKept), so taking it out can still be undone.
 */

let db: ReturnType<typeof createStore> | null = null;
try {
  db = createStore('breader-manga', 'pages');
} catch {
  db = null;
}

interface Bytes { bytes: ArrayBuffer; type: string }
/**
 * A series' chapters kept here, by chapter id: their pages, their size, and whether they're all in.
 * Their label and number, as saving them in order needs them without the laptop (not on those kept
 * before that was noted).
 */
export type Kept = Record<string, { pages: number; bytes: number; done: boolean; label?: string; number?: number | null }>;

const pageKey = (chapter: string, n: number) => `${chapter}:${n}`;
const cbzKey = (chapter: string) => `cbz:${chapter}`;
const noteKey = (series: string) => `series:${series}`;

const CBZ = 'application/vnd.comicbook+zip';
const EXTENSIONS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };

/** Page n of `of` in a chapter's CBZ: "007.jpg", numbered so the names sort in reading order. */
export function pageName(n: number, of: number, type: string): string {
  return `${String(n + 1).padStart(Math.max(3, String(of).length), '0')}.${EXTENSIONS[type] ?? 'jpg'}`;
}

/** A chapter's CBZ and its pages in order, or null when it isn't kept as one. */
interface Opened { blob: Blob; pages: Page[] }

/** The few CBZs read last, listed once: the next page of one is asked for straight after this one. */
const OPEN = 4;
const opened = new Map<string, Promise<Opened | null>>();

async function readCbz(chapter: string, store: NonNullable<typeof db>): Promise<Opened | null> {
  const v = await get<Bytes | Blob>(cbzKey(chapter), store);
  if (!v) return null;
  const blob = v instanceof Blob ? v : new Blob([v.bytes], { type: v.type });
  const pages = (await filesOf(blob)).filter((f) => typeOf(f.name)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { blob, pages };
}

function cbzOf(chapter: string): Promise<Opened | null> {
  if (!db) return Promise.resolve(null);
  let o = opened.get(chapter);
  if (o) opened.delete(chapter);
  else {
    const read = readCbz(chapter, db);
    // One that wouldn't read is tried again next time.
    read.catch(() => { if (opened.get(chapter) === read) opened.delete(chapter); });
    o = read;
  }
  opened.set(chapter, o);
  if (opened.size > OPEN) opened.delete(opened.keys().next().value!);
  return o;
}

/** A chapter's CBZ, if it's kept as one. */
export async function keptCbz(chapter: string): Promise<Blob | undefined> {
  try {
    return (await cbzOf(chapter))?.blob;
  } catch {
    return undefined;
  }
}

/** Page n of a chapter kept here, if it is. */
export async function keptPage(chapter: string, n: number): Promise<Blob | undefined> {
  if (!db) return undefined;
  try {
    const cbz = await cbzOf(chapter);
    if (cbz) return cbz.pages[n]?.read(typeOf(cbz.pages[n].name)!);
    const v = await get<Bytes>(pageKey(chapter, n), db);
    return v ? new Blob([v.bytes], { type: v.type }) : undefined;
  } catch {
    return undefined;
  }
}

/** A chapter on one of Breader's Suwayomi sources (sw:…), not on MangaDex. */
const onSource = (chapter: string) => chapter.startsWith('sw:');

/** A page through the laptop: from a source as it is, or from MangaDex, smaller with data saver on. */
function askPage(chapter: string, n: number): Promise<Blob> {
  if (onSource(chapter)) return sources.page(chapter, n);
  return mangadex.page(chapter, n, readMangaPrefs().saver);
}

async function fetchPage(chapter: string, n: number): Promise<Blob> {
  try {
    return await askPage(chapter, n);
  } catch (e) {
    // A library made in this browser a moment ago may not be signed in yet: its first sync does it.
    if (!(e instanceof ApiError && e.code === 'signed_out')) throw e;
    await flush();
    return askPage(chapter, n);
  }
}

/** A page to read: kept here, or through the laptop. */
export async function pageFor(chapter: string, n: number): Promise<Blob> {
  return (await keptPage(chapter, n)) ?? fetchPage(chapter, n);
}

/** A chapter's pages: as kept here, or as its source counts them. A library made a moment ago signs in with its first sync. */
export async function countPages(chapter: string): Promise<number> {
  const cbz = await cbzOf(chapter).catch(() => null);
  if (cbz) return cbz.pages.length;
  try {
    return await sources.pages(chapter);
  } catch (e) {
    if (!(e instanceof ApiError && e.code === 'signed_out')) throw e;
    await flush();
    return sources.pages(chapter);
  }
}

/** A series' chapters kept here. */
export const keptNote = (series: string) => noteOf(series);

async function noteOf(series: string): Promise<Kept> {
  if (!db) return {};
  try {
    return (await get<Kept>(noteKey(series), db)) ?? {};
  } catch {
    return {};
  }
}

/** A chapter's pages as one CBZ, kept. The pictures are packed already, so they're only stored in it. Its size. */
async function pack(chapter: string, pages: Blob[], store: NonNullable<typeof db>): Promise<number> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  pages.forEach((p, n) => zip.file(pageName(n, pages.length, p.type), p));
  const cbz = await zip.generateAsync({ type: 'blob', compression: 'STORE', mimeType: CBZ });
  await set(cbzKey(chapter), { bytes: await cbz.arrayBuffer(), type: CBZ } satisfies Bytes, store);
  opened.delete(chapter);
  return cbz.size;
}

/** Lets go of a chapter's pages kept one by one. */
async function dropPages(chapter: string, pages: number, store: NonNullable<typeof db>) {
  for (let n = 0; n < pages; n++) await del(pageKey(chapter, n), store).catch(() => {});
}

/* ---- Keeping chapters, one page at a time, in the background ---- */

export interface Keeping {
  series: string;
  chapter: string;
  label: string;
  done: number;
  of: number;
}

let queue: Array<{ series: string; chapter: RemoteChapter }> = [];
let now: Keeping | null = null;
let failed: string | null = null;
/** The device ran out of room for more: nothing more is kept until the reader makes some. */
let full = false;
let stopped = false;
/** Chapters that wouldn't come, one after another: past GIVE_UP, the rest wait for another try too. */
let missed = 0;
/** A chapter that won't come is passed over; this many in a row, and the site or the laptop is likely down. */
const GIVE_UP = 3;
/** Series let go of while one of their chapters was being kept: what it brought goes too. */
const gone = new Set<string>();
const listeners = new Set<() => void>();
const tell = () => listeners.forEach((l) => l());

async function run() {
  if (now || !db) return;
  const store = db;
  while (queue.length && !stopped) {
    const { series, chapter } = queue.shift()!;
    const note = await noteOf(series);
    if (note[chapter.id]?.done) continue;
    now = { series, chapter: chapter.id, label: chapter.label, done: 0, of: chapter.pages };
    tell();
    let bytes = 0;
    try {
      // A source's chapter not opened yet: counted first.
      let pages = chapter.pages;
      if (!pages && onSource(chapter.id)) pages = await countPages(chapter.id);
      if (!pages) throw new Error(`${chapter.label} has no pages to keep.`);
      now = { ...now, of: pages };
      const label = { label: chapter.label, number: chapter.number };
      note[chapter.id] = { pages, bytes: note[chapter.id]?.bytes ?? 0, done: false, ...label };
      await set(noteKey(series), note, store);
      tell();
      const got: Blob[] = [];
      for (let n = 0; n < pages; n++) {
        if (stopped) break;
        let blob = await keptPage(chapter.id, n);
        if (!blob) {
          // Once more, then it waits for another try.
          const get = () => fetchPage(chapter.id, n);
          blob = await get().catch(get);
          await set(pageKey(chapter.id, n), { bytes: await blob.arrayBuffer(), type: blob.type } satisfies Bytes, store);
        }
        bytes += blob.size;
        got.push(blob);
        now = { ...now, done: n + 1 };
        tell();
      }
      if (gone.delete(series)) {
        await dropPages(chapter.id, pages, store);
        continue;
      }
      // All in: packed into the CBZ, and the pages kept one by one, for stopping and starting again, let go.
      if (!stopped) {
        bytes = await pack(chapter.id, got, store);
        await dropPages(chapter.id, pages, store);
      }
      const after = await noteOf(series);
      after[chapter.id] = { pages, bytes, done: !stopped, ...label };
      await set(noteKey(series), after, store);
      missed = 0;
    } catch (e) {
      if (outOfRoom(e)) {
        full = true;
        queue = [];
        continue;
      }
      failed = e instanceof Error ? e.message : 'A page wouldn’t come.';
      missed += 1;
      if (missed >= GIVE_UP) queue = [];
    }
  }
  now = null;
  stopped = false;
  missed = 0;
  tell();
}

/** The browser's room for what it keeps is used up, or the device's memory for packing a chapter. */
export function outOfRoom(e: unknown): boolean {
  if (e instanceof RangeError) return true;
  return e instanceof DOMException && e.name === 'QuotaExceededError';
}

/** What the reader's told when the device is out of room: to save what's here to it, then let it go. */
export const FULL = 'This device is out of room. Save what’s downloaded as a CBZ or PDF, then remove it here to make room.';

/**
 * Keeps these chapters of a series here, after any already being kept. A source's chapter not
 * opened yet (no pages) is counted when its turn comes.
 */
export function keepChapters(series: string, chapters: RemoteChapter[]) {
  failed = null;
  full = false;
  const queued = new Set(queue.map((q) => q.chapter.id));
  for (const c of chapters) {
    if (!(c.pages > 0 || onSource(c.id)) || queued.has(c.id) || now?.chapter === c.id) continue;
    queue.push({ series, chapter: c });
    queued.add(c.id);
  }
  tell();
  void run();
}

/** Stops keeping: the chapter under way is left part kept, to finish another time. */
export function stopKeeping() {
  queue = [];
  if (now) stopped = true;
  tell();
}

/** Lets go of a series' kept chapters: all of them, or those named. */
export async function letGo(series: string, chapters?: string[]) {
  if (!db) return;
  const store = db;
  if (now?.series === series) {
    gone.add(series);
    stopKeeping();
  }
  queue = queue.filter((q) => q.series !== series);
  const note = await noteOf(series);
  for (const [id, c] of Object.entries(note)) {
    if (chapters && !chapters.includes(id)) continue;
    await dropPages(id, c.pages, store);
    await del(cbzKey(id), store).catch(() => {});
    opened.delete(id);
    delete note[id];
  }
  if (Object.keys(note).length) await set(noteKey(series), note, store);
  else await del(noteKey(series), store).catch(() => {});
  tell();
}

/** Series no longer in the library let go of what they kept. */
export async function sweepKept(live: ReadonlySet<string>) {
  if (!db) return;
  try {
    const all = (await keys(db)).map(String).filter((k) => k.startsWith('series:'));
    for (const k of all) {
      const series = k.slice('series:'.length);
      if (!live.has(series)) await letGo(series);
    }
  } catch {
    // Nothing kept, or nothing to read it with.
  }
}

/** What a series has kept here, and what's being kept now. */
export function useKept(series: string | undefined) {
  const [kept, setKept] = useState<Kept>({});
  const [state, setState] = useState<{ now: Keeping | null; queued: number; failed: string | null; full: boolean }>({ now: null, queued: 0, failed: null, full: false });
  useEffect(() => {
    if (!series) return;
    let live = true;
    const update = () => {
      void noteOf(series).then((k) => { if (live) setKept(k); });
      setState({ now: now?.series === series ? now : null, queued: queue.filter((q) => q.series === series).length, failed, full });
    };
    update();
    listeners.add(update);
    return () => { live = false; listeners.delete(update); };
  }, [series]);
  return { kept, ...state };
}
