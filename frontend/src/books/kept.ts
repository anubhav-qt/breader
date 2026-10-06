import { useEffect, useState } from 'react';
import { createStore, del, get, keys, set } from 'idb-keyval';
import { flush } from '../data/sync';
import { ApiError } from '../lib/api';
import { mangadex, readMangaPrefs } from '../lib/mangadex';
import type { RemoteChapter } from './types';

/*
 * Manga chapters kept to read offline (books/remote.ts): each page's picture in this browser, in a
 * database of their own, as they're many and big, with a note per series of the chapters kept.
 * Bytes, not Blobs, as Safari on iPhone can lose a Blob kept in IndexedDB (lib/store.ts). A series
 * taken out of the library lets go of its chapters the next time the app opens (sweepKept), so
 * taking it out can still be undone.
 */

let db: ReturnType<typeof createStore> | null = null;
try {
  db = createStore('breader-manga', 'pages');
} catch {
  db = null;
}

interface Bytes { bytes: ArrayBuffer; type: string }
/** A series' chapters kept here, by chapter id: their pages, their size, and whether they're all in. */
export type Kept = Record<string, { pages: number; bytes: number; done: boolean }>;

const pageKey = (chapter: string, n: number) => `${chapter}:${n}`;
const noteKey = (series: string) => `series:${series}`;

/** Page n of a chapter kept here, if it is. */
export async function keptPage(chapter: string, n: number): Promise<Blob | undefined> {
  if (!db) return undefined;
  try {
    const v = await get<Bytes>(pageKey(chapter, n), db);
    return v ? new Blob([v.bytes], { type: v.type }) : undefined;
  } catch {
    return undefined;
  }
}

/** A page from MangaDex, through the laptop. */
async function fetchPage(chapter: string, n: number): Promise<Blob> {
  const saver = readMangaPrefs().saver;
  try {
    return await mangadex.page(chapter, n, saver);
  } catch (e) {
    // A library made in this browser a moment ago may not be signed in yet: its first sync does it.
    if (!(e instanceof ApiError && e.code === 'signed_out')) throw e;
    await flush();
    return mangadex.page(chapter, n, saver);
  }
}

/** A page to read: kept here, or from MangaDex. */
export async function pageFor(chapter: string, n: number): Promise<Blob> {
  return (await keptPage(chapter, n)) ?? fetchPage(chapter, n);
}

async function noteOf(series: string): Promise<Kept> {
  if (!db) return {};
  try {
    return (await get<Kept>(noteKey(series), db)) ?? {};
  } catch {
    return {};
  }
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
let stopped = false;
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
    note[chapter.id] = { pages: chapter.pages, bytes: note[chapter.id]?.bytes ?? 0, done: false };
    await set(noteKey(series), note, store);
    tell();
    let bytes = 0;
    try {
      for (let n = 0; n < chapter.pages; n++) {
        if (stopped) break;
        let blob = await keptPage(chapter.id, n);
        if (!blob) {
          // Once more, then the chapter waits for another try.
          blob = await fetchPage(chapter.id, n).catch(() => fetchPage(chapter.id, n));
          await set(pageKey(chapter.id, n), { bytes: await blob.arrayBuffer(), type: blob.type } satisfies Bytes, store);
        }
        bytes += blob.size;
        now = { ...now, done: n + 1 };
        tell();
      }
      if (gone.delete(series)) {
        for (let n = 0; n < chapter.pages; n++) await del(pageKey(chapter.id, n), store).catch(() => {});
        continue;
      }
      const after = await noteOf(series);
      after[chapter.id] = { pages: chapter.pages, bytes, done: !stopped };
      await set(noteKey(series), after, store);
    } catch (e) {
      failed = e instanceof Error ? e.message : 'A page wouldn’t come.';
      queue = [];
    }
  }
  now = null;
  stopped = false;
  tell();
}

/** Keeps these chapters of a series here, after any already being kept. */
export function keepChapters(series: string, chapters: RemoteChapter[]) {
  failed = null;
  const queued = new Set(queue.map((q) => q.chapter.id));
  for (const c of chapters) if (c.pages > 0 && !queued.has(c.id) && now?.chapter !== c.id) queue.push({ series, chapter: c });
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
    for (let n = 0; n < c.pages; n++) await del(pageKey(id, n), store).catch(() => {});
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
  const [state, setState] = useState<{ now: Keeping | null; queued: number; failed: string | null }>({ now: null, queued: 0, failed: null });
  useEffect(() => {
    if (!series) return;
    let live = true;
    const update = () => {
      void noteOf(series).then((k) => { if (live) setKept(k); });
      setState({ now: now?.series === series ? now : null, queued: queue.filter((q) => q.series === series).length, failed });
    };
    update();
    listeners.add(update);
    return () => { live = false; listeners.delete(update); };
  }, [series]);
  return { kept, ...state };
}
