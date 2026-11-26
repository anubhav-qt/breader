import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Renaming a library of the reader's own, from Shared's list or from Public, names it in both: the
 * list's name and the feed's row. Someone else's is named only in the reader's own list.
 */

const posted: Array<{ path: string; body: unknown }> = [];
const written: Record<string, unknown> = {};

const FEED = [
  { token: 'ownlib.feed1', name: null, tag: 'ownlib', books: 1, manga: 0, saves: 0, updatedAt: 1, own: true },
  { token: 'clublib.feed2', name: 'Club', tag: 'clubli', books: 2, manga: 0, saves: 3, updatedAt: 1, own: false },
];

vi.mock('../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    get: async (path: string) => {
      if (path === '/v1/shared/feed') return { libraries: FEED };
      throw new Error(`unexpected get ${path}`);
    },
    post: async (path: string, body: { name?: string; token?: string; key?: string }) => {
      posted.push({ path, body });
      if (path === '/v1/shared/open' && body.key === 'BRDR-PERS-ONAL-LIBR-ARYO-FONE') return { token: 'perslib.key7', name: null, own: false };
      if (path === '/v1/shared/open') return { token: 'madelib.key9', name: null, own: false };
      if (path === '/v1/shared/copy') return { token: 'copylib.key3', name: null, of: 'otherlib' };
      if (path === '/v1/shared/create') return { token: 'clublib.key1', name: 'Club', key: 'BRDR-TEST' };
      if (path === '/v1/shared/name') return { name: body.name?.trim() || null };
      if (path === '/v1/shared/books') {
        const made = body.token === 'madelib.key9' || body.token === 'copylib.key3';
        return { books: [], name: null, public: true, access: 'key', mayPublish: body.token === 'madelib.key9', mayName: made };
      }
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

const row = (token: string) => shelf.sharedNow().feed.libraries.find((l) => l.token === token)!;

describe('renaming a library', () => {
  beforeEach(() => { posted.length = 0; });

  it('names the reader’s own in Shared’s list and on its row in the feed at once', async () => {
    await shelf.refreshFeed();
    await shelf.renameLibrary('own', '  My shelf  ');
    expect(shelf.libraryName(shelf.sharedNow(), 'own')).toBe('My shelf');
    expect(row('ownlib.feed1').name).toBe('My shelf');
    expect(written.libraryName).toBe('My shelf');
    expect(shelf.yoursAs(shelf.sharedNow(), row('ownlib.feed1'))).toBe('own');

    // Asked again before the new name has synced, the feed still says it.
    await shelf.refreshFeed();
    expect(row('ownlib.feed1').name).toBe('My shelf');
  });

  it('names one made only to share on the server, so the list and the feed say the same', async () => {
    await shelf.createLibrary('Club');
    await shelf.refreshFeed();
    const which = shelf.yoursAs(shelf.sharedNow(), row('clublib.feed2'));
    expect(which).toBe('clublib.key1');
    await shelf.renameLibrary(which!, 'Book club');
    expect(posted).toContainEqual({ path: '/v1/shared/name', body: { token: 'clublib.key1', name: 'Book club' } });
    expect(shelf.libraryName(shelf.sharedNow(), 'clublib.key1')).toBe('Book club');
    expect(row('clublib.feed2').name).toBe('Book club');
  });

  it('asks first whether one not opened yet is made only to share, then names it for everyone', async () => {
    await shelf.addLibrary('BRDR-AAAA-BBBB-CCCC-DDDD-EEEE');
    posted.length = 0;
    await shelf.renameLibrary('madelib.key9', 'Kept club');
    expect(posted).toContainEqual({ path: '/v1/shared/name', body: { token: 'madelib.key9', name: 'Kept club' } });
    expect(shelf.libraryName(shelf.sharedNow(), 'madelib.key9')).toBe('Kept club');
  });

  it('names a copy saved from the feed for everyone its key opens it to', async () => {
    await shelf.saveLibrary('otherlib.feed3');
    posted.length = 0;
    await shelf.renameLibrary('copylib.key3', 'Club picks');
    expect(posted).toContainEqual({ path: '/v1/shared/name', body: { token: 'copylib.key3', name: 'Club picks' } });
    expect(shelf.libraryName(shelf.sharedNow(), 'copylib.key3')).toBe('Club picks');
  });

  it('names someone else’s only in the reader’s own list', async () => {
    await shelf.addLibrary('BRDR-PERS-ONAL-LIBR-ARYO-FONE');
    posted.length = 0;
    await shelf.renameLibrary('perslib.key7', 'Their books');
    expect(posted.some((p) => p.path === '/v1/shared/name')).toBe(false);
    expect(shelf.libraryName(shelf.sharedNow(), 'perslib.key7')).toBe('Their books');
  });
});
