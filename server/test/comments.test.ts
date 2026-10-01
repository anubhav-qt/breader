import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { makeFeed } from '../src/mirror/feed.ts';
import type { Mail } from '../src/lib/mail.ts';
import { book, browser, mirror, primary, push, registered } from './helpers.ts';

const sent: Mail[] = [];
vi.mock('../src/lib/mail.ts', () => ({ sendMail: async (_env: unknown, m: Mail) => { sent.push(m); } }));

type Reader = Awaited<ReturnType<typeof registered>>['b'];
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const unique = (s: string) => `${s}${Math.random().toString(36).slice(2, 8)}`;

async function upload(b: Reader, body: Buffer): Promise<string> {
  const ask = await b.post('/v1/uploads', { sha256: sha(body), size: body.length, mime: 'application/epub+zip', kind: 'book' });
  if (ask.body.status === 'upload') {
    await fetch(ask.body.upload.url, { method: 'PUT', headers: ask.body.upload.headers, body });
    await b.post(`/v1/uploads/${ask.body.fileId}/complete`);
  }
  return ask.body.fileId;
}

/** A library with a book on the Shared Library. */
async function sharer() {
  const { b } = await registered();
  const shared = book({ shared: true, fileId: await upload(b, Buffer.from(`shared ${Math.random()}`)) });
  await b.post('/v1/sync/push', push('s', { type: 'book.put', book: shared }));
  return { b, shared };
}

const say = (b: Reader, thread: string, body: string, extra: Record<string, unknown> = {}) =>
  b.post(`/v1/comments/${thread}`, { section: 3, body, progress: 0.2, ...extra });

