import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { LIMITS } from '@breader/shared';
import { libraries, libraryItems } from '../src/db/schema.ts';
import type { Mail } from '../src/lib/mail.ts';
import { book, browser, primary, push, registered } from './helpers.ts';

// Account emails go nowhere in tests; their links are kept here instead.
const sent: Mail[] = [];
vi.mock('../src/lib/mail.ts', () => ({ sendMail: async (_env: unknown, m: Mail) => { sent.push(m); } }));
const lastLink = (to: string) => new URL([...sent].reverse().find((m) => m.to === to)!.link.url);

type B = ReturnType<typeof browser>;
const email = () => `reader-${Math.random().toString(36).slice(2, 10)}@example.com`;
const PASSWORD = 'correct horse battery';

async function signUp(b: B, address = email(), password = PASSWORD) {
  const r = await b.post('/v1/auth/sign-up/email', { email: address, password, name: address.split('@')[0] });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return address;
}
async function logIn(b: B, address: string, password = PASSWORD) {
  const r = await b.post('/v1/auth/sign-in/email', { email: address, password });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}
const link = (b: B, body: Record<string, unknown> = {}) => b.post('/v1/session/account', body);
const titles = async (b: B) => (await b.get('/v1/sync/pull?since=0')).body.books.map((x: { title: string }) => x.title).sort();

const sha = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');
async function upload(b: B, body: Buffer) {
  const ask = await b.post('/v1/uploads', { sha256: sha(body), size: body.length, mime: 'application/epub+zip', kind: 'book' });
  if (ask.body.status === 'upload') {
    await fetch(ask.body.upload.url, { method: 'PUT', headers: ask.body.upload.headers, body });
    await b.post(`/v1/uploads/${ask.body.fileId}/complete`);
  }
  return ask.body.fileId as string;
}

