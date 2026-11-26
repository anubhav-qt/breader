import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { book, browser, deps, push, registered } from './helpers.ts';

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
  it('make a library only to share, by its name, whose key anyone it’s open to can pass on', async () => {
    const maker = browser();
    const made = await maker.post('/v1/shared/create', { name: '  Book club  ' });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    expect(made.body.name).toBe('Book club');
    expect(made.body.key).toMatch(/^BRDR-/);
    // Its key opens it as anyone else's library, with its name.
    const friend = browser();
    const token = await tokenFor(made.body.key, friend);
    const list = await friend.post('/v1/shared/books', { token });
    expect(list.body).toMatchObject({ name: 'Book club', books: [] });
    // Both can add to it, and see what's added.
    const url = 'mangadex:12345678-1234-1234-1234-123456789099:en';
    const added = await friend.post('/v1/shared/add', { token, book: book({ source: 'remote', format: 'CBZ', url }) });
    expect(added.body.added).toBe(true);
    expect(await ids(made.body.token)).toHaveLength(1);
    // Its key goes to whoever it's open to, and no one's own library's does.
    expect((await friend.post('/v1/shared/key', { token })).body.key).toBe(made.body.key);
    const { key } = await sharer();
    expect((await browser().post('/v1/shared/key', { token: await tokenFor(key) })).body.key).toBeNull();
  });

  it('turn away a library to share with no name', async () => {
    expect((await browser().post('/v1/shared/create', { name: '   ' })).status).toBe(400);
  });

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

  it('let someone with the key add a series, once, out of the owner’s own books', async () => {
    const { key } = await sharer();
    const token = await tokenFor(key);
    const url = 'mangadex:12345678-1234-1234-1234-123456789012:en';
    const series = book({ source: 'remote', format: 'CBZ', url, shared: false, progress: 0.5 });
    const anon = browser();
    const first = await anon.post('/v1/shared/add', { token, book: series });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.added).toBe(true);
    const again = await anon.post('/v1/shared/add', { token, book: book({ source: 'remote', format: 'CBZ', url }) });
    expect(again.body.added).toBe(false);
    const list = await anon.post('/v1/shared/books', { token });
    const got = list.body.books.filter((x: { url?: string }) => x.url === url);
    expect(got).toHaveLength(1);
    expect(got[0].id).toBe(series.id);
  });

  it('add a member’s file only when they share it', async () => {
    const owner = await sharer();
    const token = await tokenFor(owner.key);
    const member = await sharer();
    const shared = await member.b.post('/v1/shared/add', { token, book: { ...member.shared, id: crypto.randomUUID(), origin: member.shared.id } });
    expect(shared.body.added).toBe(true);
    const secret = await member.b.post('/v1/shared/add', { token, book: { ...member.mine, id: crypto.randomUUID(), origin: member.mine.id } });
    expect(secret.status).toBe(400);
    expect(secret.body.code).toBe('file_missing');
    const list = await browser().post('/v1/shared/books', { token });
    expect(list.body.books.map((x: { fileId: string }) => x.fileId)).toContain(member.shared.fileId);
    expect(list.body.books.map((x: { fileId: string }) => x.fileId)).not.toContain(member.mine.fileId);
  });

  it('turn away an add with a forged token or no file', async () => {
    const { key, b, shared } = await sharer();
    const token = await tokenFor(key);
    const forged = await b.post('/v1/shared/add', { token: `${token.slice(0, token.lastIndexOf('.'))}.${'x'.repeat(32)}`, book: shared });
    expect(forged.body.code).toBe('shared_closed');
    const noFile = await browser().post('/v1/shared/add', { token, book: book({ source: 'file', fileId: null }) });
    expect(noFile.body.code).toBe('file_missing');
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
    // A reader up to date hears of it too: the change was in the owner's library, not theirs.
    const rev = (await reader.get('/v1/sync/pull?since=0')).body.rev;
    expect((await reader.get(`/v1/sync/pull?since=${rev}`)).body).toMatchObject({ rev, books: [], lapsed: [copy.id] });
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

describe('the public feed', () => {
  type Listed = { token: string; name: string | null; tag: string; books: number; manga: number; saves: number; updatedAt: number; own: boolean };
  const libraryOf = (token: string) => token.slice(0, token.lastIndexOf('.'));
  const listed = async (id: string, b = browser()) => {
    const feed = await b.get('/v1/shared/feed');
    expect(feed.status).toBe(200);
    return (feed.body.libraries as Listed[]).find((l) => libraryOf(l.token) === id);
  };

  it('list a library only once its owner makes it public, with a token that only reads it', async () => {
    const { b, key, shared } = await sharer();
    const keyToken = await tokenFor(key);
    const id = libraryOf(keyToken);
    expect(await listed(id)).toBeUndefined();
    expect((await b.get('/v1/shared/public')).body.public).toBe(false);

    const before = Date.now();
    expect((await b.post('/v1/shared/public', { on: true })).body.public).toBe(true);
    expect((await b.get('/v1/shared/public')).body.public).toBe(true);
    const seen = await listed(id);
    expect(seen).toMatchObject({ books: 1, manga: 0, saves: 0, own: false });
    // No name of its own: its short id, the start of its id, tells it apart.
    expect(seen!.name).toBeNull();
    expect(seen!.tag).toBe(id.replaceAll('-', '').slice(0, 6));
    expect(seen!.updatedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(seen!.token).not.toBe(keyToken);
    expect((await listed(id, b))!.own).toBe(true);

    // Its token reads the shared books and their files, and nothing more.
    const anon = browser();
    const list = await anon.post('/v1/shared/books', { token: seen!.token });
    expect(list.body).toMatchObject({ public: true, access: 'public', mayPublish: false });
    expect(list.body.books.map((x: { id: string }) => x.id)).toEqual([shared.id]);
    expect((await anon.post('/v1/shared/link', { token: seen!.token, fileId: shared.fileId })).status).toBe(200);
    const add = await anon.post('/v1/shared/add', { token: seen!.token, book: book({ source: 'remote', format: 'CBZ', url: 'mangadex:12345678-1234-1234-1234-123456789077:en' }) });
    expect(add.status).toBe(403);
    expect(add.body.code).toBe('read_only');
    expect((await anon.post('/v1/shared/key', { token: seen!.token })).body.key).toBeNull();
    expect((await anon.post('/v1/shared/public', { token: seen!.token, on: false })).body.code).toBe('not_yours');

    // Taken out again: gone from the feed, its token closed, its key still opening it.
    expect((await b.post('/v1/shared/public', { on: false })).body.public).toBe(false);
    expect(await listed(id)).toBeUndefined();
    expect((await anon.post('/v1/shared/books', { token: seen!.token })).body.code).toBe('shared_closed');
    expect((await anon.post('/v1/shared/books', { token: keyToken })).body.access).toBe('key');
  });

  it('let anyone with the key make a library made only to share public, and no one with someone’s own library’s', async () => {
    const made = await browser().post('/v1/shared/create', { name: 'Club' });
    const friend = browser();
    const token = await tokenFor(made.body.key, friend);
    expect((await friend.post('/v1/shared/books', { token })).body).toMatchObject({ public: false, access: 'key', mayPublish: true });
    expect((await friend.post('/v1/shared/public', { token, on: true })).body.public).toBe(true);
    const seen = await listed(libraryOf(token));
    expect(seen).toMatchObject({ name: 'Club', books: 0, manga: 0 });

    const { key } = await sharer();
    const theirs = await tokenFor(key);
    expect((await browser().post('/v1/shared/books', { token: theirs })).body.mayPublish).toBe(false);
    const no = await browser().post('/v1/shared/public', { token: theirs, on: true });
    expect(no.status).toBe(403);
    expect(no.body.code).toBe('not_yours');
    expect((await browser().post('/v1/shared/public', { on: true })).status).toBe(401);
  });

  it('let anyone with the key rename a library made only to share, for everyone and in the feed', async () => {
    const made = await browser().post('/v1/shared/create', { name: 'Club' });
    const friend = browser();
    const token = await tokenFor(made.body.key, friend);
    await friend.post('/v1/shared/public', { token, on: true });
    expect((await friend.post('/v1/shared/name', { token, name: '  Book club  ' })).body.name).toBe('Book club');
    expect((await browser().post('/v1/shared/books', { token })).body.name).toBe('Book club');
    expect(await listed(libraryOf(token))).toMatchObject({ name: 'Book club' });

    // An empty name takes it away: the feed shows its short id instead.
    expect((await friend.post('/v1/shared/name', { token, name: '' })).body.name).toBeNull();
    expect(await listed(libraryOf(token))).toMatchObject({ name: null });

    const { key } = await sharer();
    const theirs = await tokenFor(key);
    const no = await browser().post('/v1/shared/name', { token: theirs, name: 'Mine now' });
    expect(no.status).toBe(403);
    expect(no.body.code).toBe('not_yours');
    expect((await friend.post('/v1/shared/name', { token, name: 'x'.repeat(61) })).status).toBe(400);
  });

  it('count manga apart from books, and every other library that keeps it in its list', async () => {
    const { b, key } = await sharer();
    const keyToken = await tokenFor(key);
    const id = libraryOf(keyToken);
    const url = 'mangadex:12345678-1234-1234-1234-123456789066:en';
    expect((await browser().post('/v1/shared/add', { token: keyToken, book: book({ source: 'remote', format: 'CBZ', url }) })).body.added).toBe(true);
    await b.post('/v1/shared/public', { on: true });
    const seen = await listed(id);
    expect(seen).toMatchObject({ books: 1, manga: 1, saves: 0 });

    // Two others keep it, one by its key and one from the feed; the owner keeping it counts for nothing.
    for (const saved of [keyToken, seen!.token]) {
      const { b: other } = await registered();
      await other.post('/v1/sync/push', push('k', { type: 'settings.put', prefs: { sharedLibraries: [{ token: saved, at: Date.now() }] } }));
    }
    await b.post('/v1/sync/push', push('o', { type: 'settings.put', prefs: { sharedLibraries: [{ token: seen!.token, at: Date.now() }] } }));
    expect((await listed(id))!.saves).toBe(2);
  });
});

describe('a public library saved as a copy', () => {
  const libraryOf = (token: string) => token.slice(0, token.lastIndexOf('.'));
  const feedToken = async (id: string) => {
    const feed = await browser().get('/v1/shared/feed');
    return (feed.body.libraries as Array<{ token: string }>).find((l) => libraryOf(l.token) === id)!.token;
  };

  /** A public library of one shared book, and a reader's copy of it saved from the feed. */
  async function saved() {
    const one = await sharer();
    const id = libraryOf(await tokenFor(one.key));
    await one.b.post('/v1/sync/push', push('n', { type: 'settings.put', prefs: { libraryName: 'Club' } }));
    await one.b.post('/v1/shared/public', { on: true });
    const feed = await feedToken(id);
    const reader = browser();
    const copy = await reader.post('/v1/shared/copy', { token: feed });
    expect(copy.status, JSON.stringify(copy.body)).toBe(200);
    return { ...one, id, feed, reader, copy: copy.body as { token: string; name: string | null; of: string } };
  }

  it('is a library of the reader’s own, under the original’s name, opened by its own key', async () => {
    const { id, shared, reader, copy } = await saved();
    expect(copy).toMatchObject({ name: 'Club', of: id });
    expect(libraryOf(copy.token)).not.toBe(id);
    const list = await reader.post('/v1/shared/books', { token: copy.token });
    expect(list.body).toMatchObject({ name: 'Club', access: 'key', mayPublish: false, copy: { of: id, asked: 'none', grant: null } });
    expect(list.body.books.map((x: { id: string }) => x.id)).toEqual([shared.id]);
    expect(list.body.books[0]).toMatchObject({ origin: shared.id, fileId: shared.fileId });
    // Its key may be given out, as any library made only to share's; it never goes in the feed itself.
    expect((await reader.post('/v1/shared/key', { token: copy.token })).body.key).toMatch(/^BRDR-/);
    expect((await reader.post('/v1/shared/public', { token: copy.token, on: true })).body.code).toBe('not_yours');
  });

  it('takes in what the original adds, and keeps what it loses, files and all', async () => {
    const { b: owner, shared, copy } = await saved();
    const more = book({ shared: true, fileId: await upload(owner, Buffer.from(`more ${Math.random()}`)) });
    await owner.post('/v1/sync/push', push('a', { type: 'book.put', book: more }));
    expect(await ids(copy.token)).toEqual(expect.arrayContaining([shared.id, more.id]));

    await owner.post('/v1/sync/push', push('r', { type: 'book.remove', bookId: shared.id }, { type: 'book.put', book: { ...more, shared: false } }));
    expect(await ids(copy.token)).toEqual(expect.arrayContaining([shared.id, more.id]));
    expect((await browser().post('/v1/shared/link', { token: copy.token, fileId: shared.fileId })).status).toBe(200);
    expect((await browser().post('/v1/shared/link', { token: copy.token, fileId: more.fileId })).status).toBe(200);
  });

  it('lets only its key holders take books out, which stay out though the original keeps them', async () => {
    const { key, shared, feed, reader, copy } = await saved();
    const no = await browser().post('/v1/shared/remove', { token: feed, ids: [shared.id] });
    expect(no.status).toBe(403);
    expect(no.body.code).toBe('read_only');

    expect((await reader.post('/v1/shared/remove', { token: copy.token, ids: [shared.id] })).body.removed).toBe(1);
    expect(await ids(copy.token)).toEqual([]);
    expect(await ids(copy.token)).toEqual([]);
    expect(await ids(await tokenFor(key))).toEqual([shared.id]);
    // Asked again, nothing more goes.
    expect((await reader.post('/v1/shared/remove', { token: copy.token, ids: [shared.id] })).body.removed).toBe(0);
  });

  it('is made only from a public library', async () => {
    const { b: owner, feed } = await saved();
    await owner.post('/v1/shared/public', { on: false });
    expect((await browser().post('/v1/shared/copy', { token: feed })).body.code).toBe('shared_closed');
    expect((await browser().post('/v1/shared/copy', { token: 'nope.notarealtokenatallxxxx' })).body.code).toBe('shared_closed');
  });

  it('counts as a save of the original in the feed', async () => {
    const { id, copy } = await saved();
    const { b: other } = await registered();
    await other.post('/v1/sync/push', push('k', { type: 'settings.put', prefs: { sharedLibraries: [{ token: copy.token, of: id, at: Date.now() }] } }));
    const feed = await browser().get('/v1/shared/feed');
    const row = (feed.body.libraries as Array<{ token: string; saves: number }>).find((l) => libraryOf(l.token) === id);
    expect(row!.saves).toBe(1);
  });
});

describe('asking to change a public library', () => {
  const libraryOf = (token: string) => token.slice(0, token.lastIndexOf('.'));

  async function asked(note?: string) {
    const one = await sharer();
    const id = libraryOf(await tokenFor(one.key));
    await one.b.post('/v1/shared/public', { on: true });
    const feed = (await browser().get('/v1/shared/feed')).body.libraries.find((l: { token: string }) => libraryOf(l.token) === id).token as string;
    const { b: reader } = await registered();
    const copy = (await reader.post('/v1/shared/copy', { token: feed })).body.token as string;
    const ask = await reader.post('/v1/shared/ask', { token: copy, note });
    expect(ask.status, JSON.stringify(ask.body)).toBe(200);
    expect(ask.body.asked).toBe('asked');
    return { ...one, id, feed, reader, copy };
  }
  const asksOf = async (b: Reader, token?: string) => (await b.post('/v1/shared/asks', token ? { token } : {})).body.asks as Array<{ id: string; tag: string; note: string | null; state: string }>;
  const grantOf = async (reader: Reader, copy: string) => (await reader.post('/v1/shared/books', { token: copy })).body.copy as { asked: string; grant: string | null };

  it('shows the owner the ask and its note, and a yes lets that reader alone add and take out', async () => {
    const { b: owner, key, shared, reader, copy } = await asked('  I run the club  ');
    const asks = await asksOf(owner);
    expect(asks).toEqual([expect.objectContaining({ tag: libraryOf(copy).replaceAll('-', '').slice(0, 6), note: 'I run the club', state: 'asked' })]);
    expect((await grantOf(reader, copy))).toMatchObject({ asked: 'asked', grant: null });

    expect((await owner.post('/v1/shared/answer', { id: asks[0].id, give: true })).body.state).toBe('given');
    const { grant } = await grantOf(reader, copy);
    expect(grant).toBeTruthy();
    const opened = await reader.post('/v1/shared/books', { token: grant });
    expect(opened.body).toMatchObject({ access: 'grant', mayPublish: false });
    const url = 'mangadex:12345678-1234-1234-1234-123456789055:en';
    expect((await reader.post('/v1/shared/add', { token: grant, book: book({ source: 'remote', format: 'CBZ', url }) })).body.added).toBe(true);
    // Taken out, the owner's own book stays theirs, only shared no more.
    expect((await reader.post('/v1/shared/remove', { token: grant, ids: [shared.id] })).body.removed).toBe(1);
    expect(await ids(await tokenFor(key))).not.toContain(shared.id);
    const pulled = (await owner.get('/v1/sync/pull?since=0')).body.books as Array<{ id: string; shared: boolean; removed?: boolean }>;
    expect(pulled.find((x) => x.id === shared.id)).toMatchObject({ shared: false });
    // Never the key, and never the feed switch.
    expect((await reader.post('/v1/shared/key', { token: grant })).body.key).toBeNull();
    expect((await reader.post('/v1/shared/public', { token: grant, on: false })).body.code).toBe('not_yours');
  });

  it('lets the owner take a yes back, closing that reader’s token alone', async () => {
    const { b: owner, reader, copy } = await asked();
    const [ask] = await asksOf(owner);
    await owner.post('/v1/shared/answer', { id: ask.id, give: true });
    const { grant } = await grantOf(reader, copy);
    expect((await owner.post('/v1/shared/answer', { id: ask.id, give: false })).body.state).toBe('taken');
    expect((await reader.post('/v1/shared/books', { token: grant })).body.code).toBe('shared_closed');
    expect(await grantOf(reader, copy)).toMatchObject({ asked: 'taken', grant: null });
    expect(await asksOf(owner)).toEqual([]);
    // The copy stays the reader's, and they may ask again.
    expect((await reader.post('/v1/shared/books', { token: copy })).status).toBe(200);
    expect((await reader.post('/v1/shared/ask', { token: copy })).body.asked).toBe('asked');
    expect(await asksOf(owner)).toHaveLength(1);
  });

  it('lets the owner say no, and only the owner answer', async () => {
    const { b: owner, feed, reader, copy } = await asked();
    const [ask] = await asksOf(owner);
    const { b: stranger } = await registered();
    expect((await stranger.post('/v1/shared/answer', { id: ask.id, give: true })).body.code).toBe('no_ask');
    expect((await browser().post('/v1/shared/answer', { token: feed, id: ask.id, give: true })).body.code).toBe('not_yours');
    expect((await browser().post('/v1/shared/asks', {})).status).toBe(401);
    expect((await owner.post('/v1/shared/answer', { id: ask.id, give: false })).body.state).toBe('refused');
    expect(await grantOf(reader, copy)).toMatchObject({ asked: 'refused', grant: null });
    expect((await owner.post('/v1/shared/answer', { id: ask.id, give: true })).body.code).toBe('no_ask');
  });

  it('is asked only from a copy, with a short note', async () => {
    const { feed, key, reader, copy } = await asked();
    expect((await browser().post('/v1/shared/ask', { token: feed })).body.code).toBe('not_a_copy');
    expect((await browser().post('/v1/shared/ask', { token: await tokenFor(key) })).body.code).toBe('not_a_copy');
    expect((await reader.post('/v1/shared/ask', { token: copy, note: 'x'.repeat(501) })).status).toBe(400);
  });

  it('keeps a note of 500 characters whole', async () => {
    const longest = 'x'.repeat(500);
    const { b } = await asked(longest);
    const asks = await asksOf(b);
    expect(asks[0].note).toBe(longest);
  });

  it('takes 100 asks an hour from one network, then says wait', async () => {
    const { reader, copy } = await asked();
    for (let i = 1; i < 100; i++) {
      expect((await reader.post('/v1/shared/ask', { token: copy })).status).toBe(200);
    }
    const over = await reader.post('/v1/shared/ask', { token: copy });
    expect(over.status).toBe(429);
    expect(over.body.code).toBe('too_many');
  });

  it('takes 300 copies an hour from one network, then says wait', async () => {
    const { feed } = await asked();
    const reader = browser();
    for (let i = 0; i < 300; i++) {
      expect((await reader.post('/v1/shared/copy', { token: feed })).status).toBe(200);
    }
    const over = await reader.post('/v1/shared/copy', { token: feed });
    expect(over.status).toBe(429);
    expect(over.body.code).toBe('too_many');
  });

  it('lets a key holder answer for a library made only to share', async () => {
    const made = await browser().post('/v1/shared/create', { name: 'Club' });
    const friend = browser();
    const token = await tokenFor(made.body.key, friend);
    await friend.post('/v1/shared/public', { token, on: true });
    const feed = (await browser().get('/v1/shared/feed')).body.libraries.find((l: { token: string }) => libraryOf(l.token) === libraryOf(token)).token as string;
    const { b: reader } = await registered();
    const copy = (await reader.post('/v1/shared/copy', { token: feed })).body.token as string;
    await reader.post('/v1/shared/ask', { token: copy, note: 'hi' });
    const asks = await asksOf(friend, token);
    expect(asks).toHaveLength(1);
    expect((await friend.post('/v1/shared/answer', { token, id: asks[0].id, give: true })).body.state).toBe('given');
    expect((await grantOf(reader, copy)).grant).toBeTruthy();
  });

  it('gives the yes to the asker’s own library alone, not to others with the copy’s key', async () => {
    const { b: owner, shared, reader, copy } = await asked();
    const [ask] = await asksOf(owner);
    await owner.post('/v1/shared/answer', { id: ask.id, give: true });
    const { grant } = await grantOf(reader, copy);
    // A friend the reader gave the copy's key to sees the copy, but no yes of theirs.
    const { b: friend } = await registered();
    const copyKey = (await reader.post('/v1/shared/key', { token: copy })).body.key as string;
    const friendCopy = await tokenFor(copyKey, friend);
    expect(await grantOf(friend, friendCopy)).toMatchObject({ asked: 'none', grant: null });
    // Even holding the asker's token, anyone else only reads.
    expect((await friend.post('/v1/shared/books', { token: grant })).body.access).toBe('public');
    const no = await friend.post('/v1/shared/remove', { token: grant, ids: [shared.id] });
    expect(no.status).toBe(403);
    expect(no.body.code).toBe('read_only');
    expect((await browser().post('/v1/shared/add', { token: grant, book: book() })).body.code).toBe('signed_out');
    // The friend may ask for themselves, a yes of their own.
    expect((await friend.post('/v1/shared/ask', { token: friendCopy })).body.asked).toBe('asked');
    expect(await asksOf(owner)).toHaveLength(2);
  });

  it('is asked only by a reader signed in to a library of their own', async () => {
    const { feed } = await asked();
    const stranger = browser();
    const copy = (await stranger.post('/v1/shared/copy', { token: feed })).body.token as string;
    expect((await stranger.post('/v1/shared/ask', { token: copy })).body.code).toBe('signed_out');
  });

  it('ends every yes and ask once its owner takes it out of Public, and copies keep what they have', async () => {
    const { b: owner, key, shared, reader, copy } = await asked();
    const [ask] = await asksOf(owner);
    await owner.post('/v1/shared/answer', { id: ask.id, give: true });
    const { grant } = await grantOf(reader, copy);
    const { b: other, copy: waiting } = await (async () => {
      const { b } = await registered();
      const feed = (await browser().get('/v1/shared/feed')).body.libraries.find((l: { token: string }) => libraryOf(l.token) === libraryOf(grant!)).token as string;
      const made = (await b.post('/v1/shared/copy', { token: feed })).body.token as string;
      await b.post('/v1/shared/ask', { token: made });
      return { b, copy: made };
    })();
    expect(await asksOf(owner)).toHaveLength(2);

    await owner.post('/v1/shared/public', { on: false });
    expect((await reader.post('/v1/shared/books', { token: grant })).body.code).toBe('shared_closed');
    expect(await grantOf(reader, copy)).toMatchObject({ asked: 'taken', grant: null, live: false });
    expect(await grantOf(other, waiting)).toMatchObject({ asked: 'refused', grant: null, live: false });
    expect(await asksOf(owner)).toEqual([]);
    expect((await reader.post('/v1/shared/ask', { token: copy })).body.code).toBe('not_public');
    expect((await owner.post('/v1/shared/answer', { id: ask.id, give: true })).body.code).toBe('no_ask');
    expect(await ids(copy)).toEqual([shared.id]);
    // Those with its key still change it.
    expect((await browser().post('/v1/shared/remove', { token: await tokenFor(key), ids: [shared.id] })).body.removed).toBe(1);

    // Public again, nothing comes back by itself.
    await owner.post('/v1/shared/public', { on: true });
    expect((await reader.post('/v1/shared/books', { token: grant })).body.code).toBe('shared_closed');
    expect(await grantOf(reader, copy)).toMatchObject({ asked: 'taken', grant: null, live: true });
  });

  it('says no yes while it’s out of Public', async () => {
    const { b: owner } = await asked();
    const [ask] = await asksOf(owner);
    // Out of Public without the switch's clean-up: a yes still can't be given.
    await deps.pool.query('UPDATE libraries SET public_at = NULL WHERE id = (SELECT library_id FROM library_grants WHERE id = $1)', [ask.id]);
    expect((await owner.post('/v1/shared/answer', { id: ask.id, give: true })).body.code).toBe('not_public');
  });

  it('gives a reader the same copy back, ask and yes and all, when they save it again', async () => {
    const { b: owner, feed, reader, copy } = await asked();
    const [ask] = await asksOf(owner);
    await owner.post('/v1/shared/answer', { id: ask.id, give: true });
    const { grant } = await grantOf(reader, copy);
    const again = await reader.post('/v1/shared/copy', { token: feed });
    expect(again.body.token).toBe(copy);
    expect(await grantOf(reader, again.body.token)).toMatchObject({ asked: 'given', grant });
    expect(await asksOf(owner)).toHaveLength(1);
  });

  it('forgets an ask and its yes once the copy it came from is no longer in use', async () => {
    const { b: owner, reader, copy } = await asked();
    const [ask] = await asksOf(owner);
    await owner.post('/v1/shared/answer', { id: ask.id, give: true });
    const { grant } = await grantOf(reader, copy);
    await deps.pool.query('UPDATE libraries SET retired_at = now() WHERE id = $1', [libraryOf(copy)]);
    expect(await asksOf(owner)).toEqual([]);
    expect((await reader.post('/v1/shared/books', { token: grant })).body.code).toBe('shared_closed');
  });

  it('takes any number of feed asks, public switches and names from one network', async () => {
    const { b: owner } = await registered();
    const made = await browser().post('/v1/shared/create', { name: 'Busy' });
    const token = await tokenFor(made.body.key, owner);
    for (let i = 0; i < 130; i++) {
      expect((await owner.get('/v1/shared/feed')).status).toBe(200);
    }
    for (let i = 0; i < 35; i++) {
      expect((await owner.post('/v1/shared/public', { on: i % 2 === 0 })).status).toBe(200);
      expect((await owner.post('/v1/shared/name', { token, name: `Busy ${i}` })).status).toBe(200);
    }
  });

  it('names a copy for everyone its key opens it to', async () => {
    const { reader, copy } = await asked();
    expect((await reader.post('/v1/shared/books', { token: copy })).body).toMatchObject({ mayName: true, mayPublish: false });
    expect((await reader.post('/v1/shared/name', { token: copy, name: 'Club picks' })).body.name).toBe('Club picks');
    expect((await browser().post('/v1/shared/books', { token: copy })).body.name).toBe('Club picks');
  });
});
