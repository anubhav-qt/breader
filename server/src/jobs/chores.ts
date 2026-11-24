import type pg from 'pg';

/** How long feed records wait for a read copy that's away before they're dropped. */
export const FEED_KEEP_DAYS = 14;

/**
 * Drops feed records older than two weeks. Each read copy that hadn't read some of them yet
 * remembers their newest txid in feed_copies.lost_txid, and reloads everything on return. A copy
 * unheard of for that long loses its place, so it no longer holds pruning back; if it comes back,
 * it finds no place kept and reloads (mirror/feed.ts). feed_state keeps the laptop's lost_txid
 * too, for releases before feed_copies (remove a release later).
 */
export async function pruneStaleFeed(pool: pg.Pool) {
  await pool.query(`
    WITH gone AS (
      DELETE FROM change_log WHERE id IN (
        SELECT id FROM change_log WHERE at < now() - interval '${FEED_KEEP_DAYS} days' LIMIT 50000
      ) RETURNING txid, id
    ),
    copies AS (
      UPDATE feed_copies f SET lost_txid = greatest(f.lost_txid, (
        SELECT max(txid) FROM gone WHERE (gone.txid, gone.id) > (f.ack_txid, f.ack_id)
      ))
    )
    UPDATE feed_state f SET lost_txid = greatest(f.lost_txid, (
      SELECT max(txid) FROM gone WHERE (gone.txid, gone.id) > (f.ack_txid, f.ack_id)
    )) WHERE f.id = 1`);
  await pool.query(`DELETE FROM feed_copies WHERE coalesce(ack_at, '-infinity') < now() - interval '${FEED_KEEP_DAYS} days'`);
}

/** Drops records every read copy has already applied, once they're an hour old. */
export async function pruneReadFeed(pool: pg.Pool) {
  await pool.query(`
    DELETE FROM change_log WHERE id IN (
      SELECT c.id FROM change_log c, (SELECT ack_txid, ack_id FROM feed_copies ORDER BY ack_txid, ack_id LIMIT 1) f
      WHERE (c.txid, c.id) <= (f.ack_txid, f.ack_id) AND c.at < now() - interval '1 hour'
      LIMIT 50000
    )`);
}
