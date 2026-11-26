import { useEffect, useSyncExternalStore, type RefObject } from 'react';
import { LIBRARY_NAME, LIBRARY_NAME_CHARS } from '@breader/shared/limits';
import type { FeedLibrary, FeedResponse, LibraryAsk, SharedAnswerResponse, SharedAskResponse, SharedAsksResponse, SharedBooksResponse, SharedCopyResponse, SharedCreateResponse, SharedKeyResponse, SharedNameResponse, SharedOpenResponse, SharedPublicResponse, SharedRemoveResponse, ShelfBook } from '@breader/shared/protocol';
import { categoryOf } from '../books/category';
import { remoteCover, remoteOf } from '../books/remote';
import { feedName } from '../features/shared/facts';
import type { BookRecord } from '../books/types';
import { readSetting, writeSetting } from '../features/reader/settings';
import { api, ApiError } from '../lib/api';
import { whenInView } from '../lib/inView';
import { store } from '../lib/store';
import { signedIn } from './sync';

/*
 * Shared libraries. Each reader's key opens the books they share (server routes/shelf.ts): anyone
 * they give it to can read them and copy them, never change them. The reader's own shared books
 * come from their own library. Each key of someone else's adds a library of its own to a list,
 * Shared 1, 2 and on until the reader names it, kept by the token the key was traded for (never
 * the key) in the synced reader settings, so the list follows the reader between browsers, and so
 * does which library the tab opens at: the reader's pick, or the first in the list. Each library's
 * last list of books is kept here too, so the tab opens at once and offline.
 *
 * A library its owner makes public is in the public feed for everyone, with a token that only reads
 * it. Saving one from the feed makes a copy of the reader's own (server routes/shelf.ts): it takes in
 * what the original adds and keeps what it loses, and only the reader, or whoever they give its key
 * to, takes books out. To change the original they ask its owner, whose yes gives them a token of
 * their own (`copy.grant`) that the owner can take back.
 */

export interface SavedLibrary {
  token: string;
  /** The reader's own name for it, over Shared N. */
  name?: string;
  /** Its N in Shared N: the lowest free when it was added. */
  n?: number;
  at: number;
  /** A copy saved from the feed: the original's id, so it counts as a save of it there. */
  of?: string;
}

export interface SharedLibrary {
  books: ShelfBook[];
  /** What its owner named it. */
  name: string | null;
  /** `closed`: the key doesn't open it any more; its owner may have a new one. */
  state: 'loading' | 'ready' | 'closed';
  /** It's in the public feed. */
  public: boolean;
  /** key: opened with its key, to change; grant: by its owner's yes to the reader; public: from the feed, to read only. */
  access: 'key' | 'grant' | 'public';
  /** The reader may put it in the feed or take it out: they have the key to a library made only to share. */
  mayPublish: boolean;
  /** The reader may name it for everyone it's open to: they have the key to a library made only to share, copies too. */
  mayName: boolean;
  /** A copy saved from the feed: its original's id, the reader's ask to change it, and the token a yes gave. */
  copy?: SharedBooksResponse['copy'];
}

/** The public feed, as last fetched. */
export interface Feed {
  libraries: FeedLibrary[];
  state: 'loading' | 'ready' | 'error';
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
  feed: Feed;
  /** The reader's own library is in the feed; null until the server says. */
  ownPublic: boolean | null;
  /** Asks to change the reader's libraries, waiting or given, by library, once fetched. */
  asks: Record<Showing, LibraryAsk[]>;
}

const SAVED = 'sharedLibraries';
/** The library id the tab opens at, or 'own'; unset, the first in the list. */
const DEFAULT = 'sharedDefault';
const REFRESH_AFTER = 30_000;
/** Covers fetched at a time, as their cards come near the screen. */
const COVERS_AT_ONCE = 4;

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
let shared: Shared = {
  saved: savedAtStart,
  libs: {},
  covers: {},
  showing: defaultAtStart,
  byDefault: defaultAtStart,
  ownName: ownNameNow(),
  feed: { libraries: [], state: 'loading' },
  ownPublic: null,
  asks: {},
};
const subscribers = new Set<() => void>();
const fetched = new Map<string, number>();
const fetching = new Map<string, Promise<void>>();

