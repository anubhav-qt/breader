import { useEffect, useState } from 'react';
import { normalizeKey } from '@breader/shared/key';
import { SYNC } from '@breader/shared/limits';
import type { AccountResponse, Book, LibraryResponse, Mutation, NewMutation, PullResponse, PushResponse, SyncedBook, UploadRequest, UploadResponse } from '@breader/shared/protocol';
import type { BookEdit, BookRecord, Format, ReadState } from '../books/types';
import { api, ApiError, OfflineError, type ApiBase } from '../lib/api';
import { report } from '../lib/report';
import { readLocal, store } from '../lib/store';
import { onNews, tell, withData, withSync } from '../lib/tabs';
import { allCountsLocked } from './readTime';

/*
 * The browser stays the first place anything is saved (backend design §6). Once a library has a
 * key, every change is also written to an outbox here and pushed to the server, which is where
 * browsers meet. Pulls bring back what other browsers did.
 *
 *   push   3 s after a change (at most 20 s while changes keep coming), when the tab is hidden,
 *          and when the connection returns
 *   pull   on start, on focus, after every push, and every 2 minutes while open
 *
 * Every tab of this browser shares one outbox, kept in IndexedDB and only changed under the data
 * lock, and only one tab syncs at a time (lib/tabs.ts).
 *
 * If the server loses changes it had already taken (it was restored from a backup), its timeline
 * changes, or its rev drops below one this browser pulled. The browser then sends everything it
 * holds again, files included, before it takes anything from the server.
 */

interface SyncState {
  libraryId: string | null;
  clientId: string;
  nextId: number;
  /** Highest library revision this browser has pulled. */
  rev: number;
  /** The server's sync timeline at the last pull. */
  timeline?: string;
  registered: boolean;
  /** The whole library still has to be queued: set when a library first gets its key. */
  needsSnapshot: boolean;
  /** The snapshot is a resend to a server that lost changes: every file is checked again too. */
  resend?: boolean;
  outbox: Mutation[];
  /** Book ids whose file or cover hasn't reached the server yet. */
  uploads: string[];
  /** Of those, books to ask about again although they have a file id: the server may have lost it. */
  recheck?: string[];
  /** Books removed here recently, so a resend can remove them again. */
  removed?: Array<{ id: string; at: number }>;
}

export interface LibraryData {
  records: BookRecord[];
  reads: Record<string, ReadState>;
  edits: Record<string, BookEdit>;
  key: string | null;
}

/**
 * The library's side of sync (data/useLibrary.ts). Methods ending in Locked are called with the
 * data lock held and must not take it again.
 */
