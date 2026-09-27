import { useEffect, useSyncExternalStore } from 'react';
import type { Edit, Mutation, NewMutation, PullResponse } from '@breader/shared/protocol';
import { forget } from '../books/load';
import { report } from '../lib/report';
import { store } from '../lib/store';
import { onNews, tell, withData } from '../lib/tabs';
import type { BookEdit, BookRecord, ReadState } from '../books/types';
import { normColor, pickColor } from './colors';
import { sampleRecords } from './library';
import { newId, newLibraryKey } from '../lib/key';
import { countLocked } from './readTime';
import { shelfCover } from './shelf';
import { adopt, editFromWire, enterAccount, fromWire, queueLocked, startSync, toWire, type LibraryData, type SyncHost } from './sync';

export interface ShelfItem extends BookRecord {
  /** Its card's identity in the gallery, when that isn't its id: a copy stands where its shared book stood. */
  key?: string;
  coverUrl?: string;
  /** Opened in the reader at least once. */
  opened: boolean;
  favorite: boolean;
}

/** A removed book, kept in memory so it can be put back. */
export interface RemovedBook {
  rec: BookRecord;
  index: number;
  data?: Blob | string;
  cover?: Blob;
  read?: ReadState;
  edit?: BookEdit;
}

interface State extends LibraryData {
  ready: boolean;
  /** Object URLs of the covers this browser holds, by book id. */
  covers: Record<string, string>;
  /** Copies of shared books this library can't keep any more; they hide until shared again. */
  lapsed: ReadonlySet<string>;
}

/*
 * The reader's own library. This browser is the first place it's saved; once the library has a
 * key, every change is also queued for the server (data/sync.ts), and changes made in other
 * browsers are merged in.
 *
 * Several tabs can hold the library at once. So a change isn't a new copy of the library but a
 * function of it: the tab shows it at once, then applies it to the library as stored, under the
 * data lock, and queues it for the server in the same step. Other tabs hear about it and reload.
 * No tab ever writes back a copy it loaded earlier.
 */

interface Change {
  fn: (d: LibraryData) => Partial<LibraryData>;
  muts: NewMutation[];
  uploads: string[];
  done: () => void;
}

const EMPTY: LibraryData = { records: [], reads: {}, edits: {}, key: null };

/** The library as last read from or written to IndexedDB. */
let stored: LibraryData = EMPTY;
/** This tab's changes not yet saved, in order. */
let unsaved: Change[] = [];
let covers: Record<string, string> = {};
const coverLoads = new Set<string>();
/** Books marked as having a cover whose image this browser doesn't hold. */
const noCover = new Set<string>();
let lapsed: ReadonlySet<string> = new Set();
let view: State = { ready: false, ...EMPTY, covers, lapsed };
const subscribers = new Set<() => void>();
let started: Promise<void> | null = null;
let notice: ((text: string) => void) | undefined;
let saveTimer = 0;
let saveAt = 0;

const apply = (d: LibraryData, c: Change): LibraryData => ({ ...d, ...c.fn(d) });

/** Recomputes what this tab shows: the stored library with this tab's unsaved changes on top. */
function show() {
  const d = unsaved.reduce(apply, stored);
  showCovers(d.records);
  view = { ready: true, ...d, covers, lapsed };
  subscribers.forEach((s) => s());
}

/** Keeps an object URL for every cover this browser holds, and lets go of the rest. */
function showCovers(records: BookRecord[]) {
  const want = new Set(records.filter((r) => r.hasCover).map((r) => r.id));
  const gone = Object.keys(covers).filter((id) => !want.has(id));
  if (gone.length) {
    covers = { ...covers };
    for (const id of gone) {
      URL.revokeObjectURL(covers[id]);
      delete covers[id];
    }
  }
  for (const id of want) {
    if (covers[id] || coverLoads.has(id) || noCover.has(id)) continue;
    coverLoads.add(id);
    void store.get<Blob>(`cover:${id}`).then((blob) => {
      coverLoads.delete(id);
      if (!blob) { noCover.add(id); return; }
      if (covers[id] || !view.records.some((r) => r.id === id)) return;
      covers = { ...covers, [id]: URL.createObjectURL(blob) };
      show();
    });
  }
}

/** Books in `before` that aren't in `after`: drop what this tab keeps of them. */
function forgetGone(before: LibraryData, after: LibraryData) {
  const ids = new Set(after.records.map((r) => r.id));
  for (const r of before.records) if (!ids.has(r.id)) forget(r.id);
}

