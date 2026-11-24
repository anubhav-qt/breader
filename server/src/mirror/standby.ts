import type pg from 'pg';
import { pruneReadFeed } from '../jobs/chores.ts';
import { holdLease } from '../jobs/lease.ts';
import { log } from '../log.ts';
import { runCopy, type Copy } from './copy.ts';

/*
 * The standby (ADR 0004): a worker on another machine (GCP) that keeps every read copy current
 * while the ThinkPad is quiet. The ThinkPad's worker says it's up every 30 s (worker_seen) and,
 * holding the lease (jobs/lease.ts), feeds every copy itself. When it goes quiet and its lease runs
 * out, the standby takes the lease and feeds them; when the ThinkPad is heard from again, the
 * standby lets the lease go at once, and the ThinkPad takes it on its next check. Each copy still
 * has one feeder at a time (its feed lock, mirror/copy.ts).
 */

/** Heard from within this long: the machine is up. Its worker says so every 30 s. */
const SEEN_WITHIN_SECONDS = 90;
/** How often the standby prunes feed records every copy has read, as the ThinkPad's worker does. */
const PRUNE_EVERY = 10 * 60_000;

/** Notes that this machine's worker is up (every lease check). */
export async function sayUp(pool: Pick<pg.Pool, 'query'>, machine: string) {
  await pool.query(
    `INSERT INTO worker_seen (machine, at) VALUES ($1, now()) ON CONFLICT (machine) DO UPDATE SET at = now()`,
    [machine],
  );
}

/** Whether `machine`'s worker was heard from lately. */
export async function heardFrom(pool: Pick<pg.Pool, 'query'>, machine: string, withinSeconds = SEEN_WITHIN_SECONDS): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM worker_seen WHERE machine = $1 AND at > now() - make_interval(secs => $2)`,
    [machine, withinSeconds],
  );
  return rows.length > 0;
}

/** Lets this machine's lease go now, so another machine may take it on its next check. */
export async function letLeaseGo(pool: Pick<pg.Pool, 'query'>, machine: string) {
  await pool.query(`UPDATE worker_lease SET until = now() - interval '1 second' WHERE id = 1 AND holder = $1`, [machine]);
}

/** Feeds every copy until `signal` aborts (the ThinkPad's worker while it leads, or the standby). */
export function feedEvery(primary: pg.Pool, copies: Copy[], folder: string, signal: AbortSignal): Promise<void> {
  return Promise.all(copies.map((c) => runCopy(primary, c, folder, signal))).then(() => undefined);
}

export interface StandbyOptions {
  primary: pg.Pool;
  /** This machine's name, as it holds the lease. */
  machine: string;
  /** The machine it stands in for. */
  standsFor: string;
  /** Feeds every copy until the signal aborts; feedEvery in production. */
  feed: (signal: AbortSignal) => Promise<void>;
  /** True when this machine mustn't stand in, whatever else: near its egress limit. */
  held?: () => Promise<boolean>;
  /** How long the other machine counts as up after it was heard from; tests make it short. */
  seenWithinSeconds?: number;
}

export type StandbyState = 'standing in' | 'standing by';

export function makeStandby(opts: StandbyOptions) {
  const { primary, machine, standsFor } = opts;
  let feeding: { stop: AbortController; done: Promise<void> } | null = null;
  let prunedAt = 0;

  function start() {
    if (feeding) return;
    log.info({ machine, for: standsFor }, 'standing in: feeding every read copy');
    const stop = new AbortController();
    const done = opts.feed(stop.signal).catch((err) => log.warn({ err }, 'the standby’s feed stopped'));
    feeding = { stop, done };
  }

  async function stopFeeding() {
    if (!feeding) return;
    const f = feeding;
    feeding = null;
    f.stop.abort();
    await f.done;
    log.info({ machine, for: standsFor }, 'standing by again');
  }

  async function standBy(): Promise<StandbyState> {
    await stopFeeding();
    await letLeaseGo(primary, machine);
    return 'standing by';
  }

  return {
    /** One check, every 30 s: stands in, keeps standing in, or hands back. */
    async check(): Promise<StandbyState> {
      if (opts.held && (await opts.held())) return standBy();
      if (await heardFrom(primary, standsFor, opts.seenWithinSeconds)) return standBy();
      if (!(await holdLease(primary, machine))) {
        await stopFeeding();
        return 'standing by';
      }
      start();
      if (Date.now() - prunedAt >= PRUNE_EVERY) {
        prunedAt = Date.now();
        await pruneReadFeed(primary).catch((err) => log.warn({ err }, 'feed prune failed'));
      }
      return 'standing in';
    },

    /** Stops feeding and lets the lease go: the process is stopping. */
    stop: standBy,

    feeding: () => feeding !== null,
  };
}
