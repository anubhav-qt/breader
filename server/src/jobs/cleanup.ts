import type pg from 'pg';
import { CLEANUP, LIMITS, SYNC } from '@breader/shared';
import type { Storage } from '../lib/storage.ts';
import { log } from '../log.ts';

/*
 * Clean-up (backend design §6 and §7). The worker runs it every hour against Supabase:
 *
 *   tombstones  removed books, 30 days after removal, with their reading places
 *   files       files no book points at (tombstones count), after 7 days; upload links never
 *               finished, after a day; rows of deleted files, after 30 days
 *   libraries   key libraries unused for a year, with their files
 *
 * Each step takes a bounded bite per run, so a backlog clears over a few hours rather than in one
 * long transaction. Locks are taken in the same order a push takes them (the library, then its
 * books and files), so clean-up and pushes wait for each other instead of deadlocking.
 */

/** Any book, removed or not, still points at file b. */
const USED = 'EXISTS (SELECT 1 FROM library_items i WHERE i.file_id = b.id OR i.cover_id = b.id)';
/** Another live row stores its file under b's key (a restore can leave two rows for one object). */
const SHARED = `EXISTS (SELECT 1 FROM blobs o WHERE o.r2_key = b.r2_key AND o.id <> b.id AND o.status <> 'deleted')`;

async function tx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/**
 * Removed books past Undo's reach. A browser that last pulled before a purged tombstone never saw
 * the removal, so the library remembers the highest purged rev, and such a browser is sent the
 * whole library instead (routes/sync.ts).
 */
export async function purgeTombstones(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ library_id: string }>(
    `SELECT DISTINCT library_id FROM library_items WHERE removed_at < now() - make_interval(days => $1) LIMIT 200`,
    [SYNC.tombstoneDays],
  );
  let books = 0;
  for (const { library_id } of rows) {
    books += await tx(pool, async (c) => {
      await c.query('SELECT 1 FROM libraries WHERE id = $1 FOR UPDATE', [library_id]);
      const gone = await c.query<{ book_id: string; rev: number }>(
        `DELETE FROM library_items WHERE library_id = $1 AND removed_at < now() - make_interval(days => $2) RETURNING book_id, rev`,
        [library_id, SYNC.tombstoneDays],
      );
      if (!gone.rows.length) return 0;
      await c.query('DELETE FROM reading_states WHERE library_id = $1 AND book_id = ANY($2)', [library_id, gone.rows.map((g) => g.book_id)]);
      const rev = gone.rows.reduce((m, g) => Math.max(m, g.rev), 0);
      await c.query('UPDATE libraries SET purged_rev = greatest(purged_rev, $2) WHERE id = $1', [library_id, rev]);
      return gone.rows.length;
    });
  }
  return books;
}

