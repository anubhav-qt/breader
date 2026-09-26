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

    expect((await b.get('/v1/sync/pull?since=1')).body).toEqual({ rev: 1, books: [], reads: [], settings: null, timeline: expect.any(String) });
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

  it('merges card edits field by field', async () => {
    const { b } = await registered();
    const a = book();
    await b.post('/v1/sync/push', push('laptop', { type: 'book.put', book: a }));
    await b.post('/v1/sync/push', push('laptop', { type: 'edit.put', bookId: a.id, edit: { title: 'Renamed' } }));
    await b.post('/v1/sync/push', push('phone', { type: 'edit.put', bookId: a.id, edit: { color: 'teal' } }));
    expect((await b.get('/v1/sync/pull?since=0')).body.books[0].edit).toEqual({ title: 'Renamed', color: 'teal', favorite: false });
    await b.post('/v1/sync/push', push('phone', { type: 'edit.put', bookId: a.id, edit: { title: null } }));
    expect((await b.get('/v1/sync/pull?since=0')).body.books[0].edit.title).toBeNull();
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