async function loadStored(): Promise<LibraryData> {
  const [records, reads, edits, key] = await Promise.all([
    store.get<BookRecord[]>('records'),
    store.get<Record<string, ReadState>>('reads'),
    store.get<Record<string, BookEdit>>('edits'),
    store.get<string>('libraryKey'),
  ]);
  return { records: records ?? [], reads: reads ?? {}, edits: edits ?? {}, key: key ?? null };
}

async function writeStored(next: LibraryData, prev: LibraryData) {
  await Promise.all([
    next.records !== prev.records && store.set('records', next.records),
    next.reads !== prev.reads && store.set('reads', next.reads),
    next.edits !== prev.edits && store.set('edits', next.edits),
    next.key !== prev.key && (next.key ? store.set('libraryKey', next.key) : store.del('libraryKey')),
  ]);
}

/**
 * With the data lock held: applies this tab's unsaved changes to the library as stored, saves it,
 * and queues the changes for the server. Returns the library as now stored.
 */
async function settleLocked(): Promise<LibraryData> {
  const batch = unsaved.slice();
  const before = await loadStored();
  const next = batch.reduce(apply, before);
  if (batch.length) {
    await writeStored(next, before);
    await queueLocked(batch.flatMap((c) => c.muts), batch.flatMap((c) => c.uploads));
    tell('library');
  }
  forgetGone(stored, next);
  stored = next;
  unsaved = unsaved.slice(batch.length);
  batch.forEach((c) => c.done());
  show();
  return next;
}

function scheduleSave(wait: number) {
  const at = Date.now() + wait;
  // A save already coming sooner takes this change along.
  if (saveTimer && saveAt <= at) return;
  window.clearTimeout(saveTimer);
  saveAt = at;
  saveTimer = window.setTimeout(() => {
    saveTimer = 0;
    withData(settleLocked).catch((err) => {
      // The changes stay shown and unsaved; try again shortly.
      console.warn('Couldn’t save the library:', err);
      report(err, { in: 'library save' });
      scheduleSave(2000);
    });
  }, wait);
}

/**
 * Makes a change: shown at once, saved and queued for the server within `wait` ms. Resolves once
 * it's saved.
 */
function change(fn: Change['fn'], muts: NewMutation[] = [], opts: { uploads?: string[]; wait?: number } = {}): Promise<void> {
  return new Promise((done) => {
    unsaved.push({ fn, muts, uploads: opts.uploads ?? [], done });
    show();
    scheduleSave(opts.wait ?? 0);
  });
}

const without = <T>(o: Record<string, T>, id: string) => {
  const out = { ...o };
  delete out[id];
  return out;
};

const editToWire = (patch: BookEdit): Edit => ({
  ...('title' in patch ? { title: patch.title?.trim() || null } : {}),
  ...('color' in patch ? { color: patch.color ?? null } : {}),
  ...('favorite' in patch ? { favorite: !!patch.favorite } : {}),
  ...('series' in patch ? { series: patch.series === undefined ? null : patch.series.trim() } : {}),
  ...('seriesIndex' in patch ? { seriesIndex: patch.seriesIndex ?? null } : {}),
});

