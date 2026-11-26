import type pg from 'pg';
import type { CopySeen, Infra, Reach, ServerSeen } from '@breader/shared/infra';
import type { SeenDetail, Watch } from './seen.ts';

/*
 * The admin page's infra map (frontend src/admin/Infra.tsx): every API server as it last said how
 * it was (server_seen, lib/seen.ts), each read copy's place in the feed (feed_copies), and the
 * pool's home bucket, R2 (pool_chapters, pool_buckets). Read from Supabase, so any server tells it
 * the same, and nobody wakes a standby to ask.
 *
 * Which box a server is: the ThinkPad by its MACHINE (STANDBY_FOR), GCP by sending JSON alone,
 * and any other fallback is Azure.
 */

/** A server heard from within this long is up; most say how they are every 30 s. */
export const FRESH_S = 90;
/** A server that says how it is less often may be quiet this many of its own turns. */
const TURNS = 3;
/** The AWS watcher asks each minute: past this, its last ask says nothing about now. */
const WATCH_FRESH_S = 180;
/** The ThinkPad's misses in a row after which the watcher keeps Azure awake (infra/aws/watch.sh). */
const WAKE_AFTER = 10;
/** Home quiet this long: the watcher has asked Azure to wake by now, heard or not (its asks, a minute apart, and Azure's start). */
const HOME_GONE_S = (WAKE_AFTER + 3) * 60;

/** A server_seen row, its age by Supabase's clock. */
export interface SeenRow {
  machine: string;
  role: string;
  release: string;
  ageS: number;
  startedAt: Date;
  detail: SeenDetail;
}

/** A feed_copies row: its name, when it last read (null: never), and the age of the oldest change it hasn't (null: none). */
export interface CopyRow {
  name: string;
  ackAgeS: number | null;
  oldestUnreadS: number | null;
}

/** The pool's home bucket: its room and limits (POOL_<NAME>_*), what it holds and this month's writes. */
export interface BucketRow {
  budget: number;
  writeLimit: number | null;
  bytes: number;
  writes: number;
}

export interface InfraInput {
  /** The ThinkPad's MACHINE. */
  home: string;
  seen: SeenRow[];
  copies: CopyRow[];
  r2: BucketRow | null;
  now: Date;
}

type Slot = 'home' | 'gcp' | 'azure';

function slotOf(row: SeenRow, home: string): Slot | null {
  if (row.machine === home) return 'home';
  if (row.detail.jsonOnly) return 'gcp';
  if (row.role === 'fallback') return 'azure';
  return null;
}

/** The newest row in each box: a server that moved machines leaves an older one behind. */
function newestBySlot(rows: SeenRow[], home: string): Map<Slot, SeenRow> {
  const out = new Map<Slot, SeenRow>();
  for (const row of rows) {
    const slot = slotOf(row, home);
    if (!slot) continue;
    const had = out.get(slot);
    if (!had || row.ageS < had.ageS) out.set(slot, row);
  }
  return out;
}

/** The watcher's newest ask, heard by any server. */
function newestWatch(rows: SeenRow[]): { lastAsked: string; missed: number } | null {
  let best: Watch | null = null;
  for (const row of rows) {
    const w = row.detail.watch;
    if (!w) continue;
    if (!best || new Date(w.at) > new Date(best.at)) best = w;
  }
  if (!best) return null;
  return { lastAsked: best.at, missed: best.missed };
}

/** How long a server may be quiet and still be up: FRESH_S, or 3 of its own turns when it says less often. */
function freshFor(row: SeenRow): number {
  const every = row.detail.everyS;
  if (!every) return FRESH_S;
  return Math.max(FRESH_S, every * TURNS);
}

const isoAgo = (now: Date, seconds: number) => new Date(now.getTime() - seconds * 1000).toISOString();

function serverFrom(row: SeenRow | undefined, slot: Slot, azureWanted: boolean, now: Date): ServerSeen | null {
  if (!row) return null;
  const out: ServerSeen = { state: 'up', release: row.release, heardAt: isoAgo(now, row.ageS) };
  if (row.ageS > freshFor(row)) {
    out.state = staleState(slot, azureWanted);
    return out;
  }
  if (row.detail.busy) out.state = 'busy';
  out.startedAt = row.startedAt.toISOString();
  const e = row.detail.engine;
  if (e && slot === 'home') out.engine = { up: e.up, workers: e.workers, busy: e.busy, waiting: e.waiting };
  if (row.detail.egress) out.egress = row.detail.egress;
  return out;
}

/** Quiet too long: down, except Azure, asleep unless the watcher is keeping it awake. */
function staleState(slot: Slot, azureWanted: boolean): Reach {
  if (slot !== 'azure') return 'down';
  if (azureWanted) return 'down';
  return 'asleep';
}

