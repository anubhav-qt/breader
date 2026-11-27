import { describe, expect, it, vi } from 'vitest';
import type { BookRecord } from '../../books/types';
import type { Shared, SharedLibrary } from '../../data/shelf';
import type { ShelfBook } from '@breader/shared/protocol';
import { doneLine, holds, placeBooks, targetsOf, tickOf, type Hands } from './places';

// Only the sums are tested: shelf.ts's server, storage and settings stay out of it.
vi.mock('../../lib/api', () => ({ api: {}, ApiError: class ApiError extends Error {} }));
vi.mock('../../lib/store', () => ({ store: { get: async () => undefined, set: async () => {} } }));
vi.mock('../../data/sync', () => ({ signedIn: <T>(fn: () => Promise<T>) => fn() }));
vi.mock('../reader/settings', () => ({ readSetting: () => undefined, writeSetting: () => {} }));

/* Add to's sums: which libraries it lists, which it ticks, and what a tick does. */

const rec = (id: string, more: Partial<BookRecord> = {}): BookRecord => ({
  id,
  title: id,
  author: 'A',
  format: 'EPUB',
  source: 'file',
  shared: false,
  addedAt: 1,
  words: 1,
  color: 'teal',
  hasCover: false,
  progress: 0,
  line: '',
  lastOpened: 1,
  ...more,
});

const shelfBook = (id: string, more: Partial<ShelfBook> = {}): ShelfBook => ({
  id,
  title: id,
  author: 'A',
  format: 'EPUB',
  words: 1,
  color: 'teal',
  addedAt: 1,
  line: '',
  fileId: `f-${id}`,
  coverId: null,
  ...more,
} as ShelfBook);

const lib = (books: ShelfBook[], more: Partial<SharedLibrary> = {}): SharedLibrary => ({
  books,
  name: null,
  state: 'ready',
  public: false,
  access: 'key',
  mayPublish: true,
  mayName: true,
  ...more,
});

const shared = (more: Partial<Shared> = {}): Shared => ({
  saved: [],
  libs: {},
  covers: {},
  showing: 'own',
  byDefault: 'own',
  ownName: null,
  feed: { libraries: [], state: 'ready' },
  ownPublic: false,
  asks: {},
  ...more,
});

describe('targetsOf', () => {
  it('lists the reader’s own books only for someone else’s book', () => {
    const s = shared();
    expect(targetsOf(s, false, 'Personal').map((t) => t.place)).toEqual(['own']);
    expect(targetsOf(s, true, 'Personal').map((t) => t.place)).toEqual(['personal', 'own']);
  });

  it('gives a public library the globe', () => {
    const s = shared({ ownPublic: true, saved: [{ token: 'club.k', name: 'Club', at: 1 }], libs: { 'club.k': lib([], { public: true }) } });
    expect(targetsOf(s, false, 'Personal').map((t) => t.icon)).toEqual(['globe', 'globe']);
  });

  it('leaves out a closed library and one that only reads', () => {
    const s = shared({
      saved: [{ token: 'gone.k', at: 1, n: 1 }, { token: 'read.k', at: 2, n: 2 }, { token: 'club.k', at: 3, name: 'Club' }],
      libs: { 'gone.k': lib([], { state: 'closed' }), 'read.k': lib([], { access: 'public' }), 'club.k': lib([]) },
    });
    expect(targetsOf(s, false, 'Personal').map((t) => t.place)).toEqual(['own', 'club.k']);
  });

  it('lists the original of a copy right after it, by its own name', () => {
    const s = shared({
      saved: [{ token: 'copy.k', at: 1, name: 'Rain' }],
      libs: {
        'copy.k': lib([], { copy: { of: 'orig', asked: 'given', grant: 'orig.g', live: true } }),
        'orig.g': lib([], { name: 'Rainy days', public: true, access: 'grant' }),
      },
    });
    const list = targetsOf(s, false, 'Personal');
    expect(list.map((t) => t.name)).toEqual(['Shared', 'Rain', 'Rainy days']);
    expect(list[2]).toMatchObject({ place: 'orig.g', icon: 'globe' });
  });
});

describe('holds', () => {
  const s = shared({ libs: { 'club.k': lib([shelfBook('c1', { origin: 'b1' })]) } });

  it('finds a book in a library by the first book it’s a copy of', () => {
    expect(holds(s, [], 'club.k', rec('b1'))).toBe(true);
    expect(holds(s, [], 'club.k', rec('b2'))).toBe(false);
  });

  it('finds the same series from a catalogue by where it’s read', () => {
    const t = shared({ libs: { 'club.k': lib([shelfBook('c9', { url: 'sw:mf:abc' })]) } });
    expect(holds(t, [], 'club.k', rec('m1', { source: 'remote', url: 'sw:mf:abc' }))).toBe(true);
  });

  it('reads the reader’s own books and their shared library from their copy', () => {
    const records = [rec('copy', { origin: 'theirs', shared: true, sharedOnly: true })];
    const entry = rec('theirs', { source: 'shelf' });
    expect(holds(s, records, 'personal', entry)).toBe(false);
    expect(holds(s, records, 'own', entry)).toBe(true);
  });

  it('says no for a library not loaded yet', () => {
    expect(holds(s, [], 'other.k', rec('b1'))).toBe(false);
  });
});

describe('tickOf', () => {
  it('ticks all, none or some', () => {
    expect(tickOf([true, true])).toBe('true');
    expect(tickOf([false, false])).toBe('false');
    expect(tickOf([true, false])).toBe('mixed');
  });
});