function set(next: Partial<Shared>) {
  shared = { ...shared, ...next };
  subscribers.forEach((s) => s());
}
const libOf = (token: string): SharedLibrary | undefined => shared.libs[token];
const setLib = (token: string, patch: Partial<SharedLibrary>) =>
  set({ libs: { ...shared.libs, [token]: { books: [], name: null, state: 'loading', public: false, access: 'public', mayPublish: false, mayName: false, ...libOf(token), ...patch } } });


/** A library's books again, at most every 30 seconds unless asked to now. */
export function refreshLibrary(token: string, now = false): Promise<void> {
  const busy = fetching.get(token);
  if (busy || (!now && Date.now() - (fetched.get(token) ?? 0) < REFRESH_AFTER)) return busy ?? Promise.resolve();
  fetched.set(token, Date.now());
  const p = (async () => {
    try {
      const r = await api.post<SharedBooksResponse>('/v1/shared/books', { token }, 10_000);
      const { books, name } = r;
      const facts = { public: r.public, access: r.access, mayPublish: r.mayPublish, mayName: r.mayName, copy: r.copy };
      setLib(token, { books, name, state: 'ready', ...facts });
      await store.set(`shared:${token}`, { books, name, ...facts });
      // A card already seen whose cover came since: a new one, or one the model said yes to.
      for (const b of books) {
        if (seenCards.has(b.id)) wantShelfCover(b.id);
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'shared_closed') {
        setLib(token, { books: [], state: 'closed' });
        forgetGrant(token);
      }
      // Offline, or the server is away: keep the list from last time.
    } finally {
      fetching.delete(token);
    }
  })();
  fetching.set(token, p);
  return p;
}

/** A grant its owner took back: the copy that held it asks anew, so it stops offering the original. */
function forgetGrant(token: string) {
  for (const l of shared.saved) {
    const copy = libOf(l.token)?.copy;
    if (copy?.grant === token) void refreshLibrary(l.token, true);
  }
}

/**
 * Where a shared book's cover comes from: a series from a manga site has it there, as in Browse;
 * any other from its sharer, unless it's a book's cover waiting for the model's yes, or one it said
 * no to (server jobs/covers.ts). Null: none to show.
 */
export function coverFrom(b: ShelfBook): 'site' | 'sharer' | null {
  if (remoteOf(b.url)) return 'site';
  if (!b.coverId) return null;
  if (categoryOf(b) === 'books' && b.coverOk === false) return null;
  return 'sharer';
}

async function fetchCover(token: string, b: ShelfBook): Promise<Blob | undefined> {
  const from = coverFrom(b);
  if (!from) return undefined;
  const kept = await store.get<Blob>(`shelfcover:${b.id}`);
  if (kept) return kept;
  let blob: Blob | undefined;
  if (from === 'site') {
    blob = await remoteCover(b.url);
  } else {
    try {
      const link = await api.post<{ url: string }>('/v1/shared/link', { token, fileId: b.coverId });
      const res = await fetch(link.url);
      if (res.ok) blob = await res.blob();
    } catch {
      // Offline, or the server is away: the drawn card until the next visit.
    }
  }
  if (blob) await store.set(`shelfcover:${b.id}`, blob);
  return blob;
}

/** The library holding a shared book, and the book, while this browser has its list. */
function bookOf(id: string): { token: string; book: ShelfBook } | null {
  for (const [token, lib] of Object.entries(shared.libs)) {
    const book = lib.books.find((b) => b.id === id);
    if (book) return { token, book };
  }
  return null;
}

/** Books whose cards came near the screen this visit, and the covers asked for (book id and cover). */
const seenCards = new Set<string>();
const askedCovers = new Set<string>();
const coverQueue: Array<() => Promise<void>> = [];
let coversRunning = 0;

function nextCover() {
  while (coversRunning < COVERS_AT_ONCE && coverQueue.length > 0) {
    const job = coverQueue.shift()!;
    coversRunning++;
    void job().finally(() => {
      coversRunning--;
      nextCover();
    });
  }
}

/** A shared book's cover, once its card comes near the screen (useShelfCover). */
export function wantShelfCover(id: string) {
  seenCards.add(id);
  if (shared.covers[id]) return;
  const found = bookOf(id);
  if (!found) return;
  // None yet (one waiting for the model's yes): asked again when the library's list next changes it.
  if (!coverFrom(found.book)) return;
  const asked = `${id}:${found.book.coverId ?? found.book.url}`;
  if (askedCovers.has(asked)) return;
  askedCovers.add(asked);
  coverQueue.push(async () => {
    const blob = await fetchCover(found.token, found.book);
    if (blob) set({ covers: { ...shared.covers, [id]: URL.createObjectURL(blob) } });
  });
  nextCover();
}

