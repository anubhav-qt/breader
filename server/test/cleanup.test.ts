import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cleanFiles, expireLibraries, purgeTombstones } from '../src/jobs/cleanup.ts';
import { book, deps, primary, push, registered } from './helpers.ts';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const q = (sql: string, params: unknown[] = []) => primary.pool.query(sql, params);

/** Uploads a small file into the library, the way the app does. Returns its file id. */
async function upload(b: Awaited<ReturnType<typeof registered>>['b'], body = Buffer.from(`file ${Math.random()}`)) {
  const ask = await b.post('/v1/uploads', { sha256: sha(body), size: body.length, mime: 'text/plain', kind: 'book' });
  if (ask.body.status === 'upload') {
    await fetch(ask.body.upload.url, { method: 'PUT', headers: ask.body.upload.headers, body });
    await b.post(`/v1/uploads/${ask.body.fileId}/complete`);
  }
  return ask.body.fileId as string;
}

const blob = async (id: string) => (await q('SELECT status, unused_since, r2_key FROM blobs WHERE id = $1', [id])).rows[0];
const used = async (libraryId: string) => Number((await q('SELECT used_bytes FROM libraries WHERE id = $1', [libraryId])).rows[0].used_bytes);

describe('clean-up', () => {
  it('purges tombstones after 30 days, and sends older browsers the whole library', async () => {
    const { b, libraryId } = await registered();
    const [keep, old, recent] = [book(), book(), book()];
    await b.post('/v1/sync/push', push('c', { type: 'book.put', book: keep }, { type: 'book.put', book: old }, { type: 'book.put', book: recent }));
    await b.post('/v1/sync/push', push('c', { type: 'read.put', bookId: old.id, read: { progress: 0.5, line: '', lastOpened: Date.now() } }));
    const before = (await b.get('/v1/sync/pull?since=0')).body.rev;
    await b.post('/v1/sync/push', push('c', { type: 'book.remove', bookId: old.id }, { type: 'book.remove', bookId: recent.id }));
    const after = (await b.get('/v1/sync/pull?since=0')).body.rev;
    await q(`UPDATE library_items SET removed_at = now() - interval '31 days' WHERE library_id = $1 AND book_id = $2`, [libraryId, old.id]);

    expect(await purgeTombstones(primary.pool)).toBeGreaterThanOrEqual(1);
    const rows = await q('SELECT book_id FROM library_items WHERE library_id = $1 ORDER BY book_id', [libraryId]);
    expect(rows.rows.map((r) => r.book_id)).toEqual([keep.id, recent.id].sort());
    expect((await q('SELECT 1 FROM reading_states WHERE library_id = $1', [libraryId])).rowCount).toBe(0);

    // A browser that pulled before the removal never saw it: it gets everything, marked full.
    const stale = (await b.get(`/v1/sync/pull?since=${before}`)).body;
    expect(stale.full).toBe(true);
    expect(stale.books.map((x: { id: string }) => x.id).sort()).toEqual([keep.id, recent.id].sort());
    // One that saw it gets the usual changes.
    expect((await b.get(`/v1/sync/pull?since=${after}`)).body.full).toBeUndefined();
  });

  it('removes files nothing uses after 7 days, and gives the quota back', async () => {
    const { b, libraryId } = await registered();
    const kept = await upload(b);
    const onRemoved = await upload(b);
    const unused = await upload(b);
    const a = book({ fileId: kept });
    const r = book({ fileId: onRemoved });
    await b.post('/v1/sync/push', push('c', { type: 'book.put', book: a }, { type: 'book.put', book: r }, { type: 'book.remove', bookId: r.id }));
    const full = await used(libraryId);

    await cleanFiles(primary.pool, deps.storage);
    expect((await blob(unused)).unused_since).not.toBeNull();
    expect((await blob(kept)).unused_since).toBeNull();
    // A removed book still holds its file, so Undo brings the book back whole.
    expect((await blob(onRemoved)).unused_since).toBeNull();

    await q(`UPDATE blobs SET unused_since = now() - interval '8 days' WHERE id = $1`, [unused]);
    const key = (await blob(unused)).r2_key;
    expect(await deps.storage.head(key)).not.toBeNull();
    await cleanFiles(primary.pool, deps.storage);
    expect((await blob(unused)).status).toBe('deleted');
    expect(await deps.storage.head(key)).toBeNull();
    expect(await used(libraryId)).toBeLessThan(full);
    expect((await blob(kept)).status).toBe('ready');
  });

  it('keeps a file a book points at again, even after its week is up', async () => {
    const { b } = await registered();
    const id = await upload(b);
    await cleanFiles(primary.pool, deps.storage);
    await q(`UPDATE blobs SET unused_since = now() - interval '8 days' WHERE id = $1`, [id]);
    await b.post('/v1/sync/push', push('c', { type: 'book.put', book: book({ fileId: id }) }));
    await cleanFiles(primary.pool, deps.storage);
    expect(await blob(id)).toMatchObject({ status: 'ready', unused_since: null });
  });

  it('drops upload links never finished after a day, and old rows of deleted files', async () => {
    const { b } = await registered();
    const body = Buffer.from(`never sent ${Math.random()}`);
    const ask = await b.post('/v1/uploads', { sha256: sha(body), size: body.length, mime: 'text/plain', kind: 'book' });
    expect(ask.body.status).toBe('upload');
    await q(`UPDATE blobs SET unused_since = now() - interval '25 hours' WHERE id = $1`, [ask.body.fileId]);
    await cleanFiles(primary.pool, deps.storage);
    expect((await blob(ask.body.fileId)).status).toBe('deleted');

    await q(`UPDATE blobs SET unused_since = now() - interval '31 days' WHERE id = $1`, [ask.body.fileId]);
    await cleanFiles(primary.pool, deps.storage);
    expect(await blob(ask.body.fileId)).toBeUndefined();
  });

  it('deletes key libraries unused for a year, files and all', async () => {
    const idle = await registered();
    const active = await registered();
    const fileId = await upload(idle.b);
    const key = (await blob(fileId)).r2_key;
    await idle.b.post('/v1/sync/push', push('c', { type: 'book.put', book: book({ fileId }) }));
    await q(`UPDATE libraries SET last_active_at = now() - interval '366 days' WHERE id = $1`, [idle.libraryId]);

    expect(await expireLibraries(primary.pool, deps.storage)).toBeGreaterThanOrEqual(1);
    expect((await q('SELECT 1 FROM libraries WHERE id = $1', [idle.libraryId])).rowCount).toBe(0);
    expect((await q('SELECT 1 FROM library_items WHERE library_id = $1', [idle.libraryId])).rowCount).toBe(0);
    expect((await blob(fileId)).status).toBe('deleted');
    expect(await deps.storage.head(key)).toBeNull();
    expect((await idle.b.get('/v1/me')).status).toBe(401);
    expect((await active.b.get('/v1/me')).status).toBe(200);

    // The key is free again, so the browser that still holds the library can send it back.
    expect((await idle.b.post('/v1/libraries', { libraryId: idle.libraryId, key: idle.key })).status).toBe(201);
  });

  it('keeps an expired library’s shared file while another reader’s copy uses it', async () => {
    const idle = await registered();
    const reader = await registered();
    const fileId = await upload(idle.b);
    const key = (await blob(fileId)).r2_key;
    const shared = book({ fileId, shared: true });
    await idle.b.post('/v1/sync/push', push('c', { type: 'book.put', book: shared }));
    const copy = await reader.b.post('/v1/sync/push', push('r', { type: 'book.put', book: book({ fileId, origin: shared.id }) }));
    expect(copy.body.rejected).toEqual([]);
    await q(`UPDATE libraries SET last_active_at = now() - interval '366 days' WHERE id = $1`, [idle.libraryId]);

    expect(await expireLibraries(primary.pool, deps.storage)).toBeGreaterThanOrEqual(1);
    expect((await q('SELECT 1 FROM libraries WHERE id = $1', [idle.libraryId])).rowCount).toBe(0);
    expect((await blob(fileId)).status).toBe('ready');
    expect(await deps.storage.head(key)).not.toBeNull();
    expect((await reader.b.get(`/v1/files/${fileId}/link`)).status).toBe(200);
  });
});