function copiesFrom(rows: CopyRow[], bySlot: Map<Slot, SeenRow>): CopySeen[] {
  const owner = new Map<string, CopySeen['where']>();
  for (const [slot, row] of bySlot) {
    if (row.detail.copy) owner.set(row.detail.copy, slot);
  }
  return rows.map((c) => {
    let behind: number | null = null;
    if (c.ackAgeS !== null) behind = c.oldestUnreadS ?? 0;
    return { name: c.name, where: owner.get(c.name) ?? 'other', behind };
  });
}

/**
 * Whether Azure should be awake: the watcher said lately it has missed home long enough, or home
 * has been quiet so long that the watcher must have asked (a woken Azure that never answers can't
 * say it heard it).
 */
function wantsAzure(watcher: Infra['watcher'], home: SeenRow | undefined, now: Date): boolean {
  if (watcher) {
    const age = (now.getTime() - new Date(watcher.lastAsked).getTime()) / 1000;
    if (age <= WATCH_FRESH_S && watcher.missed >= WAKE_AFTER) return true;
  }
  if (home && home.ageS > HOME_GONE_S) return true;
  return false;
}

/** What the page's infra map shows, from what Supabase holds. */
export function infraFrom(input: InfraInput): Infra {
  const { now } = input;
  const bySlot = newestBySlot(input.seen, input.home);
  const watcher = newestWatch(input.seen);
  const azureWanted = wantsAzure(watcher, bySlot.get('home'), now);

  const azureRow = bySlot.get('azure');
  let modal: Infra['modal'] = null;
  if (azureRow) {
    const e = azureRow.detail.engine;
    if (azureRow.ageS <= freshFor(azureRow) && e) modal = { up: e.up > 0, done: e.done };
    else modal = { up: false, done: 0 };
  }

  let r2: Infra['r2'] = null;
  if (input.r2) r2 = { bytes: input.r2.bytes, limitBytes: input.r2.budget, writes: input.r2.writes, writeLimit: input.r2.writeLimit };

  return {
    at: now.toISOString(),
    servers: {
      home: serverFrom(bySlot.get('home'), 'home', azureWanted, now),
      gcp: serverFrom(bySlot.get('gcp'), 'gcp', azureWanted, now),
      azure: serverFrom(azureRow, 'azure', azureWanted, now),
    },
    copies: copiesFrom(input.copies, bySlot),
    r2,
    watcher,
    modal,
  };
}

/** The pool's home bucket, as its env names it. */
export interface HomeBucket {
  name: string;
  budget: number;
  writes: number | null;
}

/** Reads what the map needs from Supabase, and puts it together. */
export async function readInfra(pool: Pick<pg.Pool, 'query'>, home: string, bucket: HomeBucket | null): Promise<Infra> {
  const [seen, copies, now] = await Promise.all([
    pool.query<{ machine: string; role: string; release: string; age_s: number; started_at: Date; detail: SeenDetail }>(
      `SELECT machine, role, release, extract(epoch FROM now() - at)::int AS age_s, started_at, detail FROM server_seen`,
    ),
    pool.query<{ name: string; ack_age_s: number | null; oldest_unread_s: number | null }>(
      `SELECT f.name,
              extract(epoch FROM now() - f.ack_at)::int AS ack_age_s,
              (SELECT extract(epoch FROM now() - min(c.at))::int FROM change_log c WHERE (c.txid, c.id) > (f.ack_txid, f.ack_id)) AS oldest_unread_s
       FROM feed_copies f ORDER BY f.name`,
    ),
    pool.query<{ now: Date }>('SELECT now() AS now'),
  ]);
  let r2: BucketRow | null = null;
  if (bucket) r2 = await readBucket(pool, bucket);
  return infraFrom({
    home,
    now: now.rows[0].now,
    seen: seen.rows.map((r) => ({ machine: r.machine, role: r.role, release: r.release, ageS: r.age_s, startedAt: r.started_at, detail: r.detail })),
    copies: copies.rows.map((r) => ({ name: r.name, ackAgeS: r.ack_age_s, oldestUnreadS: r.oldest_unread_s })),
    r2,
  });
}

async function readBucket(pool: Pick<pg.Pool, 'query'>, bucket: HomeBucket): Promise<BucketRow> {
  const { rows } = await pool.query<{ held: number; others: number | null; writes: number | null }>(
    `SELECT (SELECT coalesce(sum(bytes), 0)::bigint FROM pool_chapters WHERE bucket = $1) AS held,
            b.others,
            CASE WHEN b.month = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM') THEN b.writes ELSE 0 END AS writes
     FROM (SELECT 1) one LEFT JOIN pool_buckets b ON b.name = $1`,
    [bucket.name],
  );
  const row = rows[0];
  return {
    budget: bucket.budget,
    writeLimit: bucket.writes,
    bytes: Number(row.held) + Number(row.others ?? 0),
    writes: row.writes ?? 0,
  };
}
