import { remoteOf } from '../../books/remote';
import type { BookRecord } from '../../books/types';
import { changeToken, libraryName, type Shared } from '../../data/shelf';

/*
 * The Add to sheet's sums: where a book can go, whether it's there, and what a tick or an untick
 * does. Any book into any library the reader may change, from one ticked list (AddTo.tsx).
 */

/** The reader's own books, their own shared library, or another library by its token. */
export type Place = 'personal' | 'own' | string;

/** A row of the sheet. */
export interface Target {
  place: Place;
  name: string;
  icon: 'lock' | 'globe' | 'people';
}

/** A row's tick: every book the sheet is for is in it, some are, or none. */
export type Tick = 'true' | 'false' | 'mixed';

interface Bookish {
  id: string;
  origin?: string | null;
  url?: string | null;
}

/** The first book a book is a copy of, or itself. */
function firstOf(b: Bookish): string {
  if (b.origin) return b.origin;
  return b.id;
}

/** One book however it came: copies by the first, and a series from a catalogue by where it's read. */
export function sameBook(a: Bookish, b: Bookish): boolean {
  if (firstOf(a) === firstOf(b)) return true;
  const ra = remoteOf(a.url ?? undefined);
  const rb = remoteOf(b.url ?? undefined);
  if (!ra || !rb) return false;
  return ra.key === rb.key;
}

/** The reader's own copy of a book, if they have one. */
export function mineOf(records: BookRecord[], book: Bookish): BookRecord | undefined {
  return records.find((r) => sameBook(r, book));
}

/** A library's own name, without the "(original)" the tab's list gives an original beside its copy. */
function plainName(s: Shared, token: string, copyToken: string): string {
  const own = s.libs[token]?.name;
  if (own) return own;
  return libraryName(s, copyToken);
}

/**
 * Every library the reader may add to, in the order the sheet lists them: their own books (only for
 * someone else's book), their own shared library, then each in their list they may change, with the
 * original of a copy its owner said yes to right after the copy.
 */
export function targetsOf(s: Shared, theirs: boolean, personal: string): Target[] {
  const list: Target[] = [];
  if (theirs) list.push({ place: 'personal', name: personal, icon: 'lock' });
  let ownIcon: Target['icon'] = 'people';
  if (s.ownPublic) ownIcon = 'globe';
  list.push({ place: 'own', name: libraryName(s, 'own'), icon: ownIcon });
  for (const l of s.saved) {
    const lib = s.libs[l.token];
    if (lib?.state === 'closed') continue;
    if (lib?.access === 'public') continue;
    list.push({ place: l.token, name: libraryName(s, l.token), icon: lib?.public ? 'globe' : 'people' });
    const grant = lib?.copy?.grant;
    if (!grant) continue;
    let icon: Target['icon'] = 'globe';
    if (s.libs[grant] && !s.libs[grant].public) icon = 'people';
    list.push({ place: grant, name: plainName(s, grant, l.token), icon });
  }
  return list;
}

/** Whether a library holds this book. */
export function holds(s: Shared, records: BookRecord[], place: Place, book: Bookish): boolean {
  const mine = mineOf(records, book);
  if (place === 'personal') return !!mine && !mine.sharedOnly;
  if (place === 'own') return !!mine && !!mine.shared;
  const lib = s.libs[place];
  if (!lib) return false;
  return lib.books.some((b) => sameBook(b, book));
}

/** All, some or none, from whether each book is in. */
export function tickOf(ins: boolean[]): Tick {
  const n = ins.filter(Boolean).length;
  if (n === 0) return 'false';
  if (n === ins.length) return 'true';
  return 'mixed';
}

/** What the sheet needs the app to do, so the sums stay here. */
export interface Hands {
  records: () => BookRecord[];
  shared: () => Shared;
  /** Someone else's book into the reader's own, shared with their key or not. */
  keep: (entry: BookRecord, shared: boolean) => Promise<BookRecord>;
  setShared: (id: string, shared: boolean) => void;
  setSharedOnly: (id: string, sharedOnly: boolean) => void;
  remove: (id: string) => Promise<unknown>;
  /** One of the reader's own books into a library, as their share of it. */
  addOwn: (rec: BookRecord, token: string) => Promise<void>;
  /** Someone else's book into a library, pointing at their file. */
  addTheirs: (entry: BookRecord, token: string) => Promise<void>;
  /** A library's list fetched again, as the server has it now. */
  fresh: (token: string) => Promise<void>;
  /** Books out of a library, by their ids there. */
  takeOut: (token: string, ids: string[]) => Promise<unknown>;
}

/** Ticks a book into the reader's own books, or takes it out; while shared it stays in their shared library. */
async function intoPersonal(h: Hands, entry: BookRecord, on: boolean) {
  const mine = mineOf(h.records(), entry);
  if (on) {
    if (!mine) await h.keep(entry, false);
    else if (mine.sharedOnly) h.setSharedOnly(mine.id, false);
    return;
  }
  if (!mine) return;
  if (mine.shared) h.setSharedOnly(mine.id, true);
  else await h.remove(mine.id);
}

/** Ticks a book into the reader's own shared library, or out; out of both, it goes. */
async function intoOwn(h: Hands, entry: BookRecord, on: boolean) {
  const mine = mineOf(h.records(), entry);
  if (on) {
    if (mine) {
      h.setShared(mine.id, true);
      return;
    }
    const copy = await h.keep(entry, true);
    h.setSharedOnly(copy.id, true);
    return;
  }
  if (!mine) return;
  if (mine.sharedOnly) await h.remove(mine.id);
  else h.setShared(mine.id, false);
}

/** Ticks a book into a library by its token, or out of it. */
async function intoLibrary(h: Hands, entry: BookRecord, token: string, on: boolean) {
  if (on) {
    const mine = mineOf(h.records(), entry);
    if (mine) await h.addOwn(mine, token);
    else await h.addTheirs(entry, token);
    return;
  }
  const s = h.shared();
  const lib = s.libs[token];
  if (!lib) return;
  const ids = lib.books.filter((b) => sameBook(b, entry)).map((b) => b.id);
  if (ids.length === 0) return;
  let by = changeToken(s, token);
  if (!by) by = token;
  await h.takeOut(by, ids);
}

/** Puts each book in a library, or takes each out, skipping those already as asked. */
export async function placeBooks(h: Hands, entries: BookRecord[], place: Place, on: boolean) {
  // Taking out goes by the library as the server has it now, so a book that only just went in is found.
  const library = place !== 'personal' && place !== 'own';
  if (library && !on) await h.fresh(place);
  for (const entry of entries) {
    if (holds(h.shared(), h.records(), place, entry) === on) continue;
    if (place === 'personal') await intoPersonal(h, entry, on);
    else if (place === 'own') await intoOwn(h, entry, on);
    else await intoLibrary(h, entry, place, on);
  }
}

/** The line on Done: where the books went and where they came out of. */
export function doneLine(what: string, changes: Array<{ name: string; on: boolean }>): string | null {
  if (changes.length === 0) return null;
  const parts = changes.map((c) => {
    if (c.on) return `in ${c.name}`;
    return `out of ${c.name}`;
  });
  return `${what}: ${parts.join(', ')}`;
}
