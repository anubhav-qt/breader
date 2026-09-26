import { describe, expect, it } from 'vitest';
import { FED_TABLES } from '../src/db/schema.ts';
import { pruneReadFeed, pruneStaleFeed } from '../src/jobs/chores.ts';
import { makeFeed } from '../src/mirror/feed.ts';
import { book, mirror, primary, push, registered } from './helpers.ts';

const feed = makeFeed(primary.pool, mirror.pool);

async function drain() {
  for (let i = 0; i < 50; i++) if ((await feed.step()) === 0) return;
  throw new Error('feed did not settle');
}

/** Every fed table, row for row, as JSON. */
async function snapshot(pool: typeof primary.pool) {
  const out: Record<string, unknown[]> = {};
  for (const [t, pk] of Object.entries(FED_TABLES)) {
    // Byte order: the two servers' default collations sort mixed-case ids (accounts) differently.
    const order = pk.map((c) => `${c} COLLATE "C"`).join(', ');
    out[t] = (await pool.query(`SELECT to_jsonb(x) AS r FROM ${t} x ORDER BY ${order}`)).rows.map((r) => r.r);
  }
  return out;
}

describe('change feed', () => {
  it('copies Supabase into the laptop copy exactly, versions included', async () => {
    const { b } = await registered();
    const a = book();
    await b.post('/v1/sync/push', push('c', { type: 'book.put', book: a }, { type: 'read.put', bookId: a.id, read: { progress: 0.4, line: 'x', lastOpened: Date.now() } }));
    await b.post('/v1/sync/push', push('c', { type: 'edit.put', bookId: a.id, edit: { color: 'moss' } }, { type: 'settings.put', prefs: { theme: 'warm' } }));
    await drain();
    expect(await snapshot(mirror.pool)).toEqual(await snapshot(primary.pool));
  });

  it('stays exact while pushes race the feed', async () => {
    const readers = await Promise.all([registered(), registered(), registered()]);
    const writes = readers.flatMap(({ b }, i) =>
      Array.from({ length: 6 }, (_, j) => {
        const a = book();
        return b.post('/v1/sync/push', push(`race-${i}-${j}`, { type: 'book.put', book: a }, { type: 'read.put', bookId: a.id, read: { progress: j / 10, line: '', lastOpened: Date.now() } }));
      }),
    );
    const stepping = (async () => { for (let k = 0; k < 20; k++) await feed.step(); })();
    await Promise.all([...writes, stepping]);
    await drain();
    expect(await snapshot(mirror.pool)).toEqual(await snapshot(primary.pool));
  });

  it('replays deletes, and a late older write can’t bring the row back', async () => {
    const { b, libraryId } = await registered();
    const a = book();
    await b.post('/v1/sync/push', push('c', { type: 'book.put', book: a }));
    await drain();
    const [old] = (await primary.pool.query(`SELECT to_jsonb(x) AS r FROM library_items x WHERE library_id = $1`, [libraryId])).rows;
    await primary.pool.query('DELETE FROM library_items WHERE library_id = $1', [libraryId]);
    await drain();
    expect((await mirror.pool.query('SELECT 1 FROM library_items WHERE library_id = $1', [libraryId])).rowCount).toBe(0);

    // The old insert record shows up again (as if read out of order): the tombstone wins.
    const c = await mirror.pool.connect();
    await c.query(`INSERT INTO library_items SELECT * FROM jsonb_populate_record(NULL::library_items, $1::jsonb)
      WHERE NOT EXISTS (SELECT 1 FROM mirror_tombstones WHERE tbl = 'library_items' AND pk = $2 AND version >= $3)`,
      [old.r, { library_id: libraryId, book_id: a.id }, old.r.version]);
    c.release();
    expect((await mirror.pool.query('SELECT 1 FROM library_items WHERE library_id = $1', [libraryId])).rowCount).toBe(0);
  });

  it('reloads everything after being away longer than the feed is kept', async () => {
    const { b } = await registered();
    await b.post('/v1/sync/push', push('c', { type: 'book.put', book: book() }));
    await drain();
    // Records the laptop never read are pruned while it's away…
    await b.post('/v1/sync/push', push('c', { type: 'book.put', book: book() }));
    await primary.pool.query(`UPDATE change_log SET at = now() - interval '15 days' WHERE (txid, id) > (SELECT ack_txid, ack_id FROM feed_state)`);
    await pruneStaleFeed(primary.pool);
    expect((await primary.pool.query('SELECT lost_txid FROM feed_state')).rows[0].lost_txid).toBeGreaterThan(0);
    // …so on return it copies the tables afresh instead of trusting the gap.
    await drain();
    expect(await snapshot(mirror.pool)).toEqual(await snapshot(primary.pool));
  });

  it('prunes records the laptop has read once they are an hour old', async () => {
    const { b } = await registered();
    await b.post('/v1/sync/push', push('c', { type: 'book.put', book: book() }));
    await drain();
    await primary.pool.query(`UPDATE change_log SET at = now() - interval '2 hours'`);
    await b.post('/v1/sync/push', push('c', { type: 'book.put', book: book() })); // not yet read
    await pruneReadFeed(primary.pool);
    const { rows } = await primary.pool.query(`SELECT count(*)::int AS n FROM change_log WHERE (txid, id) <= (SELECT ack_txid, ack_id FROM feed_state)`);
    expect(rows[0].n).toBe(0);
    expect((await primary.pool.query('SELECT count(*)::int AS n FROM change_log')).rows[0].n).toBeGreaterThan(0);
  });
});