describe('accounts', () => {
  it('needs a login', async () => {
    const r = await link(browser());
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('logged_out');
  });

  it('takes over this browser’s key library on a first login, keeping its key', async () => {
    const { b, key, libraryId } = await registered();
    await b.post('/v1/sync/push', push('adopt', { type: 'book.put', book: book({ title: 'Kept' }) }));
    const address = await signUp(b);

    const r = await link(b, { key });
    expect(r.body).toMatchObject({ outcome: 'adopted', key, account: { email: address, emailVerified: false } });
    expect(r.body.library).toMatchObject({ id: libraryId, keyOnly: false, quotaBytes: LIMITS.account.quotaBytes, expiresAt: null });
    expect(await titles(b)).toEqual(['Kept']);
    // Asking again changes nothing.
    expect((await link(b, { key })).body).toMatchObject({ outcome: 'same', key });
  });

  it('gives a new account its own library and key, which open it anywhere', async () => {
    const b = browser();
    const address = await signUp(b);
    const r = await link(b);
    expect(r.body.outcome).toBe('created');
    expect(r.body.key).toMatch(/^BRDR(-[0-9A-Z]{4}){5}$/);
    await b.post('/v1/sync/push', push('new', { type: 'book.put', book: book({ title: 'Mine' }) }));

    // Another browser: logging in opens the same library, with the same key.
    const other = browser();
    await logIn(other, address);
    expect((await link(other)).body).toMatchObject({ outcome: 'opened', key: r.body.key, library: { id: r.body.library.id } });
    expect(await titles(other)).toEqual(['Mine']);
    // So does the key alone.
    const byKey = browser();
    expect((await byKey.post('/v1/session/key', { key: r.body.key })).body.library.id).toBe(r.body.library.id);
  });

  it('asks before moving another library’s books in, then moves them, sharing files it already has', async () => {
    const home = browser();
    const address = await signUp(home);
    const account = (await link(home)).body;
    const same = Buffer.from(`the same epub ${Math.random()}`);
    const homeFile = await upload(home, same);
    await home.post('/v1/sync/push', push('home', { type: 'book.put', book: book({ title: 'At home', fileId: homeFile }) }));

    // A browser that made its own key library first, with the same file and another.
    const { b: away, key: awayKey, libraryId: awayId } = await registered();
    const awayFile = await upload(away, same);
    const onlyAway = Buffer.from(`only here ${Math.random()}`);
    const otherFile = await upload(away, onlyAway);
    const sameBook = book({ title: 'Same file', fileId: awayFile });
    await away.post('/v1/sync/push', push('away',
      { type: 'book.put', book: sameBook },
      { type: 'book.put', book: book({ title: 'New file', fileId: otherFile }) },
      { type: 'read.put', bookId: sameBook.id, read: { progress: 0.5, line: 'Halfway.', lastOpened: Date.now() } },
    ));
    await logIn(away, address);

    const ask = await link(away, { key: awayKey });
    expect(ask.body).toMatchObject({ outcome: 'choose', books: 2 });
    const claimed = await link(away, { key: awayKey, claim: true });
    expect(claimed.body).toMatchObject({ outcome: 'claimed', key: account.key, library: { id: account.library.id } });

    // Everything is in the account's library, and the shared file is stored and counted once.
    expect(await titles(away)).toEqual(['At home', 'New file', 'Same file']);
    const pulled = (await home.get('/v1/sync/pull?since=0')).body.books;
    expect(pulled.find((x: { title: string }) => x.title === 'Same file').fileId).toBe(homeFile);
    expect(pulled.find((x: { title: string }) => x.title === 'New file').fileId).toBe(otherFile);
    const reads = (await home.get('/v1/sync/pull?since=0')).body.reads;
    expect(reads.find((r: { bookId: string }) => r.bookId === sameBook.id)?.read.line).toBe('Halfway.');
    expect((await home.get('/v1/me')).body.library.usedBytes).toBe(same.length + onlyAway.length);
    expect(await primary.db.select().from(libraryItems).where(eq(libraryItems.libraryId, awayId))).toEqual([]);

    // The old key now says where the books went, instead of starting an empty library.
    const stale = browser();
    expect((await stale.post('/v1/session/key', { key: awayKey })).body.code).toBe('library_moved');
    expect((await stale.post('/v1/libraries', { libraryId: awayId, key: awayKey })).body.code).toBe('library_moved');
    const [retired] = await primary.db.select().from(libraries).where(eq(libraries.id, awayId));
    expect(retired.retiredAt).not.toBeNull();
    expect(retired.ownerAccountId).not.toBeNull();
  });

  it('can leave another library’s books where they are', async () => {
    const home = browser();
    const address = await signUp(home);
    const account = (await link(home)).body;
    const { b: away, key: awayKey } = await registered();
    await away.post('/v1/sync/push', push('left', { type: 'book.put', book: book({ title: 'Stays' }) }));
    await logIn(away, address);

    expect((await link(away, { key: awayKey, claim: false })).body).toMatchObject({ outcome: 'switched', library: { id: account.library.id } });
    expect(await titles(away)).toEqual([]);
    const byKey = browser();
    await byKey.post('/v1/session/key', { key: awayKey });
    expect(await titles(byKey)).toEqual(['Stays']);
  });

  it('opens the account’s library without asking when this browser’s own has no books', async () => {
    const home = browser();
    const address = await signUp(home);
    const account = (await link(home)).body;
    const { b: empty, key } = await registered();
    await logIn(empty, address);
    expect((await link(empty, { key })).body).toMatchObject({ outcome: 'opened', library: { id: account.library.id } });
  });

  it('resets a password from the emailed link, which points at the app', async () => {
    const b = browser();
    const address = await signUp(b);
    expect((await b.post('/v1/auth/request-password-reset', { email: address, redirectTo: 'http://localhost:5173/' })).status).toBe(200);
    const url = lastLink(address);
    expect(url.origin).toBe('http://localhost:5173');
    const token = url.searchParams.get('reset')!;
    expect((await b.post('/v1/auth/reset-password', { token, newPassword: 'a whole new password' })).status).toBe(200);

    const again = browser();
    expect((await again.post('/v1/auth/sign-in/email', { email: address, password: PASSWORD })).status).toBe(401);
    await logIn(again, address, 'a whole new password');
  });

  it('confirms an email from the link sent on sign-up', async () => {
    const b = browser();
    const address = await signUp(b);
    const token = lastLink(address).searchParams.get('verify')!;
    expect((await b.get(`/v1/auth/verify-email?token=${encodeURIComponent(token)}`)).status).toBe(200);
    expect((await link(b)).body.account).toMatchObject({ email: address, emailVerified: true });
  });

  it('logs out without ending the library session', async () => {
    const b = browser();
    await signUp(b);
    await link(b);
    expect((await b.post('/v1/auth/sign-out')).status).toBe(200);
    expect((await link(b)).status).toBe(401);
    expect((await b.get('/v1/me')).status).toBe(200);
  });
});