export interface SyncHost {
  /** The library as this tab shows it. */
  snapshot(): LibraryData;
  /** Saves this tab's unsaved changes, queueing them here, and returns the library as stored. */
  settleLocked(): Promise<LibraryData>;
  /** Merges a pull into the stored library. `pending` are changes the server hasn't seen yet; they win. */
  applyLocked(pull: PullResponse, pending: Mutation[]): Promise<void>;
  /** Replaces the library with the one a key or a login opened. */
  replaceLocked(pull: PullResponse, key: string | null): Promise<void>;
  /** Copies of shared books that lapsed: read too little of to keep, and no longer shared (PullResponse). */
  lapsed(ids: string[]): void;
  /** A book's file (and cover) reached the server: note their ids, and tell the server. */
  linked(bookId: string, ids: { fileId: string; coverId?: string }): Promise<void>;
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
const DAY = 86_400_000;

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

/** The server lost changes this browser sent: start again from a resend. */
class Resend extends Error {}

let host: SyncHost | null = null;
let flushing: Promise<void> | null = null;
let timer = 0;
let firstQueued = 0;
/** The state as last read or written, for the status line only. */
let seen: SyncState = fresh();
/**
 * This browser's library was moved into an account from another browser: the server takes no
 * more changes for it, so what is still waiting here can't be sent, and needn't hold up a login.
 */
let movedAway = false;

let status: SyncStatus = { state: 'off', pending: 0, lastSynced: null, via: api.via };
const watchers = new Set<(s: SyncStatus) => void>();
function setStatus(next: Partial<SyncStatus>) {
  status = { ...status, ...next, pending: seen.outbox.length + seen.uploads.length, via: api.via };
  watchers.forEach((w) => w(status));
}
api.onVia(() => setStatus({}));

async function load(): Promise<SyncState> {
  return { ...fresh(), ...(await store.get<SyncState>(KEY)) };
}

async function save(s: SyncState) {
  await store.set(KEY, s);
  seen = s;
  setStatus({});
  tell('sync');
}

/** Reads the sync state as stored. */
const read = () => withData(load);

/** Changes the sync state as stored. */
const update = <T>(fn: (s: SyncState) => T) =>
  withData(async () => {
    const s = await load();
    const out = fn(s);
    await save(s);
    return out;
  });

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
    ...(r.sharedOnly ? { sharedOnly: true } : {}),
    addedAt: Math.round(r.addedAt),
    words: Math.round(r.words),
    color: r.color,
    hasCover: !!r.hasCover,
    progress: Math.min(1, Math.max(0, r.progress)),
    line: clip(r.line, 1000),
    lastOpened: Math.round(r.lastOpened),
    fileId: r.fileId ?? null,
    coverId: r.coverId ?? null,
    ...(r.origin ? { origin: r.origin } : {}),
    ...(r.series ? { series: clip(r.series, 300) } : {}),
    ...(r.seriesIndex !== undefined ? { seriesIndex: r.seriesIndex } : {}),
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
    ...(b.sharedOnly ? { sharedOnly: true } : {}),
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
    ...(b.origin ?? local?.origin ? { origin: b.origin ?? local?.origin } : {}),
    ...(b.series ? { series: b.series } : {}),
    ...(b.seriesIndex != null ? { seriesIndex: b.seriesIndex } : {}),
  };
}

export function editFromWire(e: SyncedBook['edit']): BookEdit | null {
  const out: BookEdit = {};
  if (e.title) out.title = e.title;
  if (e.color) out.color = e.color;
  if (e.favorite) out.favorite = true;
  if (e.series != null) out.series = e.series;
  if (e.seriesIndex != null) out.seriesIndex = e.seriesIndex;
  if (e.ai) out.ai = true;
  return Object.keys(out).length ? out : null;
}

const unit = (n: number) => Math.min(1, Math.max(0, n));
const readToWire = (r: ReadState): ReadState => ({
  ...r,
  line: clip(r.line ?? '', 1000),
  progress: unit(r.progress),
  lastOpened: Math.round(r.lastOpened),
  ...(r.mark ? { mark: { ...r.mark, line: clip(r.mark.line ?? '', 1000), progress: unit(r.mark.progress) } } : {}),
});

/* ---- Recording changes ---- */

/** Adds one change to the outbox, dropping ones it supersedes. */
function enqueue(s: SyncState, m: NewMutation) {
  // Only the latest reading place, card edit and settings matter; drop superseded ones.
  if (m.type === 'read.put') {
    const { bookId } = m;
    s.outbox = s.outbox.filter((x) => !(x.type === 'read.put' && x.bookId === bookId));
    m = { ...m, read: readToWire(m.read) };
  } else if (m.type === 'edit.put') {
    const { bookId } = m;
    const prev = s.outbox.find((x) => x.type === 'edit.put' && x.bookId === bookId);
    if (prev && prev.type === 'edit.put') {
      m = { ...m, edit: { ...prev.edit, ...m.edit } };
      s.outbox = s.outbox.filter((x) => x !== prev);
    }
  } else if (m.type === 'settings.put') {
    s.outbox = s.outbox.filter((x) => x.type !== 'settings.put');
  } else if (m.type === 'voice.put') {
    const { id } = m.voice;
    s.outbox = s.outbox.filter((x) => !(x.type === 'voice.put' && x.voice.id === id));
  } else if (m.type === 'voice.use') {
    const { voiceId } = m;
    s.outbox = s.outbox.filter((x) => !(x.type === 'voice.use' && x.voiceId === voiceId));
  } else if (m.type === 'time.put') {
    const { bookId, day, device } = m;
    s.outbox = s.outbox.filter((x) => !(x.type === 'time.put' && x.bookId === bookId && x.day === day && x.device === device));
  }
  if (m.type === 'book.remove' || m.type === 'book.restore') {
    const { bookId } = m;
    const now = Date.now();
    s.removed = (s.removed ?? []).filter((r) => r.id !== bookId && now - r.at < SYNC.tombstoneDays * DAY);
    if (m.type === 'book.remove') s.removed.push({ id: bookId, at: now });
  }
  s.outbox.push({ ...m, id: s.nextId++ } as Mutation);
}

