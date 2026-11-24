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
/** While records arrive, the feed looks again this soon; once quiet, it waits longer each time, up to QUIET. */
const QUICK = 2000;
const QUIET = 30_000;
const TABLES = Object.keys(FED_TABLES) as FedTable[];
/** The fed tables a copy was loaded with (mirror_state.fed): when it differs, the copy loads afresh. */
export const FED = TABLES.join(',');
const XMIN = 'pg_snapshot_xmin(pg_current_snapshot())::text::bigint';

/*
 * Keeps a read copy of the primary current: the laptop's Postgres (backend design §2), or any
 * server's COPY_URL, any Postgres anywhere (ADR 0001, point 5, mirror/copy.ts). Reads change_log in (txid, id) order, only below the oldest
 * transaction still running, so a record can never appear behind the cursor. Each row carries a
 * version, and the copy only takes a write that is newer than what it has, so replaying a record
 * twice, or out of commit order, is harmless. Each copy keeps its own place in feed_copies, by name,
 * and the feed is pruned only up to the slowest (jobs/chores.ts).
 */
export interface FeedHooks {
  /** This copy's name in feed_copies: `laptop`, or a server's COPY_NAME (mirror/copy.ts). */
  name?: string;
  blob?: (row: Row) => void;
  /**
   * Whether this machine tells Supabase how far it has read. Where the laptop and the backup both
   * run, only the one doing the once-only jobs does (jobs/lease.ts), as those include pruning.
   */
  acks?: () => boolean;
}

/**
 * How long the feed waits after a step that copied `copied` records, the last wait having been
 * `last`: not at all after a full batch, as more are waiting; QUICK after some; and when there
 * were none, twice as long as before, from QUICK up to QUIET. Never 0 when quiet, even straight
 * after a full batch, or the feed would ask Supabase again and again with no pause.
 */
export function waitAfter(copied: number, last: number): number {
  if (copied >= BATCH) return 0;
  if (copied > 0) return QUICK;
  const before = Math.max(last, QUICK);
  return Math.min(before * 2, QUIET);
}

/** Whether a database error is a foreign key the copy's rows broke (Postgres code 23503). */
export function brokeKey(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  return (err as { code?: unknown }).code === '23503';
}

