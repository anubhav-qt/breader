import { useEffect, useSyncExternalStore } from 'react';
import { LIBRARY_NAME, LIBRARY_NAME_CHARS } from '@breader/shared/protocol';
import type { SharedBooksResponse, SharedOpenResponse, ShelfBook } from '@breader/shared/protocol';
import type { BookRecord } from '../books/types';
import { readSetting, writeSetting } from '../features/reader/settings';
import { api, ApiError } from '../lib/api';
import { store } from '../lib/store';

/*
 * Shared libraries. Each reader's key opens the books they share (server routes/shelf.ts): anyone
 * they give it to can read them and copy them, never change them. The reader's own shared books
 * come from their own library. Each key of someone else's adds a library of its own to a list,
 * Shared 1, 2 and on until the reader names it, kept by the token the key was traded for (never
 * the key) in the synced reader settings, so the list follows the reader between browsers, and so
 * does which library the tab opens at: the reader's pick, or the first in the list. Each library's
 * last list of books is kept here too, so the tab opens at once and offline.
 */

export interface SavedLibrary {
  token: string;
  /** The reader's own name for it, over Shared N. */
  name?: string;
  /** Its N in Shared N: the lowest free when it was added. */
  n?: number;
  at: number;
}

export interface SharedLibrary {
  books: ShelfBook[];
  /** What its owner named it. */
  name: string | null;
  /** `closed`: the key doesn't open it any more; its owner may have a new one. */
  state: 'loading' | 'ready' | 'closed';
}

/** Which library the tab shows: the reader's own shared books, or someone's by their token. */
export type Showing = 'own' | string;

interface Shared {
  saved: SavedLibrary[];
  libs: Record<string, SharedLibrary>;
  /** Object URLs of the covers this browser has fetched, by shared book id. */
  covers: Record<string, string>;
  showing: Showing;
  /** The library the tab opens at. */
  byDefault: Showing;
  /** The reader's name for their own library, which the people they share it with see. */
  ownName: string | null;
}

const SAVED = 'sharedLibraries';
/** The library id the tab opens at, or 'own'; unset, the first in the list. */
const DEFAULT = 'sharedDefault';
const REFRESH_AFTER = 30_000;
/** Covers are fetched for the newest books only; the library shows only the two most recent. */
const COVERS = 12;

const counted = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0;
/** The lowest N no library in the list has. */
const freeNumber = (list: SavedLibrary[]) => {
  const used = new Set(list.map((l) => l.n));
  let n = 1;
  while (used.has(n)) n++;
  return n;
};
const savedNow = () => {
  const v = readSetting(SAVED);
  const list = Array.isArray(v) ? (v as SavedLibrary[]).filter((l) => typeof l?.token === 'string') : [];
  // Libraries added before they were numbered take the lowest numbers free, in the list's order.
  const out: SavedLibrary[] = list.map((l) => (counted(l.n) ? l : { ...l, n: undefined }));
  for (const l of out) if (!counted(l.n)) l.n = freeNumber(out);
  return out;
};
/** The library a token opens: the same library whoever's key gave it. */
const libraryOf = (token: string) => token.slice(0, token.lastIndexOf('.'));
const defaultNow = (saved: SavedLibrary[]): Showing => {
  const v = readSetting(DEFAULT);
  if (v === 'own') return 'own';
  return saved.find((l) => libraryOf(l.token) === v)?.token ?? saved[0]?.token ?? 'own';
};
const ownNameNow = () => {
  const v = readSetting(LIBRARY_NAME);
  return typeof v === 'string' && v.trim() ? v.trim() : null;
};

const savedAtStart = savedNow();
const defaultAtStart = defaultNow(savedAtStart);
let shared: Shared = { saved: savedAtStart, libs: {}, covers: {}, showing: defaultAtStart, byDefault: defaultAtStart, ownName: ownNameNow() };
const subscribers = new Set<() => void>();
const fetched = new Map<string, number>();
const fetching = new Map<string, Promise<void>>();