/**
 * Queues changes for the server, and books whose file should be stored there. Call with the data
 * lock held: the library saves a change and queues it in one step, so no tab sees one without the
 * other. Does nothing until this browser's library has a key.
 */
export async function queueLocked(muts: NewMutation[], uploads: string[] = []) {
  if (!muts.length && !uploads.length) return;
  const s = await load();
  // A snapshot still to come carries these changes with it.
  if (!s.libraryId || s.needsSnapshot) return;
  for (const m of muts) enqueue(s, m);
  for (const id of uploads) if (!s.uploads.includes(id)) s.uploads.push(id);
  await save(s);
  schedule();
}

/** Queue one change for the server. */
export function record(m: NewMutation) {
  void withData(() => queueLocked([m]));
}

/** This browser's library just got its key: from now on everything it holds syncs. */
export async function adopt() {
  await withData(() => save({ ...fresh(crypto.randomUUID()), needsSnapshot: true }));
  schedule(0);
}

/**
 * Queue the whole library: every book, reading place, card edit and the reader settings. On a
 * resend, books go without their file ids (the server keeps the ones it has), removals go again,
 * and every file is checked: the server may have lost the rows but not the files, or both.
 */
async function queueSnapshotLocked() {
  if (!(await load()).needsSnapshot) return;
  const { records, reads, edits } = await host!.settleLocked();
  const s = await load();
  const resend = !!s.resend;
  const mine = records.filter((r) => r.source === 'file' || r.source === 'sample');
  const ids = new Set(mine.map((r) => r.id));
  // Copies of shared books keep pointing at the sharer's file: there's nothing of theirs to send.
  const muts: NewMutation[] = mine.map((r) => ({ type: 'book.put', book: resend && !r.origin ? { ...toWire(r), fileId: null, coverId: null } : toWire(r) }));
  for (const [bookId, read] of Object.entries(reads)) if (ids.has(bookId)) muts.push({ type: 'read.put', bookId, read: readToWire(read) });
  for (const [bookId, e] of Object.entries(edits)) {
    if (ids.has(bookId)) muts.push({ type: 'edit.put', bookId, edit: { title: e.title?.trim() || null, color: e.color ?? null, favorite: !!e.favorite, series: e.series ?? null, seriesIndex: e.seriesIndex ?? null, ai: !!e.ai } });
  }
  const prefs = readLocal<Record<string, unknown> | null>(SETTINGS, null);
  if (prefs) muts.push({ type: 'settings.put', prefs });
  muts.push(...(await allCountsLocked(ids)));
  if (resend) for (const r of s.removed ?? []) if (!ids.has(r.id)) muts.push({ type: 'book.remove', bookId: r.id });
  s.outbox = muts.map((m) => ({ ...m, id: s.nextId++ }) as Mutation);
  const files = mine.filter((r) => r.source === 'file' && !r.origin);
  s.uploads = (resend ? files : files.filter((r) => !r.fileId || (r.hasCover && !r.coverId))).map((r) => r.id);
  s.recheck = resend ? files.map((r) => r.id) : [];
  s.needsSnapshot = false;
  s.resend = false;
  await save(s);
}