/** Merges what other browsers did. Changes the server hasn't seen yet (`pending`) win. */
function mergePull(d: LibraryData, pull: PullResponse, pending: Mutation[]): { next: LibraryData; gone: string[] } {
  const pendingIds = (type: Mutation['type']) =>
    new Set(pending.flatMap((m) => (m.type === type && 'bookId' in m ? [m.bookId] : [])));
  const removing = pendingIds('book.remove');
  const restoring = pendingIds('book.restore');
  const adding = new Set(pending.flatMap((m) => (m.type === 'book.put' ? [m.book.id] : [])));
  const pendingEdits = new Map(pending.flatMap((m) => (m.type === 'edit.put' ? [[m.bookId, m.edit] as const] : [])));

  const records = [...d.records];
  const edits = { ...d.edits };
  const reads = { ...d.reads };
  const gone: string[] = [];
  const drop = (i: number) => {
    const [r] = records.splice(i, 1);
    gone.push(r.id);
    delete edits[r.id];
    delete reads[r.id];
  };

  for (const b of pull.books) {
    const i = records.findIndex((r) => r.id === b.id);
    if (b.removedAt !== null && !restoring.has(b.id)) {
      if (i >= 0) drop(i);
      continue;
    }
    if (removing.has(b.id)) continue; // removed here; the server hears about it on the next push
    const rec = fromWire(b, i >= 0 ? records[i] : undefined);
    if (i >= 0) records[i] = rec;
    else records.unshift(rec);

    const edit: BookEdit = { ...editFromWire(b.edit) };
    const mine = pendingEdits.get(b.id);
    if (mine?.title !== undefined) edit.title = mine.title ?? undefined;
    if (mine?.color !== undefined) edit.color = mine.color ?? undefined;
    if (mine?.favorite !== undefined) edit.favorite = mine.favorite;
    if (mine?.series !== undefined) edit.series = mine.series ?? undefined;
    if (mine?.seriesIndex !== undefined) edit.seriesIndex = mine.seriesIndex ?? undefined;
    for (const k of Object.keys(edit) as Array<keyof BookEdit>) if (edit[k] === undefined || edit[k] === false) delete edit[k];
    if (Object.keys(edit).length) edits[b.id] = edit;
    else delete edits[b.id];
  }
  // The whole library: a synced book it doesn't list was removed while this browser was away.
  if (pull.full) {
    const listed = new Set(pull.books.map((b) => b.id));
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i];
      if (r.source !== 'placeholder' && !listed.has(r.id) && !adding.has(r.id)) drop(i);
    }
  }
  // The most recent reading session wins. This browser's unsent place is always newer.
  for (const { bookId, read } of pull.reads) {
    const local = reads[bookId];
    const wordsRead = Math.max(local?.wordsRead ?? 0, read.wordsRead ?? 0);
    if (!local || local.lastOpened < read.lastOpened) reads[bookId] = { ...read, wordsRead };
    else if (wordsRead > (local.wordsRead ?? 0)) reads[bookId] = { ...local, wordsRead };
  }
  return { next: { ...d, records, edits, reads }, gone };
}

const host: SyncHost = {
  snapshot: () => view,
  settleLocked,
  async applyLocked(pull, pending) {
    const { next, gone } = mergePull(stored, pull, pending);
    await writeStored(next, stored);
    for (const id of gone) {
      forget(id);
      await store.del(`file:${id}`);
      await store.del(`cover:${id}`);
    }
    stored = next;
    tell('library');
    show();
  },
  async replaceLocked(pull, key) {
    const before = await loadStored();
    for (const r of before.records) {
      forget(r.id);
      await store.del(`file:${r.id}`);
      await store.del(`cover:${r.id}`);
    }
    const live = pull.books.filter((b) => b.removedAt === null);
    const edits: Record<string, BookEdit> = {};
    for (const b of live) {
      const e = editFromWire(b.edit);
      if (e) edits[b.id] = e;
    }
    const next: LibraryData = {
      records: live.map((b) => fromWire(b)).sort((a, b) => b.addedAt - a.addedAt),
      edits,
      reads: Object.fromEntries(pull.reads.map((r) => [r.bookId, r.read])),
      key,
    };
    await writeStored(next, before);
    // Changes this tab hadn't saved belonged to the library being replaced.
    unsaved.forEach((c) => c.done());
    unsaved = [];
    stored = next;
    tell('library');
    show();
  },
  linked: (bookId, ids) =>
    change(
      (d) => ({ records: d.records.map((r) => (r.id === bookId ? { ...r, ...ids } : r)) }),
      [{ type: 'book.files', bookId, fileId: ids.fileId, coverId: ids.coverId ?? null }],
    ),
  cover: (bookId, blob) => storeCover(bookId, blob, false),
  lapsed(ids) {
    if (ids.length === lapsed.size && ids.every((id) => lapsed.has(id))) return;
    lapsed = new Set(ids);
    void store.set('lapsed', ids);
    show();
  },
  notice: (text) => notice?.(text),
};

async function start() {
  await withData(async () => {
    // A new browser starts with the bundled samples in development, and empty on the live site.
    if (!(await store.get('records'))) await store.set('records', import.meta.env.DEV ? sampleRecords(Date.now()) : []);
    stored = await loadStored();
    lapsed = new Set((await store.get<string[]>('lapsed')) ?? []);
  });
  show();
  onNews((news) => {
    if (news === 'reset') window.location.reload();
    if (news !== 'library') return;
    void withData(async () => {
      const next = await loadStored();
      forgetGone(stored, next);
      stored = next;
      show();
    });
  });
  // Leaving the page: save what's waiting rather than wait for the timer.
  window.addEventListener('pagehide', () => { if (unsaved.length) void withData(settleLocked); });
  void startSync(host);
}

