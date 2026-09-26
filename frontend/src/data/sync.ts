import { useEffect, useState } from 'react';
import { normalizeKey } from '@breader/shared/key';
import type { Book, LibraryResponse, Mutation, NewMutation, PullResponse, PushResponse, SyncedBook, UploadResponse } from '@breader/shared/protocol';
import type { BookEdit, BookRecord, Format, ReadState } from '../books/types';
import { api, ApiError, OfflineError, type ApiBase } from '../lib/api';
import { readLocal, store } from '../lib/store';

/*
 * The browser stays the first place anything is saved (backend design §6). Once a library has a
 * key, every change is also written to an outbox here and pushed to the server, which is where
 * browsers meet. Pulls bring back what other browsers did.
 *
 *   push   3 s after a change (at most 20 s while changes keep coming), when the tab is hidden,
 *          and when the connection returns
 *   pull   on start, on focus, after every push, and every 2 minutes while open
 */

interface SyncState {
  libraryId: string | null;
  clientId: string;
  nextId: number;
  /** Highest library revision this browser has pulled. */
  rev: number;
  registered: boolean;
  /** The whole library still has to be queued: set when a library first gets its key. */
  needsSnapshot: boolean;
  outbox: Mutation[];
  /** Book ids whose file or cover hasn't reached the server yet. */
  uploads: string[];
}

export interface SyncHost {
  snapshot(): { records: BookRecord[]; reads: Record<string, ReadState>; edits: Record<string, BookEdit>; key: string | null };
  /** Merge a pull. `pending` are this browser's changes the server hasn't seen yet; they win. */
  apply(pull: PullResponse, pending: Mutation[]): void;
  /** Replace this browser's library with the one a key opened. */
  replace(pull: PullResponse, key: string): Promise<void>;
  linked(bookId: string, ids: { fileId: string; coverId?: string }): void;
  cover(bookId: string, blob: Blob): Promise<void>;
  notice(text: string): void;
}

export interface SyncStatus {
  state: 'off' | 'syncing' | 'synced' | 'offline' | 'error';
  pending: number;
  lastSynced: number | null;
  message?: string;
  via: ApiBase;
}

const KEY = 'sync';
const SETTINGS = 'breader.reader.v1';
const MIME: Record<Format, string> = { EPUB: 'application/epub+zip', PDF: 'application/pdf', TXT: 'text/plain', Text: 'text/plain', MD: 'text/markdown' };
const COVER_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const fresh = (libraryId: string | null = null): SyncState => ({
  libraryId,
  clientId: crypto.randomUUID(),
  nextId: 1,
  rev: 0,
  registered: false,
  needsSnapshot: false,
  outbox: [],
  uploads: [],
});

let host: SyncHost | null = null;
let state: SyncState = fresh();
let flushing: Promise<void> | null = null;
let timer = 0;
let firstQueued = 0;

let status: SyncStatus = { state: 'off', pending: 0, lastSynced: null, via: api.via };
const watchers = new Set<(s: SyncStatus) => void>();
function setStatus(next: Partial<SyncStatus>) {
  status = { ...status, ...next, pending: state.outbox.length + state.uploads.length, via: api.via };
  watchers.forEach((w) => w(status));
}
api.onVia(() => setStatus({}));

const save = () => store.set(KEY, state);

/* ---- Wire format ---- */

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

export function toWire(r: BookRecord): Book {
  return {
    id: r.id,
    title: clip(r.title, 500),
    author: clip(r.author, 300),
    format: r.format,
    source: r.source === 'sample' ? 'sample' : 'file',
    ...(r.source === 'sample' && r.url ? { url: r.url } : {}),
    shared: r.shared,
    addedAt: Math.round(r.addedAt),
    words: Math.round(r.words),
    color: r.color,
    hasCover: !!r.hasCover,
    progress: Math.min(1, Math.max(0, r.progress)),
    line: clip(r.line, 1000),
    lastOpened: Math.round(r.lastOpened),
    fileId: r.fileId ?? null,
    coverId: r.coverId ?? null,
  };
}