/** Sends everything this browser holds again, before taking anything from the server. */
async function startResend(timeline?: string) {
  console.warn('The server lost changes this browser had sent, so Breader is sending everything again.');
  await update((s) => {
    s.needsSnapshot = true;
    s.resend = true;
    s.rev = 0;
    s.timeline = timeline;
  });
}

/** The server has lost changes this browser already had from it. */
const lost = (s: SyncState, res: { rev: number; timeline?: string }) =>
  (!!s.timeline && !!res.timeline && res.timeline !== s.timeline) || res.rev < s.rev;

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
  const { libraryId } = await read();
  if (!key || !libraryId) throw new Error('This library has no key yet.');
  let id = libraryId;
  try {
    await api.post<LibraryResponse>('/v1/libraries', { libraryId, key });
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    if (e.code === 'key_taken') {
      // This key was registered before (this browser lost its sync state): carry on with that library.
      const r = await api.post<LibraryResponse>('/v1/session/key', { key });
      id = r.library.id;
    } else if (e.code === 'library_exists') {
      await update((s) => { s.libraryId = crypto.randomUUID(); });
      return register();
    } else throw e;
  }
  await update((s) => {
    s.libraryId = id;
    s.registered = true;
  });
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
      await update((s) => {
        s.registered = false;
        s.rev = 0;
        s.timeline = undefined;
        s.needsSnapshot = true;
        s.resend = true;
      });
      throw new Resend();
    }
    return fn();
  }
}

async function pushAll() {
  for (;;) {
    const s = await read();
    const batch = s.outbox.slice(0, SYNC.maxMutations);
    if (!batch.length) return;
    const res = await signedIn(() => api.post<PushResponse>('/v1/sync/push', { clientId: s.clientId, mutations: batch }, 15_000));
    if (lost(s, res)) {
      await startResend(res.timeline);
      throw new Resend();
    }
    await update((cur) => {
      cur.outbox = cur.outbox.filter((m) => m.id > res.lastMutationId);
      for (const r of res.rejected) {
        const m = batch.find((x) => x.id === r.id);
        // The server no longer has the file this book points at: store it again, and meanwhile
        // send the book without it.
        if (r.code !== 'file_missing' || !m || (m.type !== 'book.put' && m.type !== 'book.files')) continue;
        const bookId = m.type === 'book.put' ? m.book.id : m.bookId;
        if (m.type === 'book.put') enqueue(cur, { type: 'book.put', book: { ...m.book, fileId: null, coverId: null } });
        if (!cur.uploads.includes(bookId)) cur.uploads.push(bookId);
        cur.recheck = [...new Set([...(cur.recheck ?? []), bookId])];
      }
    });
    for (const r of res.rejected) console.warn('The server didn’t take a change:', r);
  }
}

async function pullNow() {
  const s = await read();
  const res = await signedIn(() => api.get<PullResponse>(`/v1/sync/pull?since=${s.rev}`));
  if (lost(s, res)) {
    await startResend(res.timeline);
    throw new Resend();
  }
  let settings = false;
  await withData(async () => {
    await host!.settleLocked();
    const cur = await load();
    if (res.books.length || res.reads.length || res.settings || res.full) await host!.applyLocked(res, cur.outbox);
    settings = !!res.settings && !cur.outbox.some((m) => m.type === 'settings.put');
    cur.rev = res.rev;
    if (res.timeline) cur.timeline = res.timeline;
    await save(cur);
  });
  if (settings) applySettings(res.settings!);
  if (res.lapsed) host!.lapsed(res.lapsed);
  void fetchCovers(res.books);
}

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