/** Books this library holds, as opposed to preview placeholders. */
const holds = (id: string) => view.records.some((r) => r.id === id);

async function storeCover(id: string, cover: Blob, upload: boolean) {
  await store.set(`cover:${id}`, cover);
  noCover.delete(id);
  if (covers[id]) {
    URL.revokeObjectURL(covers[id]);
    covers = without(covers, id);
  }
  await change((d) => ({ records: d.records.map((r) => (r.id === id ? { ...r, hasCover: true } : r)) }), [], { uploads: upload ? [id] : [] });
}

async function addBook(rec: BookRecord, blob: Blob | string, cover?: Blob) {
  await store.set(`file:${rec.id}`, blob);
  if (cover) {
    rec = { ...rec, hasCover: true };
    await store.set(`cover:${rec.id}`, cover);
    noCover.delete(rec.id);
  }
  await change(
    (d) => ({ records: [rec, ...d.records.filter((r) => r.id !== rec.id)] }),
    [{ type: 'book.put', book: toWire(rec) }],
    { uploads: rec.source === 'file' ? [rec.id] : [] },
  );
}

/**
 * A cover found when a book is opened. Uploaded books send it to the server too; copies of shared
 * books don't, since the file is the sharer's.
 */
async function setCover(id: string, cover: Blob) {
  const rec = view.records.find((r) => r.id === id);
  await storeCover(id, cover, rec?.source === 'file' && !rec.origin);
}

/**
 * Starting a book on the Shared Library adds a copy of it to this library, pointing at the sharer's
 * file, with its own place, colour and card. Starting it again finds the same copy.
 */
async function startShelfBook(entry: BookRecord): Promise<BookRecord> {
  const had = view.records.find((r) => r.origin === entry.id);
  if (had) return had;
  const now = Date.now();
  const cover = await shelfCover(entry.id);
  const copy: BookRecord = {
    id: newId(),
    title: entry.title,
    author: entry.author,
    format: entry.format,
    source: 'file',
    shared: false,
    addedAt: now,
    words: entry.words,
    color: nextColor(),
    hasCover: !!cover,
    progress: 0,
    line: entry.line,
    lastOpened: now,
    ...(entry.fileId ? { fileId: entry.fileId } : {}),
    ...(entry.coverId ? { coverId: entry.coverId } : {}),
    origin: entry.id,
    ...(entry.series ? { series: entry.series, seriesIndex: entry.seriesIndex } : {}),
  };
  if (cover) {
    await store.set(`cover:${copy.id}`, cover);
    noCover.delete(copy.id);
  }
  await change((d) => ({ records: [copy, ...d.records] }), [{ type: 'book.put', book: toWire(copy) }]);
  return copy;
}

/** Deletes a book from this browser and returns everything needed to put it back. */
async function removeBook(id: string): Promise<RemovedBook | null> {
  const index = view.records.findIndex((r) => r.id === id);
  if (index < 0) return null;
  const removed: RemovedBook = {
    rec: view.records[index],
    index,
    data: await store.get<Blob | string>(`file:${id}`),
    cover: await store.get<Blob>(`cover:${id}`),
    read: view.reads[id],
    edit: view.edits[id],
  };
  await store.del(`file:${id}`);
  await store.del(`cover:${id}`);
  await change(
    (d) => ({ records: d.records.filter((r) => r.id !== id), reads: without(d.reads, id), edits: without(d.edits, id) }),
    [{ type: 'book.remove', bookId: id }],
  );
  return removed;
}

/** Puts a removed book back where it was, with its place, name and colour. */
async function restoreBook(r: RemovedBook) {
  const id = r.rec.id;
  if (holds(id)) return;
  if (r.data !== undefined) await store.set(`file:${id}`, r.data);
  if (r.cover) await store.set(`cover:${id}`, r.cover);
  await change(
    (d) => {
      if (d.records.some((x) => x.id === id)) return {};
      const records = [...d.records];
      records.splice(Math.min(r.index, records.length), 0, r.rec);
      return {
        records,
        reads: r.read ? { ...d.reads, [id]: r.read } : d.reads,
        edits: r.edit ? { ...d.edits, [id]: r.edit } : d.edits,
      };
    },
    [{ type: 'book.restore', bookId: id }],
  );
}

