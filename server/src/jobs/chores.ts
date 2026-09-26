import type pg from 'pg';

/** How long feed records wait for a laptop that's away before they're dropped. */
export const FEED_KEEP_DAYS = 14;

/**
 * Drops feed records older than two weeks. If any of them were still unread by the laptop, their
 * newest txid is remembered in feed_state.lost_txid, and the worker reloads everything on return.
 */
export async function pruneStaleFeed(pool: pg.Pool) {
  await pool.query(`
    WITH gone AS (
      DELETE FROM change_log WHERE id IN (
        SELECT id FROM change_log WHERE at < now() - interval '${FEED_KEEP_DAYS} days' LIMIT 50000
      ) RETURNING txid, id
    )
    UPDATE feed_state f SET lost_txid = greatest(f.lost_txid, (
      SELECT max(txid) FROM gone WHERE (gone.txid, gone.id) > (f.ack_txid, f.ack_id)
    )) WHERE f.id = 1`);
}

/** Drops records the laptop has already applied, once they're an hour old. */
export async function pruneReadFeed(pool: pg.Pool) {
  await pool.query(`
    DELETE FROM change_log WHERE id IN (
      SELECT c.id FROM change_log c, feed_state f
      WHERE f.id = 1 AND (c.txid, c.id) <= (f.ack_txid, f.ack_id) AND c.at < now() - interval '1 hour'
      LIMIT 50000
    )`);
}