function set(next: Partial<Shared>) {
  shared = { ...shared, ...next };
  subscribers.forEach((s) => s());
}
const libOf = (token: string): SharedLibrary | undefined => shared.libs[token];
const setLib = (token: string, patch: Partial<SharedLibrary>) =>
  set({ libs: { ...shared.libs, [token]: { books: [], name: null, state: 'loading', ...libOf(token), ...patch } } });


/** A library's books again, at most every 30 seconds unless asked to now. */
export function refreshLibrary(token: string, now = false): Promise<void> {
  const busy = fetching.get(token);
  if (busy || (!now && Date.now() - (fetched.get(token) ?? 0) < REFRESH_AFTER)) return busy ?? Promise.resolve();
  fetched.set(token, Date.now());
  const p = (async () => {
    try {
      const { books, name } = await api.post<SharedBooksResponse>('/v1/shared/books', { token }, 10_000);
      setLib(token, { books, name, state: 'ready' });
      await store.set(`shared:${token}`, { books, name });
      void loadCovers(token, books);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'shared_closed') setLib(token, { books: [], state: 'closed' });
      // Offline, or the server is away: keep the list from last time.
    } finally {
      fetching.delete(token);
    }
  })();
  fetching.set(token, p);
  return p;
}

async function loadCovers(token: string, books: ShelfBook[]) {
  for (const b of books.slice(0, COVERS)) {
    if (!b.coverId || shared.covers[b.id]) continue;
    let blob = await store.get<Blob>(`shelfcover:${b.id}`);
    if (!blob) {
      try {
        const link = await api.post<{ url: string }>('/v1/shared/link', { token, fileId: b.coverId });
        const res = await fetch(link.url);
        if (!res.ok) continue;
        blob = await res.blob();
        await store.set(`shelfcover:${b.id}`, blob);
      } catch {
        continue;
      }
    }
    set({ covers: { ...shared.covers, [b.id]: URL.createObjectURL(blob) } });
  }
}

/** The library's last list, from this browser, while the server is asked again. */
async function warm(token: string) {
  if (!libOf(token)) {
    const kept = await store.get<{ books: ShelfBook[]; name: string | null }>(`shared:${token}`);
    if (kept && !libOf(token)?.books.length) {
      setLib(token, { ...kept, state: 'ready' });
      void loadCovers(token, kept.books);
    }
  }
  void refreshLibrary(token);
}

const keepSaved = (saved: SavedLibrary[]) => {
  writeSetting(SAVED, saved);
  set({ saved, byDefault: defaultNow(saved) });
};

/** Shows one library in the tab, until the next visit opens at the default again. */
export function showLibrary(which: Showing) {
  set({ showing: which });
  if (which !== 'own') void warm(which);
}

/** The library the tab opens at, in every browser the reader uses. */
export function setDefaultLibrary(which: Showing) {
  // The tab stays on the library it shows now.
  const { showing } = shared;
  writeSetting(DEFAULT, which === 'own' ? 'own' : libraryOf(which));
  set({ byDefault: defaultNow(shared.saved), showing });
}

/**
 * Adds someone's library to the list by their key, as a library of its own, and shows it. Nothing
 * of theirs goes into the reader's own books. The same key again finds the same library; the
 * reader's own key shows their own shared books.
 */
export async function addLibrary(key: string): Promise<{ own: boolean; label: string; token: string }> {
  const r = await api.post<SharedOpenResponse>('/v1/shared/open', { key: key.trim() });
  if (r.own) {
    showLibrary('own');
    return { own: true, label: libraryName(shared, 'own'), token: r.token };
  }
  // The same library again, with a newer token if its key changed since.
  const had = shared.saved.find((l) => libraryOf(l.token) === libraryOf(r.token));
  keepSaved(had
    ? shared.saved.map((l) => (l === had ? { ...had, token: r.token } : l))
    : [...shared.saved, { token: r.token, n: freeNumber(shared.saved), at: Date.now() }]);
  setLib(r.token, { name: r.name });
  fetched.delete(r.token);
  showLibrary(r.token);
  return { own: false, label: libraryName(shared, r.token), token: r.token };
}