/** The colour the next book added gets. Only the colour each book was given counts, not recolours. */
function nextColor() {
  return pickColor(view.records.filter((r) => r.source !== 'placeholder').map((r) => normColor(r.color, r.title)));
}

/** Seconds spent reading a book, added to today's count and sent as this browser's share. */
function addReadTime(id: string, seconds: number) {
  if (!holds(id) || seconds <= 0) return;
  withData(async () => queueLocked([await countLocked(id, seconds)])).catch((err) => {
    console.warn('Couldn’t save reading time:', err);
  });
}

/** Reading positions change often, so they're saved at most every 400 ms. */
function saveRead(id: string, read: ReadState) {
  void change((d) => ({ reads: { ...d.reads, [id]: read } }), holds(id) ? [{ type: 'read.put', bookId: id, read }] : [], { wait: 400 });
}

/**
 * Puts one of the reader's own books on the Shared Library, or takes it off. It stays in My books
 * either way, and anyone who read far enough into it (KEEP_WORDS) keeps their copy.
 */
function setShared(id: string, shared: boolean) {
  const rec = view.records.find((r) => r.id === id);
  if (!rec || rec.shared === shared) return;
  const next = { ...rec, shared };
  void change((d) => ({ records: d.records.map((r) => (r.id === id ? { ...r, shared } : r)) }), [{ type: 'book.put', book: toWire(next) }]);
}

/** Rename, recolour or favourite a book. Works for placeholders too, so previews can be styled. */
function editBook(id: string, patch: BookEdit) {
  void change(
    (d) => ({ edits: { ...d.edits, [id]: { ...d.edits[id], ...patch } } }),
    holds(id) ? [{ type: 'edit.put', bookId: id, edit: editToWire(patch) }] : [],
  );
}

/** The library's first key: from here on it syncs. */
async function setKey(key: string) {
  await change(() => ({ key }));
  await adopt();
}

/**
 * After a login: books this browser holds without a key get one first, so the account can take
 * them over instead of their being replaced (data/sync.ts enterAccount).
 */
async function joinAccount(claim?: boolean) {
  if (!view.key && view.records.some((r) => r.source === 'file' || r.source === 'sample')) await setKey(newLibraryKey());
  return enterAccount(claim);
}

async function reset() {
  await store.clear();
  try { localStorage.clear(); } catch { /* storage blocked */ }
  tell('reset');
  window.location.hash = '';
  window.location.reload();
}

const subscribe = (fn: () => void) => {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
};
const getView = () => view;

export function useLibrary(opts: { onNotice?: (text: string) => void } = {}) {
  const { onNotice } = opts;
  useEffect(() => { notice = onNotice; }, [onNotice]);
  useEffect(() => { started ??= start(); }, []);
  const state = useSyncExternalStore(subscribe, getView);
  return { ...state, nextColor, addBook, setCover, startShelfBook, removeBook, restoreBook, saveRead, addReadTime, editBook, setShared, setKey, joinAccount, reset };
}

export type Library = ReturnType<typeof useLibrary>;

/** Lines saved by earlier builds when a position sat on an untitled page. */
const UNTITLED = /^(Section \d+|Cover|Illustration|Opening|Part \d+)$/;

export function withReading(
  rec: BookRecord,
  reads: Record<string, ReadState>,
  covers: Record<string, string>,
  edits: Record<string, BookEdit>,
): ShelfItem {
  const r = reads[rec.id];
  const e = edits[rec.id] ?? {};
  const title = e.title?.trim() || rec.title;
  const series = e.series !== undefined ? e.series.trim() || undefined : rec.series;
  return {
    ...rec,
    title,
    series,
    seriesIndex: series ? e.seriesIndex ?? rec.seriesIndex : undefined,
    color: normColor(e.color ?? rec.color, rec.title),
    favorite: !!e.favorite,
    opened: !!r,
    coverUrl: covers[rec.id],
    progress: r && rec.source !== 'placeholder' ? r.progress : rec.progress,
    line: r && rec.source !== 'placeholder' && r.line && !UNTITLED.test(r.line) ? r.line : rec.line,
    lastOpened: r ? r.lastOpened : rec.lastOpened,
    words: r?.words ?? rec.words,
  };
}
