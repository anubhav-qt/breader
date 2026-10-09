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

/** A library that shares one book and keeps one to itself. */
async function sharer() {
  const { b, key } = await registered();
  const shared = book({ shared: true, title: `Shared ${Math.random()}`, fileId: await upload(b, Buffer.from(`shared ${Math.random()}`)) });
  const mine = book({ fileId: await upload(b, Buffer.from(`private ${Math.random()}`)) });
  const res = await b.post('/v1/sync/push', push('s', { type: 'book.put', book: shared }, { type: 'book.put', book: mine }));
  expect(res.body.rejected).toEqual([]);
  return { b, key, shared, mine };
}

/** The token a key opens a library's shared books with. */
async function tokenFor(key: string, b = browser()) {
  const r = await b.post('/v1/shared/open', { key });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.token as string;
}

const ids = async (token: string) => (await browser().post('/v1/shared/books', { token })).body.books.map((x: { id: string }) => x.id) as string[];

describe('shared libraries', () => {
  it('open one library’s shared books with its key, and nobody else’s', async () => {
    const one = await sharer();
    const two = await sharer();
    const token = await tokenFor(one.key);
    expect(token).not.toContain(one.key);
    const list = await browser().post('/v1/shared/books', { token });
    expect(list.status).toBe(200);
    expect(list.body.name).toBeNull();
    const got = list.body.books.map((x: { id: string }) => x.id);
    expect(got).toEqual([one.shared.id]);
    expect(got).not.toContain(two.shared.id);
    expect(list.body.books[0]).toMatchObject({ title: one.shared.title, fileId: one.shared.fileId, coverId: null, line: one.shared.line, origin: null });
  });

  it('turn away a wrong key, a forged token and the old public shelf', async () => {
    const { libraryId } = await registered();
    const anon = browser();
    expect((await anon.post('/v1/shared/open', { key: 'not a key' })).body.code).toBe('bad_key');
    expect((await anon.post('/v1/shared/open', { key: 'BRDR-AAAA-AAAA-AAAA-AAAA-AAAA' })).status).toBe(404);
    const forged = await anon.post('/v1/shared/books', { token: `${libraryId}.${'x'.repeat(32)}` });
    expect(forged.status).toBe(404);
    expect(forged.body.code).toBe('shared_closed');
    expect((await anon.get('/v1/shelf')).status).toBe(404);
  });

  it('say whose library it is: its name, and whether it’s the one this browser is in', async () => {
    const { b, key } = await sharer();
    await b.post('/v1/sync/push', push('n', { type: 'settings.put', prefs: { libraryName: '  Ash’s shelf  ' } }));
    const own = await b.post('/v1/shared/open', { key });
    expect(own.body).toMatchObject({ name: 'Ash’s shelf', own: true });
    const other = await browser().post('/v1/shared/open', { key });
    expect(other.body.own).toBe(false);
    expect((await browser().post('/v1/shared/books', { token: other.body.token })).body.name).toBe('Ash’s shelf');
  });

  it('give a shared book’s file to anyone with the token, and never a private one', async () => {
    const { key, shared, mine } = await sharer();
    const token = await tokenFor(key);
    const anon = browser();
    const link = await anon.post('/v1/shared/link', { token, fileId: shared.fileId });
    expect(link.status).toBe(200);
    expect((await fetch(link.body.url)).status).toBe(200);
    expect((await anon.post('/v1/shared/link', { token, fileId: mine.fileId })).status).toBe(404);
    // Another library's token doesn't open this one's files.
    const other = await tokenFor((await sharer()).key);
    expect((await anon.post('/v1/shared/link', { token: other, fileId: shared.fileId })).status).toBe(404);
  });

  it('keep a file closed to libraries that only know its id', async () => {
    const { shared } = await sharer();
    const { b: stranger } = await registered();
    expect((await stranger.get(`/v1/files/${shared.fileId}/link`)).status).toBe(404);
  });

  it('share a reader’s copy on in their own library, and let copies of copies go when the book does', async () => {
    const { b: owner, key, shared } = await sharer();
    const { b: reader, key: readerKey } = await registered();
    // Read from the owner's library, the copy is shared in the reader's by default.
    const copy = book({ shared: true, fileId: shared.fileId, origin: shared.id });
    expect((await reader.post('/v1/sync/push', push('r', { type: 'book.put', book: copy }))).body.rejected).toEqual([]);
    expect((await reader.get(`/v1/files/${shared.fileId}/link`)).status).toBe(200);
    const readerToken = await tokenFor(readerKey);
    const listed = (await browser().post('/v1/shared/books', { token: readerToken })).body.books;
    expect(listed).toEqual([expect.objectContaining({ id: copy.id, origin: shared.id, fileId: shared.fileId })]);

    // A friend of the reader's copies it on from there, going by the first book.
    const { b: friend } = await registered();
    const link = await browser().post('/v1/shared/link', { token: readerToken, fileId: shared.fileId });
    expect(link.status).toBe(200);
    const again = book({ shared: true, fileId: shared.fileId, origin: shared.id });
    expect((await friend.post('/v1/sync/push', push('f', { type: 'book.put', book: again }))).body.rejected).toEqual([]);

    // The owner stops sharing it: copies barely read go, everywhere, and can't keep each other going.
    await owner.post('/v1/sync/push', push('o', { type: 'book.put', book: { ...shared, shared: false } }));
    expect(await ids(await tokenFor(key))).toEqual([]);
    expect(await ids(readerToken)).toEqual([]);
    expect((await reader.get('/v1/sync/pull?since=0')).body.lapsed).toEqual([copy.id]);
    expect((await friend.get('/v1/sync/pull?since=0')).body.lapsed).toEqual([again.id]);
    expect((await browser().post('/v1/shared/link', { token: readerToken, fileId: shared.fileId })).status).toBe(404);
    expect((await friend.get(`/v1/files/${shared.fileId}/link`)).status).toBe(404);
  });

  it('keep a copy read far enough into, and let it share the book on in its own right', async () => {
    const { b: owner, shared } = await sharer();
    const { b: reader, key: readerKey } = await registered();
    const copy = book({ shared: true, fileId: shared.fileId, origin: shared.id });
    await reader.post('/v1/sync/push', push('r', { type: 'book.put', book: copy }));
    await reader.post('/v1/sync/push', push('w', { type: 'read.put', bookId: copy.id, read: { progress: 0.1, line: '', lastOpened: Date.now(), wordsRead: 180 } }));
    await owner.post('/v1/sync/push', push('o', { type: 'book.remove', bookId: shared.id }));
    expect((await reader.get('/v1/sync/pull?since=0')).body.lapsed).toEqual([]);
    expect((await reader.get(`/v1/files/${shared.fileId}/link`)).status).toBe(200);
    const readerToken = await tokenFor(readerKey);
    expect(await ids(readerToken)).toEqual([copy.id]);
    expect((await browser().post('/v1/shared/link', { token: readerToken, fileId: shared.fileId })).status).toBe(200);
  });

  it('take a book out and put it back with its shared switch, and keep one its owner took out of their own books', async () => {
    const { b: owner, key, shared } = await sharer();
    const token = await tokenFor(key);
    await owner.post('/v1/sync/push', push('o1', { type: 'book.put', book: { ...shared, shared: false } }));
    expect(await ids(token)).not.toContain(shared.id);
    await owner.post('/v1/sync/push', push('o2', { type: 'book.put', book: { ...shared, shared: true } }));
    expect(await ids(token)).toContain(shared.id);
    await owner.post('/v1/sync/push', push('o3', { type: 'book.put', book: { ...shared, sharedOnly: true } }));
    expect(await ids(token)).toContain(shared.id);
  });

  it('share a series read from a catalogue by its url, and let a copy of it stay however little it’s read', async () => {
    const { b: owner, key } = await registered();
    const url = 'mangadex:0e1d2c3b-4a59-4687-9a6b-5c4d3e2f1a0b';
    const series = book({ shared: true, source: 'remote', url, format: 'CBZ', words: 0, line: '' });
    const hidden = book({ source: 'remote', url: 'sw:42', format: 'CBZ', words: 0, line: '' });
    expect((await owner.post('/v1/sync/push', push('o', { type: 'book.put', book: series }, { type: 'book.put', book: hidden }))).body.rejected).toEqual([]);
    const token = await tokenFor(key);
    const listed = (await browser().post('/v1/shared/books', { token })).body.books;
    expect(listed).toEqual([expect.objectContaining({ id: series.id, url, fileId: null, coverId: null })]);

    // A reader adds it: their copy reads from the catalogue and shares it on.
    const { b: reader, key: readerKey } = await registered();
    const copy = book({ shared: true, source: 'remote', url, format: 'CBZ', words: 0, line: '', origin: series.id });
    expect((await reader.post('/v1/sync/push', push('r', { type: 'book.put', book: copy }))).body.rejected).toEqual([]);
    expect(await ids(await tokenFor(readerKey))).toEqual([copy.id]);

    // The owner stops sharing it: the reader's copy stays, unread as it is.
    await owner.post('/v1/sync/push', push('o2', { type: 'book.put', book: { ...series, shared: false } }));
    expect(await ids(token)).toEqual([]);
    expect((await reader.get('/v1/sync/pull?since=0')).body.lapsed).toEqual([]);
    expect(await ids(await tokenFor(readerKey))).toEqual([copy.id]);
  });

  it('lets a private file be borrowed by nobody', async () => {
    const { mine } = await sharer();
    const { b: reader } = await registered();
    const sneak = book({ fileId: mine.fileId });
    expect((await reader.post('/v1/sync/push', push('r', { type: 'book.put', book: sneak }))).body.rejected[0].code).toBe('file_missing');
  });
});