export function fromWire(b: SyncedBook, local?: BookRecord): BookRecord {
  return {
    id: b.id,
    title: b.title,
    author: b.author,
    format: b.format,
    source: b.source,
    ...(b.url ? { url: b.url } : {}),
    shared: b.shared,
    addedAt: b.addedAt,
    words: b.words,
    color: b.color,
    // Means "this browser holds the cover"; covers stored on the server arrive by coverId.
    hasCover: !!local?.hasCover,
    progress: b.progress,
    line: b.line,
    lastOpened: b.lastOpened,
    fileId: b.fileId ?? local?.fileId,
    coverId: b.coverId ?? local?.coverId,
  };
}

export function editFromWire(e: SyncedBook['edit']): BookEdit | null {
  const out: BookEdit = {};
  if (e.title) out.title = e.title;
  if (e.color) out.color = e.color;
  if (e.favorite) out.favorite = true;
  return Object.keys(out).length ? out : null;
}

const readToWire = (r: ReadState): ReadState => ({ ...r, line: clip(r.line ?? '', 1000), progress: Math.min(1, Math.max(0, r.progress)), lastOpened: Math.round(r.lastOpened) });

/* ---- Recording changes ---- */

/** Queue a change for the server. Does nothing until this browser's library has a key. */
export function record(m: NewMutation) {
  if (!state.libraryId || state.needsSnapshot) return;
  // Only the latest reading place, card edit and settings matter; drop superseded ones.
  if (m.type === 'read.put') {
    const { bookId } = m;
    state.outbox = state.outbox.filter((x) => !(x.type === 'read.put' && x.bookId === bookId));
    m = { ...m, read: readToWire(m.read) };
  } else if (m.type === 'edit.put') {
    const { bookId } = m;
    const prev = state.outbox.find((x) => x.type === 'edit.put' && x.bookId === bookId);
    if (prev && prev.type === 'edit.put') {
      m = { ...m, edit: { ...prev.edit, ...m.edit } };
      state.outbox = state.outbox.filter((x) => x !== prev);
    }
  } else if (m.type === 'settings.put') {
    state.outbox = state.outbox.filter((x) => x.type !== 'settings.put');
  }
  state.outbox.push({ ...m, id: state.nextId++ } as Mutation);
  void save();
  setStatus({});
  schedule();
}

/** A book's file (or a newly found cover) should be stored on the server. */
export function queueUpload(bookId: string) {
  if (!state.libraryId || state.needsSnapshot) return;
  if (!state.uploads.includes(bookId)) state.uploads.push(bookId);
  void save();
  schedule();
}

/** This browser's library just got its key: from now on everything it holds syncs. */
export async function adopt() {
  state = { ...fresh(crypto.randomUUID()), needsSnapshot: true };
  await save();
  schedule(0);
}

/** Queue the whole library: every book, reading place, card edit and the reader settings. */
function queueSnapshot() {
  const { records, reads, edits } = host!.snapshot();
  const mine = records.filter((r) => r.source === 'file' || r.source === 'sample');
  const ids = new Set(mine.map((r) => r.id));
  const muts: NewMutation[] = mine.map((r) => ({ type: 'book.put', book: toWire(r) }));
  for (const [bookId, read] of Object.entries(reads)) if (ids.has(bookId)) muts.push({ type: 'read.put', bookId, read: readToWire(read) });
  for (const [bookId, e] of Object.entries(edits)) {
    if (ids.has(bookId)) muts.push({ type: 'edit.put', bookId, edit: { title: e.title?.trim() || null, color: e.color ?? null, favorite: !!e.favorite } });
  }
  const prefs = readLocal<Record<string, unknown> | null>(SETTINGS, null);
  if (prefs) muts.push({ type: 'settings.put', prefs });
  state.outbox = muts.map((m) => ({ ...m, id: state.nextId++ }) as Mutation);
  state.uploads = mine.filter((r) => r.source === 'file' && (!r.fileId || (r.hasCover && !r.coverId))).map((r) => r.id);
  state.needsSnapshot = false;
}

function schedule(delay = 3000) {
  const now = Date.now();
  if (!firstQueued) firstQueued = now;
  window.clearTimeout(timer);
  const wait = Math.max(0, Math.min(delay, firstQueued + 20_000 - now));
  timer = window.setTimeout(() => {
    firstQueued = 0;
    void flush();
  }, wait);
}

/* ---- Talking to the server ---- */