/** Hash, ask, upload straight to storage, confirm. Returns the server's file id. */
async function uploadBlob(blob: Blob, mime: string, kind: UploadRequest['kind']): Promise<string> {
  const sha256 = hex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  const ask = await signedIn(() => api.post<UploadResponse>('/v1/uploads', { sha256, size: blob.size, mime, kind }));
  if (ask.status === 'upload' && ask.upload) {
    const put = await fetch(ask.upload.url, { method: 'PUT', headers: ask.upload.headers, body: blob });
    if (!put.ok) throw new Error(`The upload was refused (${put.status}).`);
    await signedIn(() => api.post(`/v1/uploads/${ask.fileId}/complete`));
  }
  return ask.fileId;
}

/** Whether this browser's library has a key, and so a place on the server for files. */
export const hasKey = () => !!host?.snapshot().key;

/** Stores one of this library's files that isn't a book (a voice, a voice's sample). Returns its id. */
export async function storeFile(blob: Blob, mime: string, kind: 'voice' | 'sample'): Promise<string> {
  if (!hasKey()) throw new Error('Uploading needs a library key. Make one in the library first.');
  // A library that just got its key is registered by its first sync.
  if (!(await read()).registered) await flush();
  return uploadBlob(blob, mime, kind);
}

async function uploadAll() {
  const s = await read();
  const recheck = new Set(s.recheck ?? []);
  for (const id of s.uploads) {
    const rec = host!.snapshot().records.find((r) => r.id === id);
    const drop = () => update((cur) => {
      cur.uploads = cur.uploads.filter((x) => x !== id);
      cur.recheck = (cur.recheck ?? []).filter((x) => x !== id);
    });
    if (!rec || rec.source !== 'file' || rec.origin) { await drop(); continue; }
    const again = recheck.has(id);
    try {
      let fileId = rec.fileId;
      if (!fileId || again) {
        // Asking again costs nothing when the server has the file: it answers "ready".
        const data = await store.get<Blob | string>(`file:${id}`);
        if (data === undefined) {
          if (!fileId) host!.notice(`“${rec.title}” couldn’t be kept in this browser, so it didn’t sync. Remove it and add the file again.`);
          await drop();
          continue;
        }
        const mime = MIME[rec.format];
        fileId = await uploadBlob(typeof data === 'string' ? new Blob([data], { type: mime }) : data, mime, 'book');
      }
      let coverId = rec.coverId;
      if ((!coverId || again) && rec.hasCover) {
        const cover = await store.get<Blob>(`cover:${id}`);
        if (cover && COVER_TYPES.has(cover.type)) coverId = await uploadBlob(cover, cover.type, 'cover');
      }
      await host!.linked(id, { fileId, coverId });
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

/** Push everything queued, upload waiting files, then pull. Safe to call any time, from any tab. */
export function flush(): Promise<void> {
  flushing ??= withSync(async () => {
    if (!host) return;
    // This tab's latest changes join the outbox first.
    await withData(() => host!.settleLocked());
    if (!(await read()).libraryId) return setStatus({ state: 'off' });
    setStatus({ state: 'syncing' });
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await withData(queueSnapshotLocked);
          if (!(await read()).registered) await register();
          await pushAll();
          if ((await read()).uploads.length) {
            await uploadAll();
            await pushAll();
          }
          await pullNow();
          break;
        } catch (e) {
          // A resend starts over from the snapshot, once or twice at most.
          if (!(e instanceof Resend) || attempt >= 2) throw e;
        }
      }
      setStatus({ state: 'synced', lastSynced: Date.now(), message: undefined });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'library_moved') movedAway = true;
      if (e instanceof OfflineError) setStatus({ state: 'offline', message: e.message });
      else {
        console.warn('Sync failed:', e);
        if (!(e instanceof ApiError && e.status < 500)) report(e, { in: 'sync' });
        setStatus({ state: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    }
  }).finally(() => { flushing = null; });
  return flushing;
}

/**
 * A stored file, fetched through a short-lived signed link. A shared book's file (`shelf`) comes
 * from the Shared Library, which needs no key, and otherwise from this library, whose copies of
 * shared books keep their file after it leaves the shelf once they're read far enough into.
 */
export async function downloadFile(fileId: string, shelf = false): Promise<Blob> {
  const id = encodeURIComponent(fileId);
  let link: { url: string } | null = null;
  if (shelf) {
    try {
      link = await api.get<{ url: string }>(`/v1/shelf/files/${id}/link`);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404) || !host?.snapshot().key) throw e;
    }
  }
  link ??= await signedIn(() => api.get<{ url: string }>(`/v1/files/${id}/link`));
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
  if ((await read()).libraryId) await flush();
  // No tab may sync while the session moves to the other library, or it would push this one's
  // changes there.
  const all = await withSync(async () => {
    if (!(await saved())) throw new Error('Breader couldn’t save this browser’s books to their own library first. Try again when you’re online.');
    const r = await api.post<LibraryResponse>('/v1/session/key', { key });
    return swapLocked(r.library.id, key);
  });
  opened(all);
}