describe('comments', () => {
  it('asks for a name the first time, then goes by it', async () => {
    const { b, shared } = await sharer();
    expect((await b.get(`/v1/comments/${shared.id}`)).body).toEqual({ name: null, threads: [] });
    expect((await say(b, shared.id, 'Hello')).body.code).toBe('name_needed');

    const name = unique('Mira ');
    const first = await say(b, shared.id, '  That ending though  ', { name });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ name, comment: { section: 3, name, body: 'That ending though', progress: 0.2, mine: true } });
    // A name sent again later changes nothing.
    expect((await say(b, shared.id, 'Again', { name: unique('Other') })).body.name).toBe(name);

    const threads = (await b.get(`/v1/comments/${shared.id}`)).body;
    expect(threads.name).toBe(name);
    expect(threads.threads).toEqual([{ section: 3, count: 2, last: expect.objectContaining({ name, body: 'Again' }) }]);
    const list = (await b.get(`/v1/comments/${shared.id}/3`)).body.comments;
    expect(list.map((x: { body: string }) => x.body)).toEqual(['That ending though', 'Again']);
  });

  it('keeps names apart however they’re written', async () => {
    const { b: one, shared } = await sharer();
    const { b: two } = await registered();
    const name = unique('Old Reader');
    expect((await say(one, shared.id, 'First', { name })).status).toBe(201);

    const lookalike = name.toUpperCase().replace(' ', '_');
    expect((await two.get(`/v1/commenter/check?name=${encodeURIComponent(lookalike)}`)).body).toMatchObject({ free: false });
    expect((await one.get(`/v1/commenter/check?name=${encodeURIComponent(lookalike)}`)).body).toEqual({ free: true });
    expect((await two.get(`/v1/commenter/check?name=${encodeURIComponent(unique('New Reader'))}`)).body).toEqual({ free: true });
    expect((await two.get('/v1/commenter/check?name=%20x')).body.free).toBe(false);
    expect((await two.get('/v1/commenter/check?name=no%3Ctags%3E')).body.free).toBe(false);
    expect((await say(two, shared.id, 'Me too', { name: lookalike })).body.code).toBe('name_taken');
  });

  it('is one thread for the sharer and every copy, and nobody else’s', async () => {
    const { b: owner, shared } = await sharer();
    const { b: reader } = await registered();
    const copy = book({ fileId: shared.fileId, origin: shared.id });
    expect((await reader.post('/v1/sync/push', push('r', { type: 'book.put', book: copy }))).body.rejected).toEqual([]);

    await say(owner, shared.id, 'From the sharer', { name: unique('Sharer') });
    await say(reader, shared.id, 'From a copy', { name: unique('Copier'), section: -1 });
    const threads = (await owner.get(`/v1/comments/${shared.id}`)).body.threads;
    expect(threads.map((t: { section: number }) => t.section).sort()).toEqual([-1, 3]);
    const book1 = (await owner.get(`/v1/comments/${shared.id}/-1`)).body.comments;
    expect(book1).toEqual([expect.objectContaining({ body: 'From a copy', mine: false })]);

    // A private book's thread is its owner's alone, and an unknown id is no thread at all.
    const { b: other } = await registered();
    const mine = book();
    await other.post('/v1/sync/push', push('o', { type: 'book.put', book: mine }));
    expect((await reader.get(`/v1/comments/${mine.id}`)).status).toBe(404);
    expect((await other.get(`/v1/comments/${mine.id}`)).status).toBe(200);
    expect((await reader.get('/v1/comments/no-such-book')).status).toBe(404);
    expect((await reader.get('/v1/comments/bad%20id')).status).toBe(404);
    // Without a library, nothing.
    expect((await browser().get(`/v1/comments/${shared.id}`)).status).toBe(401);
  });

  it('lets a reader take back their own comment and nobody else’s', async () => {
    const { b: owner, shared } = await sharer();
    const { b: reader } = await registered();
    await reader.post('/v1/sync/push', push('r', { type: 'book.put', book: book({ fileId: shared.fileId, origin: shared.id }) }));
    const theirs = (await say(owner, shared.id, 'Mine', { name: unique('Owner') })).body.comment;
    const ours = (await say(reader, shared.id, 'Ours', { name: unique('Reader') })).body.comment;
    expect((await reader.del(`/v1/comments/${shared.id}/c/${theirs.id}`)).status).toBe(404);
    expect((await reader.del(`/v1/comments/${shared.id}/c/${ours.id}`)).status).toBe(204);
    expect((await owner.get(`/v1/comments/${shared.id}/3`)).body.comments.map((x: { body: string }) => x.body)).toEqual(['Mine']);
  });

  it('keeps replies one deep, under what they answer', async () => {
    const { b: owner, shared } = await sharer();
    const { b: reader } = await registered();
    await reader.post('/v1/sync/push', push('r', { type: 'book.put', book: book({ fileId: shared.fileId, origin: shared.id }) }));
    const first = (await say(owner, shared.id, 'Who was the Hatter?', { name: unique('Asker') })).body.comment;
    expect(first.parent).toBeNull();

    const answer = await say(reader, shared.id, 'A friend of the Hare', { name: unique('Answerer'), parent: first.id });
    expect(answer.status).toBe(201);
    expect(answer.body.comment).toMatchObject({ parent: first.id, section: 3 });
    // Answering the answer goes under the first comment too.
    const more = (await say(owner, shared.id, 'Thanks', { parent: answer.body.comment.id })).body.comment;
    expect(more.parent).toBe(first.id);

    const list = (await reader.get(`/v1/comments/${shared.id}/3`)).body.comments;
    expect(list.map((x: { body: string; parent: string | null }) => [x.body, x.parent])).toEqual([
      ['Who was the Hatter?', null],
      ['A friend of the Hare', first.id],
      ['Thanks', first.id],
    ]);
    expect((await owner.get(`/v1/comments/${shared.id}`)).body.threads).toEqual([expect.objectContaining({ section: 3, count: 3 })]);

    // Not across threads, nor to a comment that's gone or on another book.
    expect((await say(reader, shared.id, 'Elsewhere', { parent: first.id, section: -1 })).status).toBe(400);
    expect((await say(reader, shared.id, 'Nobody', { parent: 'no-such-comment' })).body.code).toBe('parent_gone');
    const { b: other, shared: elsewhere } = await sharer();
    const there = (await say(other, elsewhere.id, 'Another book', { name: unique('There') })).body.comment;
    expect((await say(reader, shared.id, 'Crossed', { parent: there.id })).body.code).toBe('parent_gone');

    // Taking a comment back leaves its replies where they were.
    expect((await owner.del(`/v1/comments/${shared.id}/c/${first.id}`)).status).toBe(204);
    const left = (await reader.get(`/v1/comments/${shared.id}/3`)).body.comments;
    expect(left.map((x: { body: string; parent: string | null }) => [x.body, x.parent])).toEqual([
      ['A friend of the Hare', first.id],
      ['Thanks', first.id],
    ]);
  });

  it('turns away what isn’t a comment', async () => {
    const { b, shared } = await sharer();
    const name = unique('Checker');
    expect((await say(b, shared.id, '   ', { name })).status).toBe(400);
    expect((await say(b, shared.id, 'x'.repeat(1001), { name })).status).toBe(400);
    expect((await say(b, shared.id, 'ok', { name, section: -2 })).status).toBe(400);
    expect((await say(b, shared.id, 'ok', { name, progress: 2 })).status).toBe(400);
    expect((await say(b, shared.id, 'ok', { name, extra: 1 })).status).toBe(400);
    expect((await say(b, shared.id, 'ok', { name, parent: 'not an id' })).status).toBe(400);
  });

  it('reaches the laptop’s copy', async () => {
    const { b, shared } = await sharer();
    const posted = (await say(b, shared.id, 'Copied', { name: unique('Copied') })).body.comment;
    const feed = makeFeed(primary.pool, mirror.pool);
    for (let i = 0; i < 50 && (await feed.step()) > 0; i++);
    const { rows: [row] } = await mirror.pool.query('SELECT c.body, m.name FROM comments c JOIN commenters m USING (library_id) WHERE c.id = $1', [posted.id]);
    expect(row).toMatchObject({ body: 'Copied' });
  });

  it('moves comments and the name into an account’s library', async () => {
    const { shared } = await sharer();
    const home = browser();
    const address = `reader-${Math.random().toString(36).slice(2, 10)}@example.com`;
    expect((await home.post('/v1/auth/sign-up/email', { email: address, password: 'correct horse battery', name: 'r' })).status).toBe(200);
    await home.post('/v1/session/account', {});

    const { b: away, key } = await registered();
    await away.post('/v1/sync/push', push('a', { type: 'book.put', book: book({ fileId: shared.fileId, origin: shared.id }) }));
    const name = unique('Traveller');
    await say(away, shared.id, 'Written before signing in', { name });
    await away.post('/v1/auth/sign-in/email', { email: address, password: 'correct horse battery' });
    expect((await away.post('/v1/session/account', { key, claim: true })).body.outcome).toBe('claimed');

    const threads = (await home.get(`/v1/comments/${shared.id}`)).body;
    expect(threads.name).toBe(name);
    expect((await home.get(`/v1/comments/${shared.id}/3`)).body.comments).toEqual([
      expect.objectContaining({ body: 'Written before signing in', name, mine: true }),
    ]);
  });
});
