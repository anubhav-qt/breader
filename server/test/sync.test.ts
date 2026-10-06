import { describe, expect, it } from 'vitest';
import { book, push, registered } from './helpers.ts';

describe('sync', () => {
  it('applies a batch under one new rev and pulls it back', async () => {
    const { b } = await registered();
    const a = book({ title: 'Emma' });
    const r = await b.post(
      '/v1/sync/push',
      push(
        'client-one',
        { type: 'book.put', book: a },
        { type: 'read.put', bookId: a.id, read: { pos: { section: 3, block: 12, offset: 40 }, progress: 0.31, line: 'A line.', lastOpened: Date.now() - 1000 } },
        { type: 'edit.put', bookId: a.id, edit: { title: 'Emma (annotated)', favorite: true } },
        { type: 'settings.put', prefs: { theme: 'night', style: 'book' } },
      ),
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ rev: 1, rejected: [] });

    const p = await b.get('/v1/sync/pull?since=0');
    expect(p.body.rev).toBe(1);
    expect(p.body.books).toHaveLength(1);
    expect(p.body.books[0]).toMatchObject({ id: a.id, title: 'Emma', edit: { title: 'Emma (annotated)', color: null, favorite: true }, removedAt: null });
    expect(p.body.reads[0]).toMatchObject({ bookId: a.id, read: { pos: { section: 3, block: 12, offset: 40 }, progress: 0.31 } });
    expect(p.body.settings).toEqual({ theme: 'night', style: 'book' });

    expect((await b.get('/v1/sync/pull?since=1')).body).toEqual({ rev: 1, books: [], reads: [], settings: null, timeline: expect.any(String), lapsed: [] });
  });

  it('ignores a retried push', async () => {
    const { b } = await registered();
    const body = push('client-retry', { type: 'book.put', book: book() });
    const first = await b.post('/v1/sync/push', body);
    const again = await b.post('/v1/sync/push', body);
    expect(again.body).toEqual({ rev: first.body.rev, lastMutationId: first.body.lastMutationId, rejected: [], timeline: first.body.timeline });
    expect((await b.get('/v1/me')).body.library.rev).toBe(1);
  });

  it('keeps the most recent reading session, capped at the server’s clock', async () => {
    const { b } = await registered();
    const a = book();
    const read = (progress: number, lastOpened: number) => ({ type: 'read.put', bookId: a.id, read: { progress, line: '', lastOpened } });
    await b.post('/v1/sync/push', push('c1', { type: 'book.put', book: a }, read(0.5, Date.now() - 1000)));
    await b.post('/v1/sync/push', push('c2', read(0.2, Date.now() - 60_000))); // an older session arrives late
    expect((await b.get('/v1/sync/pull?since=0')).body.reads[0].read.progress).toBe(0.5);

    await b.post('/v1/sync/push', push('c2', read(0.9, Date.now() + 86_400_000))); // a clock a day fast
    const after = (await b.get('/v1/sync/pull?since=0')).body.reads[0].read;
    expect(after.progress).toBe(0.9);
    expect(after.lastOpened).toBeLessThanOrEqual(Date.now());
    // …so it can't block honest sessions from a correct clock for the next day.
    await b.post('/v1/sync/push', push('c1', read(0.95, Date.now() + 5)));
    expect((await b.get('/v1/sync/pull?since=0')).body.reads[0].read.progress).toBe(0.95);
  });

  it('only moves the read mark forward, or on to a new reading', async () => {
    const { b } = await registered();
    const a = book();
    const mark = (progress: number, n?: number) => ({ pos: { section: Math.floor(progress * 10), block: 0, offset: 0 }, progress, line: `At ${progress}`, ...(n ? { n } : {}) });
    const read = (id: string, progress: number, m: ReturnType<typeof mark>, lastOpened = Date.now()) =>
      push(id, { type: 'read.put', bookId: a.id, read: { progress, line: '', lastOpened, mark: m } });
    const pulled = async () => (await b.get('/v1/sync/pull?since=0')).body.reads[0].read;

    await b.post('/v1/sync/push', push('m0', { type: 'book.put', book: a }));
    await b.post('/v1/sync/push', read('m1', 0.3, mark(0.3)));
    // A jump ahead to look: the place moves, the mark stays.
    await b.post('/v1/sync/push', read('m2', 0.9, mark(0.3)));
    expect(await pulled()).toMatchObject({ progress: 0.9, mark: mark(0.3) });
    // Another device, newer, whose mark is behind: its place wins, the mark doesn't go back.
    await b.post('/v1/sync/push', read('m3', 0.2, mark(0.2), Date.now() + 1));
    expect(await pulled()).toMatchObject({ progress: 0.2, mark: mark(0.3) });
    // An older session further in still carries the mark on.
    await b.post('/v1/sync/push', read('m4', 0.4, mark(0.4), Date.now() - 60_000));
    expect(await pulled()).toMatchObject({ progress: 0.2, mark: mark(0.4) });
    // Read again from the start: the new reading wins though it's not as far in.
    await b.post('/v1/sync/push', read('m5', 0.05, mark(0.05, 1), Date.now() + 2));
    expect((await pulled()).mark).toEqual(mark(0.05, 1));
  });

  it('merges card edits field by field', async () => {
    const { b } = await registered();
    const a = book();
    await b.post('/v1/sync/push', push('laptop', { type: 'book.put', book: a }));
    await b.post('/v1/sync/push', push('laptop', { type: 'edit.put', bookId: a.id, edit: { title: 'Renamed' } }));
    await b.post('/v1/sync/push', push('phone', { type: 'edit.put', bookId: a.id, edit: { color: 'teal' } }));
    expect((await b.get('/v1/sync/pull?since=0')).body.books[0].edit).toEqual({ title: 'Renamed', color: 'teal', favorite: false, series: null, seriesIndex: null, genre: null, ai: false });
    await b.post('/v1/sync/push', push('phone', { type: 'edit.put', bookId: a.id, edit: { title: null } }));
    expect((await b.get('/v1/sync/pull?since=0')).body.books[0].edit.title).toBeNull();
    // The AI switch rides with the edits, and another device's rename leaves it alone.
    await b.post('/v1/sync/push', push('laptop', { type: 'edit.put', bookId: a.id, edit: { ai: true } }));
    await b.post('/v1/sync/push', push('phone', { type: 'edit.put', bookId: a.id, edit: { title: 'Again' } }));
    expect((await b.get('/v1/sync/pull?since=0')).body.books[0].edit).toMatchObject({ title: 'Again', ai: true });
  });

  it('removes with a tombstone, so Undo works across browsers', async () => {
    const { b } = await registered();
    const a = book();
    await b.post('/v1/sync/push', push('c', { type: 'book.put', book: a }));
    const removed = await b.post('/v1/sync/push', push('c', { type: 'book.remove', bookId: a.id }));
    const p = await b.get(`/v1/sync/pull?since=${removed.body.rev - 1}`);
    expect(p.body.books[0].removedAt).toBeGreaterThan(0);
    await b.post('/v1/sync/push', push('c', { type: 'book.restore', bookId: a.id }));
    expect((await b.get('/v1/sync/pull?since=0')).body.books[0].removedAt).toBeNull();
  });

  it('rejects a bad change without losing the rest of the batch', async () => {
    const { b } = await registered();
    const a = book();
    const r = await b.post(
      '/v1/sync/push',
      push('c', { type: 'edit.put', bookId: 'nope', edit: { favorite: true } }, { type: 'book.put', book: a }, { type: 'book.files', bookId: a.id, fileId: 'not-a-file' }),
    );
    expect(r.body.rejected.map((x: { code: string }) => x.code)).toEqual(['not_found', 'file_missing']);
    expect((await b.get('/v1/sync/pull?since=0')).body.books.map((x: { id: string }) => x.id)).toEqual([a.id]);
  });

  it('syncs bundled samples by url, and refuses urls on uploaded books', async () => {
    const { b } = await registered();
    const r = await b.post(
      '/v1/sync/push',
      push('c', { type: 'book.put', book: book({ id: 'alice', source: 'sample', url: '/samples/alice.epub' }) }, { type: 'book.put', book: book({ url: '/samples/x.txt' }) }),
    );
    expect(r.body.rejected).toHaveLength(1);
    expect(r.body.rejected[0].code).toBe('bad_book');
  });

  it('syncs remote books by their series, without a file', async () => {
    const { b } = await registered();
    const series = 'mangadex:a1c7c817-4e59-43b7-9365-09675a149a6f';
    const r = await b.post(
      '/v1/sync/push',
      push(
        'c',
        { type: 'book.put', book: book({ id: 'md-frieren', format: 'CBZ', source: 'remote', url: series }) },
        { type: 'book.put', book: book({ id: 'md-pt', format: 'CBZ', source: 'remote', url: `${series}:pt-br` }) },
        { type: 'book.put', book: book({ source: 'remote' }) },
        { type: 'book.put', book: book({ source: 'remote', url: '/samples/alice.epub' }) },
        { type: 'book.put', book: book({ url: series }) },
        { type: 'book.put', book: book({ source: 'remote', url: series, fileId: 'f1' }) },
      ),
    );
    expect(r.body.rejected.map((x: { code: string }) => x.code)).toEqual(['bad_book', 'bad_book', 'bad_book', 'bad_book']);
    const books = (await b.get('/v1/sync/pull?since=0')).body.books;
    expect(books.map((x: { id: string; source: string; url: string }) => [x.id, x.source, x.url]).sort()).toEqual([
      ['md-frieren', 'remote', series],
      ['md-pt', 'remote', `${series}:pt-br`],
    ]);
    // Anything else after the colon isn't a language.
    const odd = await b.post('/v1/sync/push', push('c2', { type: 'book.put', book: book({ source: 'remote', url: `${series}:../x` }) }));
    expect(odd.status).toBe(400);
  });

  it('syncs a series on the reader’s own Suwayomi server by its number there', async () => {
    const { b } = await registered();
    const r = await b.post(
      '/v1/sync/push',
      push('c', { type: 'book.put', book: book({ id: 'sw-42', format: 'CBZ', source: 'remote', url: 'suwayomi:42' }) }, { type: 'book.put', book: book({ url: 'suwayomi:42' }) }),
    );
    expect(r.body.rejected.map((x: { code: string }) => x.code)).toEqual(['bad_book']);
    expect((await b.get('/v1/sync/pull?since=0')).body.books.map((x: { url: string }) => x.url)).toEqual(['suwayomi:42']);
    for (const url of ['suwayomi:0', 'suwayomi:abc', 'suwayomi:12345678901', 'suwayomi:']) {
      expect((await b.post('/v1/sync/push', push('c3', { type: 'book.put', book: book({ source: 'remote', url }) }))).status, url).toBe(400);
    }
  });

  it('keeps libraries apart, even for the same sample ids', async () => {
    const one = await registered();
    const two = await registered();
    await one.b.post('/v1/sync/push', push('c', { type: 'book.put', book: book({ id: 'alice', source: 'sample', url: '/samples/alice.epub', title: 'Mine' }) }));
    await two.b.post('/v1/sync/push', push('c', { type: 'book.put', book: book({ id: 'alice', source: 'sample', url: '/samples/alice.epub', title: 'Theirs' }) }));
    expect((await one.b.get('/v1/sync/pull?since=0')).body.books.map((x: { title: string }) => x.title)).toEqual(['Mine']);
    expect((await two.b.get('/v1/sync/pull?since=0')).body.books.map((x: { title: string }) => x.title)).toEqual(['Theirs']);
  });

  it('validates the push body', async () => {
    const { b } = await registered();
    const r = await b.post('/v1/sync/push', { clientId: 'c-valid', mutations: [{ id: 1, type: 'book.put', book: { id: 'x' } }] });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('bad_request');
  });

  it('serialises concurrent pushes so revs never repeat', async () => {
    const { b } = await registered();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => b.post('/v1/sync/push', push(`para-${i}`, { type: 'book.put', book: book() }))));
    expect(results.map((r) => r.body.rev).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect((await b.get('/v1/sync/pull?since=0')).body.books).toHaveLength(8);
  });
});
