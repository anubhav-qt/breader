import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { newLibraryKey } from '@breader/shared';
import { libraries } from '../src/db/schema.ts';
import { browser, primary, registered } from './helpers.ts';

describe('key libraries', () => {
  it('registers a library made in the browser and signs that browser in', async () => {
    const b = browser();
    const key = newLibraryKey();
    const libraryId = crypto.randomUUID();
    const r = await b.post('/v1/libraries', { libraryId, key });
    expect(r.status).toBe(201);
    expect(r.body.library).toMatchObject({ id: libraryId, rev: 0, keyOnly: true, usedBytes: 0, quotaBytes: 100 * 1024 * 1024 });
    expect(r.body.library.expiresAt).toBeGreaterThan(Date.now() + 360 * 86_400_000);
    expect(r.headers.get('set-cookie')).toMatch(/brdr_session=.*HttpOnly.*SameSite=Lax/);
    expect((await b.get('/v1/me')).body.library.id).toBe(libraryId);
  });

  it('stores an HMAC of the key, never the key', async () => {
    const { key, libraryId } = await registered();
    const [row] = await primary.db.select().from(libraries).where(eq(libraries.id, libraryId));
    expect(row.keyHash).toHaveLength(32);
    expect(JSON.stringify(row)).not.toContain(key.slice(5));
  });

  it('treats a repeated registration as a retry', async () => {
    const { b, key, libraryId } = await registered();
    expect((await b.post('/v1/libraries', { libraryId, key })).status).toBe(201);
  });

  it('refuses an id that belongs to another key, and a key that opens another library', async () => {
    const { key, libraryId } = await registered();
    const other = browser();
    expect((await other.post('/v1/libraries', { libraryId, key: newLibraryKey() })).body.code).toBe('library_exists');
    expect((await other.post('/v1/libraries', { libraryId: crypto.randomUUID(), key })).body.code).toBe('key_taken');
  });

  it('opens a library from another browser with the key, however it was typed', async () => {
    const { key, libraryId } = await registered();
    const typed = key.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l');
    const other = browser();
    const r = await other.post('/v1/session/key', { key: typed });
    expect(r.status).toBe(200);
    expect(r.body.library.id).toBe(libraryId);
    expect((await other.get('/v1/me')).status).toBe(200);
  });

  it('says clearly when a key opens nothing, or isn’t a key', async () => {
    const b = browser();
    const unknown = await b.post('/v1/session/key', { key: newLibraryKey() });
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual({ code: 'unknown_key', message: 'That key doesn’t open a library. Check it and try again.' });
    expect((await b.post('/v1/session/key', { key: 'BRDR-1234' })).body.code).toBe('bad_key');
  });

  it('needs a session for /me, and signing out ends it', async () => {
    const b = browser();
    expect((await b.get('/v1/me')).status).toBe(401);
    const { b: signedIn } = await registered();
    expect((await signedIn.del('/v1/session')).status).toBe(204);
    expect((await signedIn.get('/v1/me')).status).toBe(401);
  });

  it('ends sessions when the key epoch changes (key replaced)', async () => {
    const { b, libraryId } = await registered();
    await primary.db.update(libraries).set({ keyEpoch: 2 }).where(eq(libraries.id, libraryId));
    const r = await b.get('/v1/me');
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('signed_out');
  });

  it('rejects a forged cookie, however the signature is altered', async () => {
    const { b } = await registered();
    const { app, ORIGIN } = await import('./helpers.ts');
    const me = (cookie: string) => app.request('/v1/me', { headers: { cookie, origin: ORIGIN } });
    const flip = (c: string) => (c === 'A' ? 'B' : 'A');
    const mid = b.cookie.length - 20;
    // A changed middle character, and a last character that differs only in padding bits.
    expect((await me(b.cookie.slice(0, mid) + flip(b.cookie[mid]) + b.cookie.slice(mid + 1))).status).toBe(401);
    const b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const samePadding = b64[b64.indexOf(b.cookie.at(-1)!) ^ 1];
    const sig = b.cookie.split('.').at(-1)!;
    expect(Buffer.from(sig.slice(0, -1) + samePadding, 'base64url')).toEqual(Buffer.from(sig, 'base64url'));
    expect((await me(b.cookie.slice(0, -1) + samePadding)).status).toBe(401);
    expect((await me(b.cookie)).status).toBe(200);
  });

  it('refuses writes from other sites', async () => {
    const b = browser();
    const r = await b.post('/v1/libraries', { libraryId: crypto.randomUUID(), key: newLibraryKey() }, { origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('bad_origin');
  });

  it('answers CORS preflights only for the app’s origins', async () => {
    const { app } = await import('./helpers.ts');
    const ok = await app.request('/v1/sync/push', { method: 'OPTIONS', headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(ok.headers.get('access-control-allow-credentials')).toBe('true');
    const bad = await app.request('/v1/sync/push', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('slows down guessing: ten key attempts a minute per address', async () => {
    const b = browser('192.0.2.7');
    for (let i = 0; i < 10; i++) expect((await b.post('/v1/session/key', { key: newLibraryKey() })).status).toBe(401);
    const blocked = await b.post('/v1/session/key', { key: newLibraryKey() });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toMatch(/^\d+$/);
    expect((await browser('192.0.2.8').post('/v1/session/key', { key: newLibraryKey() })).status).toBe(401);
  });
});
