import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShelfBook } from '@breader/shared/protocol';

/*
 * Someone's shared books bring their covers as their cards come near the screen, however deep in
 * the library: a book's from its sharer, a series from a manga site's from there, as in Browse.
 */

const TOKEN = 'publib1234567890.feed1';
const SERIES = 'mangadex:0c2a4d7e-1f3b-4c5d-8e9f-a0b1c2d3e4f5';
const links: string[] = [];
const fromSite: string[] = [];
let books: ShelfBook[] = [];

const book = (n: number, over: Partial<ShelfBook> = {}): ShelfBook => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  title: `Book ${n}`,
  author: '',
  format: 'EPUB',
  words: 1,
  color: 'ink',
  addedAt: 1000 - n,
  line: '',
  fileId: null,
  coverId: `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  ...over,
});

vi.mock('../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    get: async () => ({ libraries: [] }),
    post: async (path: string, body: { fileId?: string }) => {
      if (path === '/v1/shared/books') return { books, name: null, public: true, access: 'public', mayPublish: false, mayName: false };
      if (path === '/v1/shared/link') {
        links.push(body.fileId!);
        return { url: `https://files.test/${body.fileId}` };
      }
      throw new Error(`unexpected post ${path}`);
    },
  },
}));
vi.mock('../lib/store', () => ({ store: { get: async () => undefined, set: async () => {} } }));
vi.mock('./sync', () => ({ signedIn: <T>(fn: () => Promise<T>) => fn() }));
vi.mock('../features/reader/settings', () => ({ readSetting: () => undefined, writeSetting: () => {} }));
vi.mock('../books/remote', async (actual) => ({
  ...(await actual<typeof import('../books/remote')>()),
  remoteCover: async (url: string) => {
    fromSite.push(url);
    return new Blob(['site']);
  },
}));

let shelf: typeof import('./shelf');
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeAll(async () => {
  vi.stubGlobal('fetch', async () => new Response(new Blob(['cover'])));
  URL.createObjectURL = (b: Blob) => `blob:${(b as Blob).size}`;
  shelf = await import('./shelf');
});

beforeEach(() => {
  links.length = 0;
  fromSite.length = 0;
});

describe('shared covers', () => {
  it('takes a series’ cover from its manga site, a book’s from its sharer, none while one waits', () => {
    expect(shelf.coverFrom(book(1, { format: 'CBZ', coverId: null, url: SERIES }))).toBe('site');
    expect(shelf.coverFrom(book(1))).toBe('sharer');
    expect(shelf.coverFrom(book(1, { coverOk: true }))).toBe('sharer');
    expect(shelf.coverFrom(book(1, { coverOk: false }))).toBeNull();
    expect(shelf.coverFrom(book(1, { format: 'CBZ', coverOk: false }))).toBe('sharer');
    expect(shelf.coverFrom(book(1, { coverId: null }))).toBeNull();
  });

  it('brings the cover of a book deep in a library, and a series’ from its site, once each', async () => {
    books = [...Array.from({ length: 40 }, (_, i) => book(i + 1)), book(41, { format: 'CBZ', coverId: null, url: SERIES })];
    await shelf.refreshLibrary(TOKEN, true);
    const deep = books[35];
    const series = books[40];
    shelf.wantShelfCover(deep.id);
    shelf.wantShelfCover(deep.id);
    shelf.wantShelfCover(series.id);
    for (let i = 0; i < 5; i++) await settle();
    expect(links).toEqual([deep.coverId]);
    expect(fromSite).toEqual([SERIES]);
    expect(shelf.sharedNow().covers[deep.id]).toMatch(/^blob:/);
    expect(shelf.sharedNow().covers[series.id]).toMatch(/^blob:/);
  });

  it('asks for none until a card wants it', async () => {
    books = [book(50), book(51)];
    await shelf.refreshLibrary(TOKEN, true);
    await settle();
    expect(links).toEqual([]);
  });

  it('brings a seen book’s cover once the model says yes to it, without its card asking again', async () => {
    const waits = book(60, { coverOk: false });
    books = [waits];
    await shelf.refreshLibrary(TOKEN, true);
    shelf.wantShelfCover(waits.id);
    await settle();
    expect(links).toEqual([]);
    books = [{ ...waits, coverOk: true }];
    await shelf.refreshLibrary(TOKEN, true);
    for (let i = 0; i < 5; i++) await settle();
    expect(links).toEqual([waits.coverId]);
  });

  it('fetches a few at a time, the rest in turn', async () => {
    books = Array.from({ length: 10 }, (_, i) => book(100 + i));
    await shelf.refreshLibrary(TOKEN, true);
    let open = 0;
    let most = 0;
    vi.stubGlobal('fetch', async () => {
      open++;
      most = Math.max(most, open);
      await settle();
      open--;
      return new Response(new Blob(['cover']));
    });
    for (const b of books) shelf.wantShelfCover(b.id);
    for (let i = 0; i < 40; i++) await settle();
    expect(links).toHaveLength(10);
    expect(most).toBe(4);
  });
});
