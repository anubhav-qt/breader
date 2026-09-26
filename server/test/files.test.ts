import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { libraries } from '../src/db/schema.ts';
import { book, primary, push, registered } from './helpers.ts';

const bytes = (s: string) => Buffer.from(s);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function upload(b: Awaited<ReturnType<typeof registered>>['b'], body: Buffer, mime = 'application/epub+zip') {
  const ask = await b.post('/v1/uploads', { sha256: sha(body), size: body.length, mime, kind: 'book' });
  if (ask.body.status === 'upload') {
    const put = await fetch(ask.body.upload.url, { method: 'PUT', headers: ask.body.upload.headers, body });
    expect(put.status).toBe(200);
    const done = await b.post(`/v1/uploads/${ask.body.fileId}/complete`);
    expect(done.body).toEqual({ fileId: ask.body.fileId, status: 'ready' });
  }
  return ask;
}

describe('files', () => {
  it('uploads straight to storage with a signed link, then counts it against the quota', async () => {
    const { b } = await registered();
    const body = bytes(`an epub ${Math.random()}`);
    const ask = await upload(b, body);
    expect(ask.body.status).toBe('upload');
    expect(ask.body.upload.headers['x-amz-checksum-sha256']).toBe(Buffer.from(sha(body), 'hex').toString('base64'));
    expect((await b.get('/v1/me')).body.library.usedBytes).toBe(body.length);

    // Linked to a book, then downloadable through a short-lived link.
    const a = book({ fileId: ask.body.fileId });
    expect((await b.post('/v1/sync/push', push('c', { type: 'book.put', book: a }))).body.rejected).toEqual([]);
    expect((await b.get('/v1/sync/pull?since=0')).body.books[0].fileId).toBe(ask.body.fileId);
    const link = await b.get(`/v1/files/${ask.body.fileId}/link`);
    expect(Buffer.from(await (await fetch(link.body.url)).arrayBuffer()).equals(body)).toBe(true);
    const redirect = await b.get(`/v1/files/${ask.body.fileId}`);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toContain(`/breader-test/lib/`);
  });

  it('skips the upload when this library already has the file', async () => {
    const { b } = await registered();
    const body = bytes(`same ${Math.random()}`);
    const first = await upload(b, body);
    const again = await b.post('/v1/uploads', { sha256: sha(body), size: body.length, mime: 'application/epub+zip', kind: 'book' });
    expect(again.body).toEqual({ fileId: first.body.fileId, status: 'ready' });
    expect((await b.get('/v1/me')).body.library.usedBytes).toBe(body.length);
  });

  it('never deduplicates across libraries, so nobody can probe for someone else’s file', async () => {
    const one = await registered();
    const two = await registered();
    const body = bytes(`private ${Math.random()}`);
    const mine = await upload(one.b, body);
    const theirs = await two.b.post('/v1/uploads', { sha256: sha(body), size: body.length, mime: 'application/epub+zip', kind: 'book' });
    expect(theirs.body.status).toBe('upload');
    expect(theirs.body.fileId).not.toBe(mine.body.fileId);
    expect((await two.b.get(`/v1/files/${mine.body.fileId}/link`)).status).toBe(404);
  });

  it('refuses a file of the wrong size or content', async () => {
    const { b } = await registered();
    const body = bytes(`exact ${Math.random()}`);
    const ask = await b.post('/v1/uploads', { sha256: sha(body), size: body.length, mime: 'text/plain', kind: 'book' });
    const longer = await fetch(ask.body.upload.url, { method: 'PUT', headers: ask.body.upload.headers, body: Buffer.concat([body, bytes('!')]) });
    expect(longer.ok).toBe(false);
    const tampered = Buffer.from(body);
    tampered[0] ^= 1;
    const wrong = await fetch(ask.body.upload.url, { method: 'PUT', headers: ask.body.upload.headers, body: tampered });
    expect(wrong.ok).toBe(false);
    expect((await b.post(`/v1/uploads/${ask.body.fileId}/complete`)).body.code).toBe('upload_missing');
  });

  it('enforces the per-file limit, the quota and the file types', async () => {
    const { b, libraryId } = await registered();
    const big = await b.post('/v1/uploads', { sha256: 'a'.repeat(64), size: 101 * 1024 * 1024, mime: 'application/pdf', kind: 'book' });
    expect(big.status).toBe(413);
    expect(big.body.message).toBe('This file is 101 MB. Key libraries take files up to 100 MB.');
    await primary.db.update(libraries).set({ usedBytes: 100 * 1024 * 1024 - 10 }).where(eq(libraries.id, libraryId));
    expect((await b.post('/v1/uploads', { sha256: 'b'.repeat(64), size: 11, mime: 'application/pdf', kind: 'book' })).body.code).toBe('quota_full');
    expect((await b.post('/v1/uploads', { sha256: 'c'.repeat(64), size: 5, mime: 'text/html', kind: 'book' })).body.code).toBe('bad_type');
  });
});
