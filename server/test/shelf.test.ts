import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { book, browser, push, registered } from './helpers.ts';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
type Reader = Awaited<ReturnType<typeof registered>>['b'];

async function upload(b: Reader, body: Buffer): Promise<string> {
  const ask = await b.post('/v1/uploads', { sha256: sha(body), size: body.length, mime: 'application/epub+zip', kind: 'book' });
  if (ask.body.status === 'upload') {
    await fetch(ask.body.upload.url, { method: 'PUT', headers: ask.body.upload.headers, body });
    await b.post(`/v1/uploads/${ask.body.fileId}/complete`);
  }
  return ask.body.fileId;
}

/** A library that has put one book on the Shared Library, and kept one to itself. */
async function sharer() {
  const { b } = await registered();
  const shared = book({ shared: true, title: `Shared ${Math.random()}`, fileId: await upload(b, Buffer.from(`shared ${Math.random()}`)) });
  const mine = book({ fileId: await upload(b, Buffer.from(`private ${Math.random()}`)) });
  const res = await b.post('/v1/sync/push', push('s', { type: 'book.put', book: shared }, { type: 'book.put', book: mine }));
  expect(res.body.rejected).toEqual([]);
  return { b, shared, mine };
}

describe('shared library', () => {
  it('lists every library’s shared books for anyone, without a key', async () => {
    const one = await sharer();
    const two = await sharer();
    const list = await browser().get('/v1/shelf');
    expect(list.status).toBe(200);
    const ids = list.body.books.map((x: { id: string }) => x.id);
    expect(ids).toEqual(expect.arrayContaining([one.shared.id, two.shared.id]));
    expect(ids).not.toContain(one.mine.id);
    const entry = list.body.books.find((x: { id: string }) => x.id === one.shared.id);
    expect(entry).toMatchObject({ title: one.shared.title, fileId: one.shared.fileId, coverId: null, line: one.shared.line });
    // Newest first.
    expect(ids.indexOf(two.shared.id)).toBeLessThan(ids.indexOf(one.shared.id));
  });

  it('gives anyone a shared book’s file, and nobody a private one', async () => {
    const { shared, mine } = await sharer();
    const anon = browser();
    const link = await anon.get(`/v1/shelf/files/${shared.fileId}/link`);
    expect(link.status).toBe(200);
    expect((await fetch(link.body.url)).status).toBe(200);
    expect((await anon.get(`/v1/shelf/files/${mine.fileId}/link`)).status).toBe(404);
  });

  it('lets a reader start a copy that keeps working after the book leaves the shelf, once read into', async () => {
    const { b: owner, shared, mine } = await sharer();
    const { b: reader } = await registered();
    const copy = book({ fileId: shared.fileId, origin: shared.id });
    expect((await reader.post('/v1/sync/push', push('r', { type: 'book.put', book: copy }))).body.rejected).toEqual([]);
    await reader.post('/v1/sync/push', push('r1', { type: 'read.put', bookId: copy.id, read: { progress: 0.1, line: '', lastOpened: Date.now(), wordsRead: 180 } }));
    const pulled = (await reader.get('/v1/sync/pull?since=0')).body.books[0];
    expect(pulled).toMatchObject({ id: copy.id, origin: shared.id, fileId: shared.fileId });
    expect((await reader.get(`/v1/files/${shared.fileId}/link`)).status).toBe(200);

    // A private file can't be borrowed.
    const sneak = book({ fileId: mine.fileId });
    expect((await reader.post('/v1/sync/push', push('r', { type: 'book.put', book: sneak }))).body.rejected[0].code).toBe('file_missing');

    // The sharer takes it off the shelf: it's gone for new readers, and the copy still opens.
    await owner.post('/v1/sync/push', push('s2', { type: 'book.remove', bookId: shared.id }));
    const ids = (await browser().get('/v1/shelf')).body.books.map((x: { id: string }) => x.id);
    expect(ids).not.toContain(shared.id);
    expect((await browser().get(`/v1/shelf/files/${shared.fileId}/link`)).status).toBe(404);
    expect((await reader.get(`/v1/files/${shared.fileId}/link`)).status).toBe(200);
    expect((await reader.post('/v1/sync/push', push('r2', { type: 'book.put', book: { ...copy, title: 'Renamed' } }))).body.rejected).toEqual([]);
    expect((await reader.get('/v1/sync/pull?since=0')).body.lapsed).toEqual([]);
    const { b: late } = await registered();
    const tooLate = book({ fileId: shared.fileId, origin: shared.id });
    expect((await late.post('/v1/sync/push', push('l', { type: 'book.put', book: tooLate }))).body.rejected[0].code).toBe('file_missing');
  });

  it('takes a book off the shelf and puts it back with its shared switch', async () => {
    const { b: owner, shared } = await sharer();
    const listed = async () => (await browser().get('/v1/shelf')).body.books.map((x: { id: string }) => x.id);
    await owner.post('/v1/sync/push', push('o1', { type: 'book.put', book: { ...shared, shared: false } }));
    expect(await listed()).not.toContain(shared.id);
    await owner.post('/v1/sync/push', push('o2', { type: 'book.put', book: { ...shared, shared: true } }));
    expect(await listed()).toContain(shared.id);
  });

  it('keeps a book on the shelf that its sharer took out of their own books', async () => {
    const { b: owner, shared } = await sharer();
    const listed = async () => (await browser().get('/v1/shelf')).body.books.map((x: { id: string }) => x.id);
    const mine = async () => (await owner.get('/v1/sync/pull?since=0')).body.books.find((x: { id: string }) => x.id === shared.id);
    await owner.post('/v1/sync/push', push('s1', { type: 'book.put', book: { ...shared, sharedOnly: true } }));
    expect(await listed()).toContain(shared.id);
    expect(await mine()).toMatchObject({ shared: true, sharedOnly: true, removedAt: null });
    await owner.post('/v1/sync/push', push('s2', { type: 'book.put', book: { ...shared, sharedOnly: false } }));
    expect((await mine()).sharedOnly).toBeUndefined();
  });

  it('lets a copy lapse while it’s barely read and its book is private, and keeps it once read into', async () => {
    const { b: owner, shared } = await sharer();
    const { b: reader } = await registered();
    const copy = book({ fileId: shared.fileId, origin: shared.id });
    await reader.post('/v1/sync/push', push('r', { type: 'book.put', book: copy }));
    const read = (wordsRead: number, lastOpened: number) => reader.post('/v1/sync/push', push(`w${wordsRead}`, { type: 'read.put', bookId: copy.id, read: { progress: 0.01, line: '', lastOpened, wordsRead } }));
    await read(60, Date.now());
    const pull = async () => (await reader.get('/v1/sync/pull?since=0')).body;
    expect((await pull()).lapsed).toEqual([]);

    // Private again: a copy read only 60 words in lapses, and its file closes to it.
    await owner.post('/v1/sync/push', push('o1', { type: 'book.put', book: { ...shared, shared: false } }));
    expect((await pull()).lapsed).toEqual([copy.id]);
    expect((await reader.get(`/v1/files/${shared.fileId}/link`)).status).toBe(404);

    // Shared again, it's back.
    await owner.post('/v1/sync/push', push('o2', { type: 'book.put', book: { ...shared, shared: true } }));
    expect((await pull()).lapsed).toEqual([]);

    // Read past 100 words, even from an older session on another device, and it's kept for good.
    await read(140, Date.now() - 60_000);
    const after = await pull();
    expect(after.reads.find((r: { bookId: string }) => r.bookId === copy.id).read.wordsRead).toBe(140);
    await owner.post('/v1/sync/push', push('o3', { type: 'book.put', book: { ...shared, shared: false } }));
    expect((await pull()).lapsed).toEqual([]);
    expect((await reader.get(`/v1/files/${shared.fileId}/link`)).status).toBe(200);
  });
});