export function makeFeed(primary: pg.Pool, mirror: pg.Pool, hooks: FeedHooks = {}) {
  const columns = new Map<string, string[]>();
  const name = hooks.name ?? 'laptop';
  const acks = () => !hooks.acks || hooks.acks();

  /**
   * Opens a transaction on the copy in which the rows go in exactly as Supabase wrote them: the
   * triggers stand aside (0031_copies.sql), on a copy that can't switch them off by itself.
   */
  async function replaying(db: pg.PoolClient) {
    await db.query('BEGIN');
    await db.query("SET LOCAL breader.replay = 'on'");
  }

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
      // From here on, the feed is kept for this copy from where its snapshot starts.
      if (acks()) {
        await primary.query(
          `INSERT INTO feed_copies (name, ack_txid, ack_id, ack_at) VALUES ($1, $2, 0, now())
           ON CONFLICT (name) DO UPDATE SET ack_txid = $2, ack_id = 0, ack_at = now(), lost_txid = 0`,
          [name, rows[0].xmin],
        );
      }
      await replaying(dst);
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
      await dst.query('UPDATE mirror_state SET cursor_txid = $1, cursor_id = 0, loaded_at = now(), updated_at = now(), fed = $2 WHERE id = 1', [rows[0].xmin, FED]);
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
    const { rows: st } = await mirror.query<{ cursor_txid: number; cursor_id: number; loaded_at: Date | null; away: boolean; fed: string | null }>(
      `SELECT cursor_txid, cursor_id, loaded_at, updated_at < now() - interval '50 minutes' AS away, fed FROM mirror_state WHERE id = 1`,
    );
    const cur = st[0];
    const { rows: fs } = await primary.query<{ lost_txid: number }>('SELECT lost_txid FROM feed_copies WHERE name = $1', [name]);
    // First start, a table newly fed, or away so long that unread records were pruned: start from a
    // fresh copy. Also after nearly an hour away, when the other machine may have pruned records it
    // read and this one hadn't (pruneReadFeed keeps them an hour). A copy with no place kept was
    // unheard of for as long as the feed is kept, so it may have missed some too; only a copy that
    // keeps its own place can tell.
    let lost = false;
    if (fs[0]) lost = fs[0].lost_txid > 0 && fs[0].lost_txid >= cur.cursor_txid;
    else lost = acks();
    if (!cur.loaded_at || cur.away || cur.fed !== FED || lost) {
      await reload();
      return 1;
    }

    // The records past the cursor, and Supabase's time as it read them. Only those below the oldest
    // transaction still running are copied (ready); they all come before the rest, in this order.
    const { rows: [next] } = await primary.query<{ at: Date; rows: Array<Change & { ready: boolean }> }>(
      `WITH next AS (
         SELECT id, txid, tbl, pk, op, row, version, txid < ${XMIN} AS ready FROM change_log
         WHERE (txid, id) > ($1, $2) ORDER BY txid, id LIMIT ${BATCH}
       )
       SELECT statement_timestamp() AS at, coalesce(jsonb_agg(next ORDER BY txid, id), '[]') AS rows FROM next`,
      [cur.cursor_txid, cur.cursor_id],
    );
    const rows = next.rows.filter((c) => c.ready);
    // Nothing left behind: once these are in, the copy has every write made before `at`.
    let caughtUpAt: Date | null = null;
    if (rows.length === next.rows.length && rows.length < BATCH) caughtUpAt = next.at;

    if (!rows.length) {
      await mirror.query('UPDATE mirror_state SET updated_at = now(), caught_up_at = coalesce($1, caught_up_at) WHERE id = 1', [caughtUpAt]);
      if (Date.now() - lastAck > 5 * 60_000) await ack(cur.cursor_txid, cur.cursor_id);
      return 0;
    }

    const last = rows[rows.length - 1];
    try {
      await applyBatch(rows, last, caughtUpAt);
    } catch (err) {
      if (!brokeKey(err)) throw err;
      // A copy whose foreign keys are on checks them as each batch ends (mirror/copy.ts, deferKeys).
      // A child can still come a batch before its parent: records are in transaction id order, not
      // commit order. A fresh copy has both, so the feed doesn't stick on that batch for good.
      log.warn({ err, copy: name }, 'a batch broke a foreign key on the read copy; loading it afresh');
      await reload();
      return 1;
    }
    await ack(last.txid, last.id);
    return rows.length;
  }

  /** The batch's records and the cursor past them, in one transaction on the copy. */
  async function applyBatch(rows: Change[], last: Change, caughtUpAt: Date | null) {
    const db = await mirror.connect();
    try {
      await replaying(db);
      for (const c of rows) await applyChange(db, c);
      await db.query(
        'UPDATE mirror_state SET cursor_txid = $1, cursor_id = $2, updated_at = now(), caught_up_at = coalesce($3, caught_up_at) WHERE id = 1',
        [last.txid, last.id, caughtUpAt],
      );
      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      db.release();
    }
  }

  /**
   * Tells Supabase how far the copy has read, so read records can be pruned. Only a copy whose
   * place is still kept: one dropped meanwhile finds that out on its next step and reloads. The
   * laptop's goes in feed_state too, for releases before feed_copies (remove a release later).
   */
  async function ack(txid: number, id: number) {
    if (!acks()) return;
    await primary.query('UPDATE feed_copies SET ack_txid = $2, ack_id = $3, ack_at = now() WHERE name = $1', [name, txid, id]);
    if (name === 'laptop') await primary.query('UPDATE feed_state SET ack_txid = $1, ack_id = $2, ack_at = now() WHERE id = 1', [txid, id]);
    lastAck = Date.now();
  }

  /** Polls every 2 s while records arrive, easing off to every 30 s when quiet. */
  async function run(signal: AbortSignal) {
    let delay = QUICK;
    while (!signal.aborted) {
      try {
        const n = await step();
        delay = waitAfter(n, delay);
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
