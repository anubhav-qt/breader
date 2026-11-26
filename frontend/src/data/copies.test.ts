import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Saving a public library makes a copy of the reader's own, which may ask to change its original;
 * the original's owner answers asks from Shared's list.
 */

const posted: Array<{ path: string; body: unknown }> = [];
const written: Record<string, unknown> = {};
let copies = 0;
/** The original's owner took back the reader's grant. */
let takenBack = false;

const FEED = [{ token: 'origlib.feed1', name: null, tag: 'origli', books: 1, manga: 0, saves: 0, updatedAt: 1, own: false }];
const BOOK = { id: 'b1', title: 'One', author: 'A', format: 'EPUB', words: 1, color: '#000', addedAt: 1, line: '', fileId: 'f1', coverId: null };

const { ApiError } = vi.hoisted(() => ({
  ApiError: class ApiError extends Error {
    readonly code: string;
    constructor(_status: number, code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

vi.mock('../lib/api', () => ({
  ApiError,
  api: {
    get: async (path: string) => {
      if (path === '/v1/shared/feed') return { libraries: FEED };
      throw new Error(`unexpected get ${path}`);
    },
    post: async (path: string, body: { token?: string; ids?: string[]; id?: string; give?: boolean }) => {
      posted.push({ path, body });
      if (takenBack && body.token === 'origlib.grant1') throw new ApiError(404, 'shared_closed', 'Closed.');
      if (body.token === 'gonelib.feed2') throw new ApiError(404, 'shared_closed', 'Closed.');
      if (path === '/v1/shared/copy') {
        copies++;
        await new Promise((go) => setTimeout(go, 5));
        return { token: 'copylib.key1', name: null, of: 'origlib' };
      }
      if (path === '/v1/shared/books' && body.token === 'copylib.key1') {
        const copy = takenBack ? { of: 'origlib', asked: 'taken', grant: null, live: true } : { of: 'origlib', asked: 'given', grant: 'origlib.grant1', live: true };
        return { books: [BOOK], name: null, public: false, access: 'key', mayPublish: false, mayName: true, copy };
      }
      if (path === '/v1/shared/books') return { books: [BOOK], name: null, public: true, access: 'public', mayPublish: false, mayName: false };
      if (path === '/v1/shared/remove') return { removed: body.ids!.length };
      if (path === '/v1/shared/ask') return { asked: 'asked' };
      if (path === '/v1/shared/asks') return { asks: [{ id: 'a1', tag: 'copyli', note: 'hi', askedAt: 1, state: 'asked' }] };
      if (path === '/v1/shared/answer') return { state: body.give ? 'given' : 'refused' };
      throw new Error(`unexpected post ${path}`);
    },
  },
}));
vi.mock('../lib/store', () => ({ store: { get: async () => undefined, set: async () => {} } }));
// The session is there: requests run as they are.
vi.mock('./sync', () => ({ signedIn: <T>(fn: () => Promise<T>) => fn() }));
vi.mock('../features/reader/settings', () => ({
  readSetting: (name: string) => written[name],
  writeSetting: (name: string, value: unknown) => { written[name] = value; },
}));

const shelf = await import('./shelf');

describe('a public library saved as a copy', () => {
  beforeEach(() => { posted.length = 0; });

  it('is saved once however fast it’s asked, under its feed name, and counts as saved by its feed token', async () => {
    await shelf.refreshFeed();
    const [a, b] = await Promise.all([shelf.saveLibrary('origlib.feed1', 'origli’s shared library'), shelf.saveLibrary('origlib.feed1')]);
    expect(copies).toBe(1);
    expect(a).toBe('origli’s shared library');
    expect(b).toBe(a);
    expect(written.sharedLibraries).toEqual([expect.objectContaining({ token: 'copylib.key1', of: 'origlib', name: 'origli’s shared library' })]);
    expect(shelf.isSaved(shelf.sharedNow(), 'origlib.feed1')).toBe(true);
    // Saved already: no second copy.
    await shelf.saveLibrary('origlib.feed1');
    expect(copies).toBe(1);
  });

  it('changes the original only by the token its owner’s yes gave, named as the original', async () => {
    await shelf.refreshLibrary('copylib.key1', true);
    await shelf.refreshLibrary('origlib.feed1', true);
    const s = shelf.sharedNow();
    expect(shelf.changeToken(s, 'copylib.key1')).toBe('copylib.key1');
    expect(shelf.changeToken(s, 'origlib.feed1')).toBe('origlib.grant1');
    expect(shelf.changeToken(s, 'elselib.feed9')).toBeNull();
    expect(shelf.libraryName(s, 'origlib.grant1')).toBe('origli’s shared library (original)');
    expect(shelf.libraryName(s, 'origlib.feed1')).toBe('origli’s shared library');
  });

  it('takes books out at once, and sends the ask’s note only when there is one', async () => {
    expect(await shelf.removeFromLibrary('copylib.key1', ['b1'])).toBe(1);
    expect(posted).toContainEqual({ path: '/v1/shared/remove', body: { token: 'copylib.key1', ids: ['b1'] } });
    await shelf.askToChange('copylib.key1', '   ');
    await shelf.askToChange('copylib.key1', '  please  ');
    const asks = posted.filter((p) => p.path === '/v1/shared/ask').map((p) => p.body);
    expect(asks).toEqual([{ token: 'copylib.key1' }, { token: 'copylib.key1', note: 'please' }]);
  });

  it('shows the owner asks and keeps a yes until it’s taken back', async () => {
    await shelf.loadAsks('own');
    expect(posted).toContainEqual({ path: '/v1/shared/asks', body: {} });
    expect(shelf.sharedNow().asks.own).toHaveLength(1);
    expect(await shelf.answerAsk('own', 'a1', true)).toBe('given');
    expect(shelf.sharedNow().asks.own).toEqual([expect.objectContaining({ id: 'a1', state: 'given' })]);
    expect(await shelf.answerAsk('own', 'a1', false)).toBe('refused');
    expect(shelf.sharedNow().asks.own).toEqual([]);
  });

  it('stops offering the original once a change by its grant is refused as taken back', async () => {
    takenBack = true;
    await expect(shelf.removeFromLibrary('origlib.grant1', ['b1'])).rejects.toThrow('Closed.');
    await vi.waitFor(() => expect(shelf.changeToken(shelf.sharedNow(), 'origlib.feed1')).toBeNull());
    expect(shelf.sharedNow().libs['origlib.grant1'].state).toBe('closed');
  });

  it('offers no change to a library first seen closed', async () => {
    await shelf.refreshLibrary('gonelib.feed2', true);
    const s = shelf.sharedNow();
    expect(s.libs['gonelib.feed2']).toMatchObject({ state: 'closed', access: 'public' });
    expect(shelf.changeToken(s, 'gonelib.feed2')).toBeNull();
  });
});