/** Files nothing needs any more: deleted from R2, their quota given back. */
export async function cleanFiles(pool: pg.Pool, storage: Storage) {
  // Start the clock on files no book points at, and stop it for ones a book points at again.
  await pool.query(`UPDATE blobs b SET unused_since = now() WHERE status = 'ready' AND unused_since IS NULL AND NOT ${USED}`);
  await pool.query(`UPDATE blobs b SET unused_since = NULL WHERE status = 'ready' AND unused_since IS NOT NULL AND ${USED}`);

  const stale = `((b.status = 'ready' AND b.unused_since < now() - make_interval(days => $1))
    OR (b.status = 'pending' AND b.unused_since < now() - make_interval(days => $2)))`;
  const days = [CLEANUP.unusedFileDays, CLEANUP.pendingUploadDays];
  const { rows } = await pool.query<{ id: string; owner_library_id: string | null }>(
    `SELECT id, owner_library_id FROM blobs b WHERE ${stale} LIMIT 500`,
    days,
  );
  let files = 0;
  let bytes = 0;
  for (const { id, owner_library_id } of rows) {
    await tx(pool, async (c) => {
      if (owner_library_id) await c.query('SELECT 1 FROM libraries WHERE id = $1 FOR UPDATE', [owner_library_id]);
      // Waits for a push that has just checked this file (sync/apply.ts holds a share lock on it)…
      const { rows: [b] } = await c.query<{ status: string; size: number; r2_key: string }>(
        `SELECT status, size, r2_key FROM blobs b WHERE id = $3 AND ${stale} FOR UPDATE`,
        [...days, id],
      );
      if (!b) return;
      // …then looks again, now seeing any book that push pointed at it.
      const { rows: [used] } = await c.query<{ used: boolean }>(`SELECT ${USED} AS used FROM blobs b WHERE id = $1`, [id]);
      if (used.used) {
        await c.query('UPDATE blobs SET unused_since = NULL WHERE id = $1', [id]);
        return;
      }
      // If the row can't be updated, the next run finds the file gone from R2 and tries again.
      const { rows: [shared] } = await c.query<{ shared: boolean }>(`SELECT ${SHARED} AS shared FROM blobs b WHERE id = $1`, [id]);
      if (!shared.shared) await storage.remove(b.r2_key);
      await c.query(`UPDATE blobs SET status = 'deleted', unused_since = now() WHERE id = $1`, [id]);
      if (b.status === 'ready' && owner_library_id) {
        await c.query('UPDATE libraries SET used_bytes = greatest(0, used_bytes - $2) WHERE id = $1', [owner_library_id, b.size]);
        bytes += b.size;
      }
      files++;
    });
  }

  // The laptop's copy has long since removed its own copy of these files.
  const { rowCount } = await pool.query(
    `DELETE FROM blobs b WHERE id IN (
       SELECT id FROM blobs b WHERE status = 'deleted' AND unused_since < now() - make_interval(days => $1) AND NOT ${USED} LIMIT 1000
     )`,
    [CLEANUP.deletedRowDays],
  );
  return { files, bytes, rows: rowCount ?? 0 };
}

/**
 * Key libraries unused for a year (their key's lifetime, §4). The library is retired first, which
 * signs every browser out of it at once; then its files leave R2; then its rows go. A run that
 * stops halfway picks the retired library up again next time.
 */
export async function expireLibraries(pool: pg.Pool, storage: Storage): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE libraries SET retired_at = now()
     WHERE id IN (
       SELECT id FROM libraries
       WHERE owner_account_id IS NULL AND retired_at IS NULL AND last_active_at < now() - make_interval(days => $1)
       LIMIT 50
     ) AND last_active_at < now() - make_interval(days => $1)
     RETURNING id`,
    [LIMITS.key.idleDays],
  );
  const retired = await pool.query<{ id: string }>(`SELECT id FROM libraries WHERE owner_account_id IS NULL AND retired_at IS NOT NULL LIMIT 50`);
  let done = 0;
  for (const { id } of retired.rows) {
    const files = await pool.query<{ r2_key: string }>(
      `SELECT r2_key FROM blobs b WHERE owner_library_id = $1 AND status <> 'deleted' AND NOT ${SHARED}`,
      [id],
    );
    for (const f of files.rows) await storage.remove(f.r2_key);
    await tx(pool, async (c) => {
      await c.query('SELECT 1 FROM libraries WHERE id = $1 FOR UPDATE', [id]);
      await c.query(`UPDATE blobs SET status = 'deleted', unused_since = now() WHERE owner_library_id = $1 AND status <> 'deleted'`, [id]);
      // Books, reading places, settings and sync clients go with it (ON DELETE CASCADE).
      await c.query('DELETE FROM libraries WHERE id = $1', [id]);
    });
    done++;
  }
  if (rows.length) log.info({ retired: rows.length }, 'retired key libraries unused for a year');
  return done;
}

export async function cleanUp(pool: pg.Pool, storage: Storage) {
  const tombstones = await purgeTombstones(pool);
  const files = await cleanFiles(pool, storage);
  const libraries = await expireLibraries(pool, storage);
  const detail = { tombstones, ...files, libraries };
  if (tombstones || files.files || files.rows || libraries) log.info(detail, 'cleaned up');
  return detail;
}
