import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { book, browser, push, registered } from './helpers.ts';

type Reader = Awaited<ReturnType<typeof registered>>['b'];
const pulled = async (b: Reader, id: string) => (await b.get('/v1/sync/pull?since=0')).body.books.find((x: { id: string }) => x.id === id);

describe('series', () => {
  it('keeps the file’s series and the reader’s own apart', async () => {
    const { b } = await registered();
    const a = book({ series: 'The Land of Oz', seriesIndex: 2 });
    const res = await b.post('/v1/sync/push', push('c', { type: 'book.put', book: a }));
    expect(res.body.rejected).toEqual([]);
    expect(await pulled(b, a.id)).toMatchObject({ series: 'The Land of Oz', seriesIndex: 2, edit: { series: null, seriesIndex: null } });

    await b.post('/v1/sync/push', push('c', { type: 'edit.put', bookId: a.id, edit: { series: ' Oz ', seriesIndex: 1.5 } }));
    expect(await pulled(b, a.id)).toMatchObject({ series: 'The Land of Oz', edit: { series: 'Oz', seriesIndex: 1.5 } });
    // Taken out of any series, then back to what the file says.
    await b.post('/v1/sync/push', push('c', { type: 'edit.put', bookId: a.id, edit: { series: '' } }));
    expect((await pulled(b, a.id)).edit.series).toBe('');
    await b.post('/v1/sync/push', push('c', { type: 'edit.put', bookId: a.id, edit: { series: null, seriesIndex: null } }));
    expect((await pulled(b, a.id)).edit).toMatchObject({ series: null, seriesIndex: null });
  });

  it('shows a shared book’s series in its shared library, the sharer’s own first', async () => {
    const { b, key } = await registered();
    const body = Buffer.from(`series ${Math.random()}`);
    const ask = await b.post('/v1/uploads', { sha256: createHash('sha256').update(body).digest('hex'), size: body.length, mime: 'application/epub+zip', kind: 'book' });
    await fetch(ask.body.upload.url, { method: 'PUT', headers: ask.body.upload.headers, body });
    await b.post(`/v1/uploads/${ask.body.fileId}/complete`);
    const a = book({ shared: true, fileId: ask.body.fileId, series: 'Sherlock Holmes', seriesIndex: 3 });
    await b.post('/v1/sync/push', push('c', { type: 'book.put', book: a }));
    const token = (await browser().post('/v1/shared/open', { key })).body.token;
    const entry = async () => (await browser().post('/v1/shared/books', { token })).body.books.find((x: { id: string }) => x.id === a.id);
    expect(await entry()).toMatchObject({ series: 'Sherlock Holmes', seriesIndex: 3 });
    await b.post('/v1/sync/push', push('c', { type: 'edit.put', bookId: a.id, edit: { seriesIndex: 4 } }));
    expect(await entry()).toMatchObject({ series: 'Sherlock Holmes', seriesIndex: 4 });
    await b.post('/v1/sync/push', push('c', { type: 'edit.put', bookId: a.id, edit: { series: '' } }));
    expect((await entry()).series).toBeNull();
  });
});
