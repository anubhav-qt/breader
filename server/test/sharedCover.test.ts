import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { app, book, primary, push, registered } from './helpers.ts';

type Reader = Awaited<ReturnType<typeof registered>>['b'];

async function upload(b: Reader, body: Buffer, mime: string, kind: 'book' | 'cover') {
  const ask = await b.post('/v1/uploads', { sha256: createHash('sha256').update(body).digest('hex'), size: body.length, mime, kind });
  await fetch(ask.body.upload.url, { method: 'PUT', headers: ask.body.upload.headers, body });
  await b.post(`/v1/uploads/${ask.body.fileId}/complete`);
  return ask.body.fileId as string;
}

/** A big cover, unlike any other test's, so each is its own picture. */
const bigCover = () =>
  sharp({ create: { width: 1200, height: 1800, channels: 3, background: { r: Math.floor(Math.random() * 256), g: 40, b: 40 } } }).png().toBuffer();

/** Asked for as a browser on any site asks for a picture: no cookie, no origin. */
const picture = (coverId: string) => app.request(`/v1/shared/cover/${coverId}.webp`);

async function sharedBook(b: Reader, over: Parameters<typeof book>[0] = {}) {
  const fileId = await upload(b, Buffer.from(`book ${Math.random()}`), 'application/epub+zip', 'book');
  const coverId = await upload(b, await bigCover(), 'image/png', 'cover');
  const it = book({ shared: true, fileId, coverId, ...over });
  const res = await b.post('/v1/sync/push', push('s', { type: 'book.put', book: it }));
  expect(res.body.rejected).toEqual([]);
  return it;
}

describe('a shared book’s cover', () => {
  it('comes small, as WebP, for anyone, kept a week by any cache', async () => {
    const { b } = await registered();
    const manga = await sharedBook(b, { format: 'CBZ' });
    const res = await picture(manga.coverId!);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('cache-control')).toBe('public, max-age=604800, immutable');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('set-cookie')).toBeNull();
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(600);
    expect(meta.height).toBe(900);
  });

  it('shows a book’s only once the model said yes, as the shelf does', async () => {
    const { b } = await registered();
    const it = await sharedBook(b);
    const waits = await picture(it.coverId!);
    expect(waits.status).toBe(404);
    expect(waits.headers.get('cache-control')).toContain('no-store');
    await primary.pool.query('UPDATE library_items SET cover_ok = cover_id WHERE book_id = $1', [it.id]);
    expect((await picture(it.coverId!)).status).toBe(200);
  });

  it('isn’t sent for a book kept to its library, taken out, or a file that isn’t a cover', async () => {
    const { b } = await registered();
    const mine = await sharedBook(b, { shared: false, format: 'CBZ' });
    expect((await picture(mine.coverId!)).status).toBe(404);
    const gone = await sharedBook(b, { format: 'CBZ' });
    await b.post('/v1/sync/push', push('g', { type: 'book.remove', bookId: gone.id }));
    expect((await picture(gone.coverId!)).status).toBe(404);
    expect((await picture(gone.fileId!)).status).toBe(404);
    expect((await picture('not-a-file')).status).toBe(404);
    expect((await app.request('/v1/shared/cover/..%2Fx.webp')).status).toBe(404);
  });
});