/** This browser's library is all on the server, or has nowhere left to go. Call holding the sync lock. */
async function saved() {
  const s = await read();
  return !s.libraryId || movedAway || (s.registered && !s.needsSnapshot && !s.outbox.length && !s.uploads.length);
}

/** Replaces this browser's library with the one the session is now open on. Call holding the sync lock. */
async function swapLocked(libraryId: string, key: string | null) {
  const pull = await api.get<PullResponse>('/v1/sync/pull?since=0');
  await withData(async () => {
    await host!.replaceLocked(pull, key);
    await save({ ...fresh(libraryId), registered: true, rev: pull.rev, timeline: pull.timeline });
  });
  movedAway = false;
  return pull;
}

function opened(pull: PullResponse) {
  if (pull.settings) applySettings(pull.settings);
  host?.lapsed(pull.lapsed ?? []);
  setStatus({ state: 'synced', lastSynced: Date.now(), message: undefined });
  void fetchCovers(pull.books);
}

/**
 * After a login (lib/account.ts), this browser moves to the account's library (routes/account.ts).
 * Its own library is saved to the server first, so the server sees what it holds. If that is books
 * the account doesn't have, nothing changes yet: the answer is 'choose', and the caller asks the
 * reader, then calls again with claim set.
 */
export async function enterAccount(claim?: boolean): Promise<AccountResponse> {
  if (!host) throw new Error('Breader is still starting. Try again in a moment.');
  if ((await read()).libraryId) await flush();
  const out = await withSync(async () => {
    if (!(await saved())) throw new Error('Breader couldn’t save the books in this browser first. Try again when you’re online.');
    const key = host!.snapshot().key;
    const res = await api.post<AccountResponse>('/v1/session/account', { key: key ?? undefined, claim }, 30_000);
    // Adopted and same: this browser already holds the account's library. Unless its session is all
    // it has: a phone's home-screen app starts with the login Safari had, and none of its storage.
    const held = res.outcome === 'same' && (await read()).libraryId === res.library?.id;
    if (res.outcome === 'choose' || res.outcome === 'adopted' || held) return { res };
    return { res, pull: await swapLocked(res.library!.id, res.key ?? null) };
  });
  if (out.pull) opened(out.pull);
  else if (out.res.outcome !== 'choose') void flush();
  return out.res;
}

/** Starts syncing once the local library has loaded. */
export async function startSync(h: SyncHost) {
  host = h;
  seen = await read();
  // A library keyed before the backend existed: register it and send everything once.
  if (h.snapshot().key && !seen.libraryId) await adopt();

  window.addEventListener('online', () => void flush());
  window.addEventListener('focus', () => void flush());
  document.addEventListener('visibilitychange', () => void flush());
  window.setInterval(() => { if (document.visibilityState === 'visible') void flush(); }, 120_000);
  // Another tab changed the outbox: keep this tab's sync line current.
  onNews((news) => {
    if (news === 'sync') void read().then((s) => { seen = s; setStatus({}); });
  });

  await flush();
  void fetchCovers(h.snapshot().records.filter((r) => r.coverId).map((r) => ({ id: r.id, coverId: r.coverId!, removedAt: null })));
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
