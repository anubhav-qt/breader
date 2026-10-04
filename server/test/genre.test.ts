import { createHash } from 'node:crypto';
import { GENRES, genreIds, genreNames, joinGenres } from '@breader/shared';
import { describe, expect, it } from 'vitest';
import { book, browser, push, registered } from './helpers.ts';

type Reader = Awaited<ReturnType<typeof registered>>['b'];
const pulled = async (b: Reader, id: string) => (await b.get('/v1/sync/pull?since=0')).body.books.find((x: { id: string }) => x.id === id);

describe('genre', () => {
  it('keeps the genre a book was added with and the reader’s own apart', async () => {
    const { b } = await registered();
    const a = book({ genre: 'fantasy' });
    const res = await b.post('/v1/sync/push', push('c', { type: 'book.put', book: a }));
    expect(res.body.rejected).toEqual([]);
    expect(await pulled(b, a.id)).toMatchObject({ genre: 'fantasy', edit: { genre: null } });

    await b.post('/v1/sync/push', push('c', { type: 'edit.put', bookId: a.id, edit: { genre: 'horror' } }));
    expect(await pulled(b, a.id)).toMatchObject({ genre: 'fantasy', edit: { genre: 'horror' } });
    // Unset on purpose, then back to the one it came with.
    await b.post('/v1/sync/push', push('c', { type: 'edit.put', bookId: a.id, edit: { genre: '' } }));
    expect((await pulled(b, a.id)).edit.genre).toBe('');
    await b.post('/v1/sync/push', push('c', { type: 'edit.put', bookId: a.id, edit: { genre: null } }));
    expect((await pulled(b, a.id)).edit.genre).toBeNull();
  });

  it('keeps the genre when an app that doesn’t know genres puts the book again', async () => {
    const { b } = await registered();
    const a = book({ genre: 'history' });
    await b.post('/v1/sync/push', push('c', { type: 'book.put', book: a }));
    const { genre: _, ...older } = a;
    await b.post('/v1/sync/push', push('c', { type: 'book.put', book: { ...older, line: 'Further on.' } }));
    expect(await pulled(b, a.id)).toMatchObject({ genre: 'history', line: 'Further on.' });
  });

  it('turns away a genre that isn’t an id', async () => {
    const { b } = await registered();
    const res = await b.post('/v1/sync/push', push('c', { type: 'book.put', book: book({ genre: 'Science Fiction!' }) }));
    expect(res.status).toBe(400);
    for (const genre of ['fantasy,', ',fantasy', 'fantasy, romance', 'fantasy,,romance']) {
      const edit = await b.post('/v1/sync/push', push('c', { type: 'edit.put', bookId: 'x', edit: { genre } }));
      expect(edit.status, genre).toBe(400);
    }
  });

  it('keeps several genres, as the book came and as the reader has them', async () => {
    const { b } = await registered();
    const a = book({ genre: 'fantasy,lightnovel' });
    expect((await b.post('/v1/sync/push', push('c', { type: 'book.put', book: a }))).body.rejected).toEqual([]);
    await b.post('/v1/sync/push', push('c', { type: 'edit.put', bookId: a.id, edit: { genre: 'mystery,crime,thriller' } }));
    expect(await pulled(b, a.id)).toMatchObject({ genre: 'fantasy,lightnovel', edit: { genre: 'mystery,crime,thriller' } });
  });

  it('shows a shared book’s genre in its shared library, the sharer’s own first', async () => {
    const { b, key } = await registered();
    const body = Buffer.from(`genre ${Math.random()}`);
    const ask = await b.post('/v1/uploads', { sha256: createHash('sha256').update(body).digest('hex'), size: body.length, mime: 'application/epub+zip', kind: 'book' });
    await fetch(ask.body.upload.url, { method: 'PUT', headers: ask.body.upload.headers, body });
    await b.post(`/v1/uploads/${ask.body.fileId}/complete`);
    const a = book({ shared: true, fileId: ask.body.fileId, genre: 'mystery' });
    await b.post('/v1/sync/push', push('c', { type: 'book.put', book: a }));
    const token = (await browser().post('/v1/shared/open', { key })).body.token;
    const entry = async () => (await browser().post('/v1/shared/books', { token })).body.books.find((x: { id: string }) => x.id === a.id);
    expect(await entry()).toMatchObject({ genre: 'mystery' });
    await b.post('/v1/sync/push', push('c', { type: 'edit.put', bookId: a.id, edit: { genre: 'thriller' } }));
    expect(await entry()).toMatchObject({ genre: 'thriller' });
    await b.post('/v1/sync/push', push('c', { type: 'edit.put', bookId: a.id, edit: { genre: '' } }));
    expect((await entry()).genre).toBeNull();
  });

  it('reads a stored list: each known genre once, in the list’s order, old picks under their new names', () => {
    expect(GENRES).toHaveLength(20);
    expect(genreIds('romance,fantasy,romance')).toEqual(['fantasy', 'romance']);
    // "Philosophy & religion" and "Comics & manga" were picked from the first list; "Business & money" has no genre now.
    expect(genreIds('ideas,comics,business')).toEqual(['lightnovel', 'philosophy']);
    expect(genreIds('')).toEqual([]);
    expect(joinGenres(['crime', 'mystery', 'nonsense'])).toBe('mystery,crime');
    expect(genreNames('mystery,crime')).toBe('Mystery, Crime');
    expect(genreNames('travel')).toBeUndefined();
  });
});