/** Takes a library off the list. Copies of its books already in the reader's library stay. */
export function removeLibrary(token: string) {
  if (readSetting(DEFAULT) === libraryOf(token)) writeSetting(DEFAULT, null);
  keepSaved(shared.saved.filter((l) => l.token !== token));
  if (shared.showing === token) showLibrary(shared.byDefault);
}

/** Names the reader's own library, for everyone it's shared with, or their entry for someone else's. */
export function renameLibrary(which: Showing, name: string) {
  const clean = name.trim().slice(0, LIBRARY_NAME_CHARS);
  if (which === 'own') {
    set({ ownName: clean || null });
    writeSetting(LIBRARY_NAME, clean);
    return;
  }
  keepSaved(shared.saved.map((l) => (l.token === which ? { ...l, name: clean || undefined } : l)));
}

/** A library's name: the reader's own for it, or Shared for their own and Shared N for someone else's. */
export function libraryName(s: Shared, which: Showing): string {
  if (which === 'own') return s.ownName ?? 'Shared';
  const l = s.saved.find((x) => x.token === which);
  return l?.name ?? `Shared ${l?.n ?? ''}`.trim();
}

/** A library in the list that shares this file, to fetch it through, for a book not yet the reader's own. */
export function tokenForFile(fileId: string): string | null {
  for (const l of shared.saved) {
    if (shared.libs[l.token]?.books.some((b) => b.fileId === fileId || b.coverId === fileId)) return l.token;
  }
  return null;
}

/** The cover this browser holds for a shared book, to give a copy of it the same one. */
export const shelfCover = (id: string) => store.get<Blob>(`shelfcover:${id}`);

/** A shared series' cover, which comes from its catalogue rather than the sharer: kept, and shown. */
export async function keepShelfCover(id: string, blob: Blob) {
  await store.set(`shelfcover:${id}`, blob);
  set({ covers: { ...shared.covers, [id]: URL.createObjectURL(blob) } });
}

/** A shared book as a card, as its owner has it. Starting it makes a copy in the reader's library. */
export function shelfRecord(b: ShelfBook): BookRecord {
  return {
    id: b.id,
    title: b.title,
    author: b.author,
    format: b.format,
    source: 'shelf',
    shared: true,
    addedAt: b.addedAt,
    words: b.words,
    color: b.color,
    hasCover: !!b.coverId,
    progress: 0,
    line: b.line,
    lastOpened: b.addedAt,
    ...(b.fileId ? { fileId: b.fileId } : {}),
    ...(b.url ? { url: b.url } : {}),
    ...(b.origin ? { origin: b.origin } : {}),
    ...(b.coverId ? { coverId: b.coverId } : {}),
    ...(b.series ? { series: b.series } : {}),
    ...(b.seriesIndex != null ? { seriesIndex: b.seriesIndex } : {}),
    ...(b.genre ? { genre: b.genre } : {}),
  };
}

let started = false;
function start() {
  // Changed on another browser (sync) or in another tab.
  window.addEventListener('breader:settings', () => {
    const saved = savedNow();
    const byDefault = defaultNow(saved);
    // A tab still at the default follows it, as the list first arrives in a new browser.
    const kept = shared.showing !== shared.byDefault && (shared.showing === 'own' || saved.some((l) => l.token === shared.showing));
    const showing = kept ? shared.showing : byDefault;
    set({ saved, byDefault, ownName: ownNameNow(), showing });
  });
  // Every library in the list, so its books can be opened and fetched from wherever the reader is.
  for (const l of shared.saved) void warm(l.token);
  const again = () => { if (shared.showing !== 'own') void refreshLibrary(shared.showing); };
  window.addEventListener('focus', again);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') again(); });
}

const subscribe = (fn: () => void) => {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
};
const get = () => shared;

export function useShared() {
  useEffect(() => {
    if (started) return;
    started = true;
    start();
  }, []);
  return useSyncExternalStore(subscribe, get);
}

export type { Shared };
