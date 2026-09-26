import type pg from 'pg';
import { FED_TABLES, type FedTable } from '../db/schema.ts';
import { report } from '../lib/report.ts';
import { log } from '../log.ts';

export type Row = Record<string, unknown>;

interface Change {
  id: number;
  txid: number;
  tbl: string;
  pk: Row;
  op: 'I' | 'U' | 'D';
  row: Row | null;
  version: number;
}

const BATCH = 500;
const TABLES = Object.keys(FED_TABLES) as FedTable[];
const XMIN = 'pg_snapshot_xmin(pg_current_snapshot())::text::bigint';

/*
 * Keeps the laptop's Postgres a copy of Supabase (backend design §2). Reads change_log in
 * (txid, id) order, only below the oldest transaction still running, so a record can never
 * appear behind the cursor. Each row carries a version, and the copy only takes a write that is
 * newer than what it has, so replaying a record twice, or out of commit order, is harmless.
 */
export function makeFeed(primary: pg.Pool, mirror: pg.Pool, hooks: { blob?: (row: Row) => void } = {}) {
  const columns = new Map<string, string[]>();

  async function loadColumns() {
    const { rows } = await mirror.query<{ table_name: string; cols: string[] }>(
      `SELECT table_name, array_agg(column_name::text ORDER BY ordinal_position) AS cols
       FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1) GROUP BY table_name`,
      [TABLES],
    );
    for (const r of rows) columns.set(r.table_name, r.cols);
  }

  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const pkOf = (t: FedTable) => FED_TABLES[t] as readonly string[];

  async function applyChange(db: pg.PoolClient, c: Change) {
    if (!(c.tbl in FED_TABLES)) {
      log.warn({ tbl: c.tbl }, 'feed record for a table the copy doesn’t know; skipped');
      return;
    }
    const t = c.tbl as FedTable;
    const pk = pkOf(t).map(q).join(', ');
    if (c.op === 'D') {
      await db.query(
        `DELETE FROM ${q(t)} WHERE (${pk}) = (SELECT ${pk} FROM jsonb_populate_record(NULL::${q(t)}, $1::jsonb)) AND version < $2`,
        [c.pk, c.version],
      );
      await db.query(
        `INSERT INTO mirror_tombstones (tbl, pk, version) VALUES ($1, $2, $3)
         ON CONFLICT (tbl, pk) DO UPDATE SET version = greatest(mirror_tombstones.version, EXCLUDED.version), at = now()`,
        [t, c.pk, c.version],
      );
      return;
    }
    const cols = columns.get(t)!.map(q);
    await db.query(
      `INSERT INTO ${q(t)} SELECT * FROM jsonb_populate_record(NULL::${q(t)}, $1::jsonb)
       WHERE NOT EXISTS (SELECT 1 FROM mirror_tombstones WHERE tbl = $2 AND pk = $3 AND version >= $4)
       ON CONFLICT (${pk}) DO UPDATE SET (${cols.join(', ')}) = ROW(${cols.map((c) => `EXCLUDED.${c}`).join(', ')})
       WHERE ${q(t)}.version < EXCLUDED.version`,
      [c.row, t, c.pk, c.version],
    );
    if (t === 'blobs') hooks.blob?.(c.row!);
  }

  /** Copies every fed table from one Supabase snapshot, then reads the feed from that point. */
  async function reload() {
    log.info('reloading the copy from Supabase');
    const src = await primary.connect();
    const dst = await mirror.connect();
    try {
      await src.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const { rows } = await src.query<{ xmin: number }>(`SELECT ${XMIN} AS xmin`);
      await dst.query('BEGIN');
      // CASCADE reaches sync_clients, which only Supabase uses and is always empty here.
      await dst.query(`TRUNCATE ${TABLES.map(q).join(', ')}, mirror_tombstones CASCADE`);
      let total = 0;
      for (const t of TABLES) {
        await src.query(`DECLARE rows_${t} NO SCROLL CURSOR FOR SELECT to_jsonb(x) AS r FROM ${q(t)} x`);
        for (;;) {
          const page = await src.query<{ r: Row }>(`FETCH 1000 FROM rows_${t}`);
          if (!page.rows.length) break;
          await dst.query(`INSERT INTO ${q(t)} SELECT * FROM jsonb_populate_recordset(NULL::${q(t)}, $1::jsonb)`, [
            JSON.stringify(page.rows.map((p) => p.r)),
          ]);
          total += page.rows.length;
          if (t === 'blobs') page.rows.forEach((p) => hooks.blob?.(p.r));
        }
        await src.query(`CLOSE rows_${t}`);
      }
      await dst.query('UPDATE mirror_state SET cursor_txid = $1, cursor_id = 0, loaded_at = now(), updated_at = now() WHERE id = 1', [rows[0].xmin]);
      await dst.query('COMMIT');
      await src.query('COMMIT');
      log.info({ rows: total }, 'copy reloaded');
    } catch (e) {
      await dst.query('ROLLBACK').catch(() => {});
      await src.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      src.release();
      dst.release();
    }
  }

  let lastAck = 0;

  /** One poll. Returns how many records it applied. */
  async function step(): Promise<number> {
    if (!columns.size) await loadColumns();
    const { rows: st } = await mirror.query<{ cursor_txid: number; cursor_id: number; loaded_at: Date | null }>(
      'SELECT cursor_txid, cursor_id, loaded_at FROM mirror_state WHERE id = 1',
    );
    const cur = st[0];
    const { rows: fs } = await primary.query<{ lost_txid: number }>('SELECT lost_txid FROM feed_state WHERE id = 1');
    // First start, or away so long that unread records were pruned: start from a fresh copy.
    if (!cur.loaded_at || (fs[0].lost_txid > 0 && fs[0].lost_txid >= cur.cursor_txid)) {
      await reload();
      return 1;
    }

    const { rows } = await primary.query<Change>(
      `SELECT id, txid, tbl, pk, op, row, version FROM change_log
       WHERE (txid, id) > ($1, $2) AND txid < ${XMIN} ORDER BY txid, id LIMIT ${BATCH}`,
      [cur.cursor_txid, cur.cursor_id],
    );
    if (!rows.length) {
      await mirror.query('UPDATE mirror_state SET updated_at = now() WHERE id = 1');
      if (Date.now() - lastAck > 5 * 60_000) await ack(cur.cursor_txid, cur.cursor_id);
      return 0;
    }

    const db = await mirror.connect();
    const last = rows[rows.length - 1];
    try {
      await db.query('BEGIN');
      for (const c of rows) await applyChange(db, c);
      await db.query('UPDATE mirror_state SET cursor_txid = $1, cursor_id = $2, updated_at = now() WHERE id = 1', [last.txid, last.id]);
      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      db.release();
    }
    await ack(last.txid, last.id);
    return rows.length;
  }

  /** Tells Supabase how far the copy has read, so read records can be pruned. */
  async function ack(txid: number, id: number) {
    await primary.query('UPDATE feed_state SET ack_txid = $1, ack_id = $2, ack_at = now() WHERE id = 1', [txid, id]);
    lastAck = Date.now();
  }

  /** Polls every 2 s while records arrive, easing off to every 30 s when quiet. */
  async function run(signal: AbortSignal) {
    let delay = 2000;
    while (!signal.aborted) {
      try {
        const n = await step();
        delay = n >= BATCH ? 0 : n > 0 ? 2000 : Math.min(delay * 2, 30_000);
      } catch (err) {
        log.warn({ err }, 'feed step failed; retrying');
        report(err, { job: 'feed' });
        delay = 10_000;
      }
      if (delay) await new Promise((ok) => { const t = setTimeout(ok, delay); signal.addEventListener('abort', () => { clearTimeout(t); ok(null); }, { once: true }); });
    }
  }

  return { step, run, reload };
}