async function register() {
  const key = host!.snapshot().key;
  if (!key || !state.libraryId) throw new Error('This library has no key yet.');
  try {
    await api.post<LibraryResponse>('/v1/libraries', { libraryId: state.libraryId, key });
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    if (e.code === 'key_taken') {
      // This key was registered before (this browser lost its sync state): carry on with that library.
      const r = await api.post<LibraryResponse>('/v1/session/key', { key });
      state.libraryId = r.library.id;
    } else if (e.code === 'library_exists') {
      state.libraryId = crypto.randomUUID();
      return register();
    } else throw e;
  }
  state.registered = true;
  await save();
}

/** Runs a request, reopening the session with the stored key if the cookie was lost. */
async function signedIn<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof ApiError) || e.code !== 'signed_out') throw e;
    const key = host!.snapshot().key;
    if (!key) throw e;
    try {
      await api.post<LibraryResponse>('/v1/session/key', { key });
    } catch (again) {
      if (!(again instanceof ApiError) || again.code !== 'unknown_key') throw again;
      // The server no longer knows this library: register it again and send everything.
      state = { ...state, registered: false, rev: 0, needsSnapshot: true, outbox: [], uploads: [] };
      await save();
      schedule(0);
      throw new Error('The server lost this library, so Breader is sending it again.');
    }
    return fn();
  }
}

async function pushAll() {
  while (state.outbox.length) {
    const batch = state.outbox.slice(0, 200);
    const res = await signedIn(() => api.post<PushResponse>('/v1/sync/push', { clientId: state.clientId, mutations: batch }, 15_000));
    state.outbox = state.outbox.filter((m) => m.id > res.lastMutationId);
    for (const r of res.rejected) console.warn('The server didn’t take a change:', r);
    await save();
    setStatus({});
  }
}

async function pullNow() {
  const res = await signedIn(() => api.get<PullResponse>(`/v1/sync/pull?since=${state.rev}`));
  if (res.books.length || res.reads.length || res.settings) host!.apply(res, state.outbox);
  if (res.settings && !state.outbox.some((m) => m.type === 'settings.put')) applySettings(res.settings);
  state.rev = res.rev;
  await save();
  void fetchCovers(res.books);
}

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

/** Hash, ask, upload straight to storage, confirm. Returns the server's file id. */
async function uploadBlob(blob: Blob, mime: string, kind: 'book' | 'cover'): Promise<string> {
  const sha256 = hex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  const ask = await signedIn(() => api.post<UploadResponse>('/v1/uploads', { sha256, size: blob.size, mime, kind }));
  if (ask.status === 'upload' && ask.upload) {
    const put = await fetch(ask.upload.url, { method: 'PUT', headers: ask.upload.headers, body: blob });
    if (!put.ok) throw new Error(`The upload was refused (${put.status}).`);
    await signedIn(() => api.post(`/v1/uploads/${ask.fileId}/complete`));
  }
  return ask.fileId;
}

async function uploadAll() {
  for (const id of [...state.uploads]) {
    const rec = host!.snapshot().records.find((r) => r.id === id);
    const drop = async () => {
      state.uploads = state.uploads.filter((x) => x !== id);
      await save();
      setStatus({});
    };
    if (!rec || rec.source !== 'file') { await drop(); continue; }
    try {
      let fileId = rec.fileId;
      if (!fileId) {
        const data = await store.get<Blob | string>(`file:${id}`);
        if (data === undefined) { await drop(); continue; }
        const mime = MIME[rec.format];
        fileId = await uploadBlob(typeof data === 'string' ? new Blob([data], { type: mime }) : data, mime, 'book');
      }
      let coverId = rec.coverId;
      if (!coverId && rec.hasCover) {
        const cover = await store.get<Blob>(`cover:${id}`);
        if (cover && COVER_TYPES.has(cover.type)) coverId = await uploadBlob(cover, cover.type, 'cover');
      }
      host!.linked(id, { fileId, coverId });
      record({ type: 'book.files', bookId: id, fileId, coverId: coverId ?? null });
      await drop();
    } catch (e) {
      if (e instanceof ApiError && e.status < 500 && e.code !== 'signed_out') {
        host!.notice(`“${rec.title}” stays in this browser only. ${e.message}`);
        await drop();
      } else throw e;
    }
  }
}