/** Hands that only write down what they're asked, over a list of the reader's books. */
function fakeHands(records: BookRecord[], s: Shared, onFresh?: (token: string) => void) {
  const did: string[] = [];
  const hands: Hands = {
    records: () => records,
    shared: () => s,
    keep: async (entry, isShared) => {
      did.push(`keep ${entry.id} ${isShared}`);
      const copy = rec(`copy-${entry.id}`, { origin: entry.id, shared: isShared });
      records.push(copy);
      return copy;
    },
    setShared: (id, on) => { did.push(`shared ${id} ${on}`); },
    setSharedOnly: (id, on) => { did.push(`sharedOnly ${id} ${on}`); },
    remove: async (id) => { did.push(`remove ${id}`); },
    addOwn: async (r, token) => { did.push(`addOwn ${r.id} ${token}`); },
    addTheirs: async (e, token) => { did.push(`addTheirs ${e.id} ${token}`); },
    fresh: async (token) => {
      did.push(`fresh ${token}`);
      onFresh?.(token);
    },
    takeOut: async (token, ids) => { did.push(`takeOut ${token} ${ids.join(',')}`); },
  };
  return { hands, did };
}

describe('placeBooks', () => {
  it('puts the reader’s own book in a library, skipping one there already', async () => {
    const s = shared({ libs: { 'club.k': lib([shelfBook('c1', { origin: 'b1' })]) } });
    const records = [rec('b1'), rec('b2')];
    const { hands, did } = fakeHands(records, s);
    await placeBooks(hands, records, 'club.k', true);
    expect(did).toEqual(['addOwn b2 club.k']);
  });

  it('puts someone else’s book in a library as theirs, or as the reader’s copy once they have one', async () => {
    const s = shared({ libs: { 'club.k': lib([]) } });
    const records = [rec('copy', { origin: 'kept' })];
    const { hands, did } = fakeHands(records, s);
    await placeBooks(hands, [rec('new', { source: 'shelf' }), rec('kept', { source: 'shelf' })], 'club.k', true);
    expect(did).toEqual(['addTheirs new club.k', 'addOwn copy club.k']);
  });

  it('takes a book out of an original by the grant on the reader’s copy', async () => {
    const s = shared({
      saved: [{ token: 'copy.k', at: 1 }],
      libs: {
        'copy.k': lib([], { copy: { of: 'orig', asked: 'given', grant: 'orig.g', live: true } }),
        'orig.feed': lib([shelfBook('c1', { origin: 'b1' }), shelfBook('c2')], { access: 'public' }),
      },
    });
    const { hands, did } = fakeHands([], s);
    await placeBooks(hands, [rec('b1')], 'orig.feed', false);
    expect(did).toEqual(['fresh orig.feed', 'takeOut orig.g c1']);
  });

  it('finds a book that only just went in before taking it out', async () => {
    // The list here is from before the add reached the server.
    const s = shared({ libs: { 'club.k': lib([]) } });
    const records = [rec('b1')];
    const { hands, did } = fakeHands(records, s, (token) => {
      s.libs[token] = lib([shelfBook('c1', { origin: 'b1' })]);
    });
    await placeBooks(hands, records, 'club.k', false);
    expect(did).toEqual(['fresh club.k', 'takeOut club.k c1']);
  });

  it('keeps someone else’s book in the reader’s own books, unshared, and takes it out again', async () => {
    const records: BookRecord[] = [];
    const { hands, did } = fakeHands(records, shared());
    const entry = rec('theirs', { source: 'shelf' });
    await placeBooks(hands, [entry], 'personal', true);
    await placeBooks(hands, [entry], 'personal', false);
    expect(did).toEqual(['keep theirs false', 'remove copy-theirs']);
  });

  it('out of the reader’s own books, a shared copy stays in their shared library', async () => {
    const records = [rec('copy', { origin: 'theirs', shared: true })];
    const { hands, did } = fakeHands(records, shared());
    await placeBooks(hands, [rec('theirs', { source: 'shelf' })], 'personal', false);
    expect(did).toEqual(['sharedOnly copy true']);
  });

  it('shares someone else’s book in the reader’s own library only, and out of both it goes', async () => {
    const records: BookRecord[] = [];
    const { hands, did } = fakeHands(records, shared());
    const entry = rec('theirs', { source: 'shelf' });
    await placeBooks(hands, [entry], 'own', true);
    expect(did).toEqual(['keep theirs true', 'sharedOnly copy-theirs true']);
    records[0].sharedOnly = true;
    await placeBooks(hands, [entry], 'own', false);
    expect(did[did.length - 1]).toBe('remove copy-theirs');
  });

  it('shares or stops sharing the reader’s own book', async () => {
    const records = [rec('b1'), rec('b2', { shared: true })];
    const { hands, did } = fakeHands(records, shared());
    await placeBooks(hands, records, 'own', true);
    expect(did).toEqual(['shared b1 true']);
    records[0].shared = true;
    await placeBooks(hands, records, 'own', false);
    expect(did.slice(1)).toEqual(['shared b1 false', 'shared b2 false']);
  });
});

describe('doneLine', () => {
  it('says nothing when nothing changed', () => {
    expect(doneLine('“Dune”', [])).toBeNull();
  });

  it('names where the books went and came out of', () => {
    expect(doneLine('3 books', [{ name: 'Club', on: true }, { name: 'Shared', on: false }])).toBe('3 books: in Club, out of Shared');
  });
});