/** A card of someone's shared book asks for its cover as it first comes near the screen. */
export function useShelfCover(ref: RefObject<HTMLElement | null>, book: { id: string; source: BookRecord['source']; coverUrl?: string }) {
  const wants = book.source === 'shelf' && !book.coverUrl;
  const id = book.id;
  useEffect(() => {
    const el = ref.current;
    if (!wants || !el) return;
    return whenInView(el, () => wantShelfCover(id));
  }, [ref, wants, id]);
}

/** A feed library's books, for its row, once the row comes into view (PublicFeed.tsx). */
export function warmLibrary(token: string) {
  void warm(token);
}

/** The library's last list, from this browser, while the server is asked again. */
async function warm(token: string) {
  if (!libOf(token)) {
    const kept = await store.get<Pick<SharedLibrary, 'books' | 'name'> & Partial<SharedLibrary>>(`shared:${token}`);
    if (kept && !libOf(token)?.books.length) {
      setLib(token, { ...kept, state: 'ready' });
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
  setLib(r.token, { name: r.name, access: 'key' });
  fetched.delete(r.token);
  showLibrary(r.token);
  return { own: false, label: libraryName(shared, r.token), token: r.token };
}

/**
 * Makes a new library only to share, by its name, adds it to the list and shows it. Its key, to give
 * to the people it's for, comes back with it, and from libraryKey() any time after.
 */
export async function createLibrary(name: string): Promise<{ token: string; key: string; label: string }> {
  const r = await api.post<SharedCreateResponse>('/v1/shared/create', { name: name.trim() });
  keepSaved([...shared.saved, { token: r.token, n: freeNumber(shared.saved), at: Date.now() }]);
  setLib(r.token, { name: r.name, books: [], state: 'ready', access: 'key', mayPublish: true, mayName: true });
  fetched.set(r.token, Date.now());
  return { token: r.token, key: r.key, label: libraryName(shared, r.token) };
}

/** The key of a library made only to share, to give out; null for someone's own library, whose key stays theirs. */
export async function libraryKey(token: string): Promise<string | null> {
  return (await api.post<SharedKeyResponse>('/v1/shared/key', { token })).key;
}

/** Takes a library off the list. Copies of its books already in the reader's library stay. */
export function removeLibrary(token: string) {
  if (readSetting(DEFAULT) === libraryOf(token)) writeSetting(DEFAULT, null);
  keepSaved(shared.saved.filter((l) => l.token !== token));
  if (shared.showing === token) showLibrary(shared.byDefault);
}

/**
 * Names a library. The reader's own, or one made only to share they hold the key to, is named for
 * everyone it's open to, in the feed too; someone else's is named only in the reader's own list.
 */
export async function renameLibrary(which: Showing, name: string): Promise<void> {
  const clean = name.trim().slice(0, LIBRARY_NAME_CHARS);
  if (which === 'own') {
    set({ ownName: clean || null });
    writeSetting(LIBRARY_NAME, clean);
    nameInFeed((l) => l.own === true, clean);
    return;
  }
  // Not known yet whether it's one made only to share (just opened, or kept from before): asked first.
  if (!shared.libs[which]?.mayName) await refreshLibrary(which, true);
  if (shared.libs[which]?.mayName) {
    const r = await api.post<SharedNameResponse>('/v1/shared/name', { token: which, name: clean });
    setLib(which, { name: r.name });
    // Its name is its owner's now: no name of the reader's own over it.
    keepSaved(shared.saved.map((l) => (l.token === which ? { ...l, name: undefined } : l)));
    nameInFeed((l) => libraryOf(l.token) === libraryOf(which), r.name ?? '');
    return;
  }
  keepSaved(shared.saved.map((l) => (l.token === which ? { ...l, name: clean || undefined } : l)));
}

/** The new name on the feed's row for a library, at once, not on the feed's next ask. */
function nameInFeed(isIt: (l: FeedLibrary) => boolean, name: string) {
  const libraries = shared.feed.libraries.map((l) => (isIt(l) ? { ...l, name: name || null } : l));
  set({ feed: { ...shared.feed, libraries } });
}

/** A library's name: the reader's own for it, else what its owner named it, or Shared for their own and Shared N for someone else's. */
export function libraryName(s: Shared, which: Showing): string {
  if (which === 'own') return s.ownName ?? 'Shared';
  const l = s.saved.find((x) => x.token === which);
  if (l) return l.name ?? s.libs[which]?.name ?? `Shared ${l.n ?? ''}`.trim();
  // The original of a copy in the list, by the token its owner's yes gave.
  const copy = s.saved.find((x) => s.libs[x.token]?.copy?.grant === which);
  if (copy) return `${libraryName(s, copy.token)} (original)`;
  const row = s.feed.libraries.find((x) => x.token === which);
  if (row) return feedName(row);
  return s.libs[which]?.name ?? 'Shared';
}

/**
 * A library that shares this file, to fetch it through, for a book not yet the reader's own: one in
 * the list first, else one looked at in the feed.
 */
export function tokenForFile(fileId: string): string | null {
  const has = (token: string) => !!shared.libs[token]?.books.some((b) => b.fileId === fileId || b.coverId === fileId);
  for (const l of shared.saved) {
    if (has(l.token)) return l.token;
  }
  for (const token of Object.keys(shared.libs)) {
    if (has(token)) return token;
  }
  return null;
}

let feedFetching: Promise<void> | null = null;

/** The public feed again, and the libraries' books for their rows; one ask at a time. */
export function refreshFeed(): Promise<void> {
  if (feedFetching) return feedFetching;
  feedFetching = loadFeed().finally(() => {
    feedFetching = null;
  });
  return feedFetching;
}

/**
 * The reader's own library's row with the name it has here: a new name reaches the server with the
 * next sync, and the feed may be asked before that.
 */
function withOwnName(l: FeedLibrary): FeedLibrary {
  if (!l.own) return l;
  return { ...l, name: shared.ownName };
}

async function loadFeed(): Promise<void> {
  try {
    const { libraries } = await api.get<FeedResponse>('/v1/shared/feed', 10_000);
    set({ feed: { libraries: libraries.map(withOwnName), state: 'ready' } });
  } catch {
    // Offline, or the server is away: the feed from last time, if there was one.
    if (shared.feed.state === 'loading') set({ feed: { ...shared.feed, state: 'error' } });
  }
}

/** Whether the reader's own library is in the feed, once the server says. With no library here, it stays unknown: nothing to make public. */
export async function loadOwnPublic(): Promise<void> {
  try {
    const r = await api.get<SharedPublicResponse>('/v1/shared/public', 10_000);
    set({ ownPublic: r.public });
  } catch {
    // Signed out, offline or the server away: no switch until it says.
  }
}

/** Puts a library in the feed or takes it out: the reader's own, or one made only to share they have the key to. */
export async function setPublic(which: Showing, on: boolean): Promise<void> {
  const body: { on: boolean; token?: string } = { on };
  if (which !== 'own') body.token = which;
  const r = await api.post<SharedPublicResponse>('/v1/shared/public', body);
  if (which === 'own') set({ ownPublic: r.public });
  else setLib(which, { public: r.public });
  // Taken out, every ask and yes to change it ended with it.
  if (!r.public) void loadAsks(which);
  // Asked anew, not joined to an ask from before the change.
  void loadFeed();
}

/** The library a token opens is in the reader's list already, by either kind of token, or a copy of it is. */
export const isSaved = (s: Shared, token: string) => s.saved.some((l) => sameLibrary(l, token));

/** This entry in the list is the library a token opens, or a copy of it. */
const sameLibrary = (l: SavedLibrary, token: string) => libraryOf(l.token) === libraryOf(token) || l.of === libraryOf(token);

/**
 * Which of the reader's libraries a feed library is, to rename it there: their own, or one made only
 * to share they hold the key to. Null when it isn't theirs.
 */
export function yoursAs(s: Shared, l: FeedLibrary): Showing | null {
  if (l.own) return 'own';
  const held = s.saved.find((x) => libraryOf(x.token) === libraryOf(l.token) && s.libs[x.token]?.mayPublish === true);
  if (held) return held.token;
  return null;
}

/** The reader's own library, or one made only to share they hold the key to: theirs to make public, not to save. */
export function isYours(s: Shared, l: FeedLibrary): boolean {
  return yoursAs(s, l) !== null;
}

const saving = new Map<string, Promise<string>>();

/**
 * Saves a library from the feed to the reader's list as a copy of their own, and returns its name
 * there. `unnamed` names it in the list when its owner gave it no name. One ask at a time.
 */
export function saveLibrary(token: string, unnamed?: string): Promise<string> {
  const had = shared.saved.find((l) => sameLibrary(l, token));
  if (had) return Promise.resolve(libraryName(shared, had.token));
  const busy = saving.get(libraryOf(token));
  if (busy) return busy;
  const p = (async () => {
    const r = await api.post<SharedCopyResponse>('/v1/shared/copy', { token });
    const entry: SavedLibrary = { token: r.token, n: freeNumber(shared.saved), at: Date.now(), of: r.of };
    if (!r.name && unnamed) entry.name = unnamed;
    keepSaved([...shared.saved, entry]);
    setLib(r.token, { name: r.name, access: 'key' });
    void refreshLibrary(r.token, true);
    return libraryName(shared, r.token);
  })().finally(() => saving.delete(libraryOf(token)));
  saving.set(libraryOf(token), p);
  return p;
}

/** Takes a library saved from the feed off the list again, by its feed token. */
export function unsaveLibrary(token: string) {
  const had = shared.saved.find((l) => sameLibrary(l, token));
  if (had) removeLibrary(had.token);
}

/**
 * The token that changes a library, if the reader holds one: its own when opened by a key or a
 * grant, else, for one opened from the feed, the grant on the reader's copy of it.
 */
export function changeToken(s: Shared, token: string): string | null {
  const lib = s.libs[token];
  if (lib?.state === 'closed') return null;
  if (lib?.access === 'key' || lib?.access === 'grant') return token;
  for (const l of s.saved) {
    const copy = s.libs[l.token]?.copy;
    if (copy && copy.of === libraryOf(token) && copy.grant) return copy.grant;
  }
  return null;
}

/** Takes books out of a library the reader may change; out of its sharing only, where they're its owner's own. */
export async function removeFromLibrary(token: string, ids: string[]): Promise<number> {
  let r: SharedRemoveResponse;
  try {
    r = await signedIn(() => api.post<SharedRemoveResponse>('/v1/shared/remove', { token, ids }));
  } catch (e) {
    // Shut to this reader, a grant taken back say: the app learns so before the error shows.
    if (e instanceof ApiError && e.code === 'shared_closed') void refreshLibrary(token, true);
    throw e;
  }
  const lib = libOf(token);
  if (lib) setLib(token, { books: lib.books.filter((b) => !ids.includes(b.id)) });
  void refreshLibrary(token, true);
  return r.removed;
}

/** Asks the owner of a copy's original to let the reader change it, with a note or none. */
export async function askToChange(copyToken: string, note: string): Promise<void> {
  const body: { token: string; note?: string } = { token: copyToken };
  if (note.trim()) body.note = note.trim();
  const r = await signedIn(() => api.post<SharedAskResponse>('/v1/shared/ask', body));
  const copy = libOf(copyToken)?.copy;
  if (copy) setLib(copyToken, { copy: { ...copy, asked: r.asked } });
  void refreshLibrary(copyToken, true);
}

/** The asks to change a library of the reader's: their own, or one made only to share they hold the key to. */
export async function loadAsks(which: Showing): Promise<void> {
  const body: { token?: string } = {};
  if (which !== 'own') body.token = which;
  try {
    const r = await api.post<SharedAsksResponse>('/v1/shared/asks', body, 10_000);
    set({ asks: { ...shared.asks, [which]: r.asks } });
  } catch {
    // Signed out, offline or the server away: none shown until it says.
  }
}

/** Yes or no to an ask; no to one given takes it back. */
export async function answerAsk(which: Showing, id: string, give: boolean): Promise<SharedAnswerResponse['state']> {
  const body: { token?: string; id: string; give: boolean } = { id, give };
  if (which !== 'own') body.token = which;
  const r = await api.post<SharedAnswerResponse>('/v1/shared/answer', body);
  let asks = (shared.asks[which] ?? []).filter((a) => a.id !== id);
  if (r.state === 'given') asks = (shared.asks[which] ?? []).map((a) => (a.id === id ? { ...a, state: 'given' as const } : a));
  set({ asks: { ...shared.asks, [which]: asks } });
  return r.state;
}

/** The cover this browser holds for a shared book, to give a copy of it the same one. */
export const shelfCover = (id: string) => store.get<Blob>(`shelfcover:${id}`);

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

/** The shared libraries as they are this moment, for code that runs after an await. */
export const sharedNow = (): Shared => shared;

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