async function fetchCovers(books: Array<Pick<SyncedBook, 'id' | 'coverId' | 'removedAt'>>) {
  for (const b of books) {
    if (!b.coverId || b.removedAt || (await store.get(`cover:${b.id}`))) continue;
    try {
      await host!.cover(b.id, await downloadFile(b.coverId));
    } catch {
      /* the next start tries again */
    }
  }
}

function applySettings(prefs: Record<string, unknown>) {
  const next = { ...readLocal<Record<string, unknown>>(SETTINGS, {}), ...prefs };
  try { localStorage.setItem(SETTINGS, JSON.stringify(next)); } catch { /* storage blocked */ }
  window.dispatchEvent(new Event('breader:settings'));
}

/** Push everything queued, upload waiting files, then pull. Safe to call any time. */
export function flush(): Promise<void> {
  flushing ??= (async () => {
    if (!host || !state.libraryId) return setStatus({ state: 'off' });
    setStatus({ state: 'syncing' });
    try {
      if (state.needsSnapshot) {
        queueSnapshot();
        await save();
      }
      if (!state.registered) await register();
      await pushAll();
      if (state.uploads.length) {
        await uploadAll();
        await pushAll();
      }
      await pullNow();
      setStatus({ state: 'synced', lastSynced: Date.now(), message: undefined });
    } catch (e) {
      if (e instanceof OfflineError) setStatus({ state: 'offline', message: e.message });
      else {
        console.warn('Sync failed:', e);
        setStatus({ state: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    }
  })().finally(() => { flushing = null; });
  return flushing;
}

/** A stored file, fetched through a short-lived signed link. */
export async function downloadFile(fileId: string): Promise<Blob> {
  const link = await signedIn(() => api.get<{ url: string }>(`/v1/files/${encodeURIComponent(fileId)}/link`));
  const res = await fetch(link.url);
  if (!res.ok) throw new Error('Breader couldn’t download this book. Try again in a moment.');
  return res.blob();
}

/**
 * Open another library with its key. This browser's own changes are saved to its library first,
 * then its books are replaced by the other library's.
 */
export async function openWithKey(input: string) {
  const key = normalizeKey(input);
  if (!key) throw new ApiError(400, 'bad_key', 'That isn’t a Breader key. Keys look like BRDR-XXXX-XXXX-XXXX-XXXX-XXXX.');
  if (!host) throw new Error('Breader is still starting. Try again in a moment.');
  if (key === host.snapshot().key) {
    await flush();
    return;
  }
  if (state.libraryId) {
    await flush();
    if (!state.registered || state.needsSnapshot || state.outbox.length || state.uploads.length) {
      throw new Error('Breader couldn’t save this browser’s books to their own library first. Try again when you’re online.');
    }
  }
  const opened = await api.post<LibraryResponse>('/v1/session/key', { key });
  const all = await api.get<PullResponse>('/v1/sync/pull?since=0');
  await host.replace(all, key);
  if (all.settings) applySettings(all.settings);
  state = { ...fresh(opened.library.id), registered: true, rev: all.rev };
  await save();
  setStatus({ state: 'synced', lastSynced: Date.now() });
  void fetchCovers(all.books);
}

/** Starts syncing once the local library has loaded. */
export async function startSync(h: SyncHost) {
  host = h;
  state = { ...fresh(), ...(await store.get<SyncState>(KEY)) };
  const snap = h.snapshot();
  // A library keyed before the backend existed: register it and send everything once.
  if (snap.key && !state.libraryId) await adopt();

  window.addEventListener('online', () => void flush());
  window.addEventListener('focus', () => void flush());
  document.addEventListener('visibilitychange', () => void flush());
  window.setInterval(() => { if (document.visibilityState === 'visible') void flush(); }, 120_000);

  await flush();
  void fetchCovers(snap.records.filter((r) => r.coverId).map((r) => ({ id: r.id, coverId: r.coverId!, removedAt: null })));
}

export function useSyncStatus() {
  const [s, setS] = useState(status);
  useEffect(() => {
    watchers.add(setS);
    setS(status);
    return () => { watchers.delete(setS); };
  }, []);
  return s;
}
