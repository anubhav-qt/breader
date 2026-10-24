import pg from 'pg';
import { ADMIN_DEFAULTS, LIMITS, MARKER_TASKS, nextFirst, queueKey, type AdminState, type AiAccount, type MarkerTask } from '@breader/shared';
import type { Deps } from '../context.ts';
import { log } from '../log.ts';
import { addCommand, readAdminState } from './admin.ts';
import { cliproxyFor, listAccounts } from './cliproxy.ts';

/*
 * The admin page's live view, pushed as it changes (routes/admin.ts, /admin/stream). One hub per
 * server, running only while a page is open:
 *
 * - Postgres tells it the moment job_runs, admin_state or admin_commands change (migration 0019,
 *   breader_admin), and it reads the jobs, the marker and the settings again. The marker writes
 *   what it's doing as it changes, so the page follows it step by step.
 * - The rest (the databases, the files, the libraries) moves slowly: read every SLOW_MS.
 * - The AI accounts ask every provider for their limits: every ACCOUNTS_MS, and after any change.
 * - The marker is told a page is open every WATCHING_MS, and says what it's doing every second
 *   while it is (ai/tools/control.ts).
 *
 * Without its own connection to listen on, it reads the fast part every FALLBACK_MS instead.
 */

const SLOW_MS = 10_000;
const ACCOUNTS_MS = 60_000;
const WATCHING_MS = 20_000;
const FALLBACK_MS = 3_000;
/** Read the fast part this often even while listening, in case notifications stop without the connection closing. */
const BACKSTOP_MS = 15_000;
const SETTLE_MS = 150;
const AGAIN_MS = 5_000;
/** How long the hub stays up after the last page closes, so a reload finds it warm. */
const LINGER_MS = 30_000;

const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error('timeout')), ms))]);

/** First row of a query, or null when the database doesn't answer in time. */
async function one<T extends pg.QueryResultRow>(pool: pg.Pool, sql: string, params: unknown[] = []): Promise<T | null> {
  try {
    return (await within(pool.query<T>(sql, params), 3000)).rows[0] ?? null;
  } catch {
    return null;
  }
}

async function all<T extends pg.QueryResultRow>(pool: pg.Pool, sql: string): Promise<T[]> {
  try {
    return (await within(pool.query<T>(sql), 3000)).rows;
  } catch {
    return [];
  }
}

interface JobRow {
  name: string;
  last_ok_at: Date | null;
  last_error: string | null;
  last_error_at: Date | null;
  running_since: Date | null;
  detail: unknown;
}

/** What moves slowly: the server, the databases, the files, the libraries. */
export async function slowStatus(deps: Pick<Deps, 'env' | 'pool' | 'mirror'>, startedAt: number) {
  const { env, pool, mirror } = deps;
  const [db, feed, libraries, books, files, meta] = await Promise.all([
    one<{ bytes: number }>(pool, 'SELECT pg_database_size(current_database())::bigint AS bytes'),
    one<{ rows: number; unread: number; oldest_unread: number | null; ack: number | null }>(
      pool,
      `SELECT (SELECT count(*)::int FROM change_log) AS rows,
              (SELECT count(*)::int FROM change_log c WHERE (c.txid, c.id) > (f.ack_txid, f.ack_id)) AS unread,
              (SELECT extract(epoch FROM now() - min(c.at))::int FROM change_log c WHERE (c.txid, c.id) > (f.ack_txid, f.ack_id)) AS oldest_unread,
              extract(epoch FROM now() - f.ack_at)::int AS ack
       FROM feed_state f WHERE f.id = 1`,
    ),
    one<{ total: number; key_only: number; active_week: number; expiring: number; retired: number }>(
      pool,
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE owner_account_id IS NULL)::int AS key_only,
              count(*) FILTER (WHERE last_active_at > now() - interval '7 days')::int AS active_week,
              count(*) FILTER (WHERE owner_account_id IS NULL AND retired_at IS NULL
                               AND last_active_at < now() - make_interval(days => $1))::int AS expiring,
              count(*) FILTER (WHERE retired_at IS NOT NULL)::int AS retired
       FROM libraries`,
      [LIMITS.key.idleDays - 30],
    ),
    one<{ books: number; removed: number }>(
      pool,
      'SELECT count(*) FILTER (WHERE removed_at IS NULL)::int AS books, count(*) FILTER (WHERE removed_at IS NOT NULL)::int AS removed FROM library_items',
    ),
    all<{ status: string; files: number; bytes: number; unused: number }>(
      pool,
      `SELECT status, count(*)::int AS files, coalesce(sum(size), 0)::bigint AS bytes,
              count(*) FILTER (WHERE unused_since IS NOT NULL)::int AS unused
       FROM blobs GROUP BY status ORDER BY status`,
    ),
    one<{ timeline: string }>(pool, 'SELECT timeline FROM sync_meta WHERE id = 1'),
  ]);
  let copy: { lag: number | null; loaded_at: Date | null } | { down: true } | null = null;
  if (mirror) {
    const row = await one<{ lag: number; loaded_at: Date | null }>(
      mirror.pool,
      'SELECT extract(epoch FROM now() - updated_at)::int AS lag, loaded_at FROM mirror_state WHERE id = 1',
    );
    copy = row ?? { down: true };
  }
  return {
    server: { role: env.ROLE, release: env.RELEASE, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000), sentry: !!env.SENTRY_DSN },
    supabase: db && { up: true, bytes: db.bytes, freeBytes: 500 * 1024 * 1024, timeline: meta?.timeline ?? null },
    feed,
    copy,
    libraries,
    books,
    files: { byStatus: files, freeBytes: 10 * 1024 * 1024 * 1024 },
  };
}

export type SlowStatus = Awaited<ReturnType<typeof slowStatus>>;

export async function jobRows(pool: pg.Pool): Promise<JobRow[]> {
  return all<JobRow>(pool, 'SELECT name, last_ok_at, last_error, last_error_at, running_since, detail FROM job_runs ORDER BY name');
}

/** The jobs as the page lists them: running or not, and switched off from it or not. */
export function jobsOf(rows: JobRow[], state: AdminState) {
  return rows.map((j) => ({
    name: j.name,
    last_ok_at: j.last_ok_at,
    last_error: j.last_error,
    last_error_at: j.last_error_at,
    running: !!j.running_since,
    off: state.jobsOff.includes(j.name),
    detail: j.name === 'ai-marker' ? null : j.detail,
  }));
}

interface QueueItem {
  id?: string;
  task: MarkerTask;
  held?: boolean;
}

interface ReaderItem {
  id: string;
  books?: Array<{ id: string }>;
  page?: string | null;
}

/**
 * The marker as it last said (ai/tools/marker.ts, Live), with the page's own settings, which books
 * are kept back, each task's books in the order they go, and each reader's first book as the page
 * picked it, as they are the moment they change.
 */
export function markerOf(rows: JobRow[], state: AdminState) {
  const row = rows.find((j) => j.name === 'ai-marker');
  const d = row?.detail as { working?: unknown; queue?: QueueItem[]; readers?: ReaderItem[] } | null | undefined;
  if (!d || !Array.isArray(d.working)) return null;
  const readers = (d.readers ?? []).map((r) => {
    const pick = state.firstFor[r.id];
    let page: string | null = null;
    if (pick && r.books?.some((b) => b.id === pick)) page = pick;
    return { ...r, page };
  });
  const queue = (d.queue ?? []).map((q) => {
    let held = false;
    if (q.id) held = state.held.includes(queueKey(q.id, q.task));
    return { ...q, held };
  });
  const keyOf = (q: QueueItem) => queueKey(q.id ?? '', q.task);
  const ordered = MARKER_TASKS.flatMap((t) => nextFirst(queue.filter((q) => q.task === t), keyOf, state.next));
  return { ...d, queue: ordered, readers, settings: state.marker };
}

export interface Snapshot {
  status: SlowStatus & { jobs: ReturnType<typeof jobsOf> };
  marker: ReturnType<typeof markerOf>;
  accounts: AiAccount[] | null;
}

/** The accounts in the order the proxy uses them: each kind's highest priority first. */
export function inUseOrder(list: AiAccount[]): AiAccount[] {
  return list.slice().sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.id.localeCompare(b.id);
  });
}

export type Hub = ReturnType<typeof adminHub>;

export function adminHub(deps: Pick<Deps, 'env' | 'pool' | 'mirror'>) {
  const { env, pool } = deps;
  const startedAt = Date.now();
  const proxy = env.ROLE === 'laptop' ? cliproxyFor(env) : null;
  const pages = new Set<(json: string) => void>();
  let slow: SlowStatus | null = null;
  let fast: { jobs: ReturnType<typeof jobsOf>; marker: ReturnType<typeof markerOf> } | null = null;
  let accounts: AiAccount[] | null = null;
  let last = '';
  let up = false;
  let listener: pg.Client | null = null;
  let timers: NodeJS.Timeout[] = [];
  let settle: NodeJS.Timeout | undefined;
  let linger: NodeJS.Timeout | undefined;
  let again: NodeJS.Timeout | undefined;

  const snapshot = (): Snapshot | null => {
    if (!slow || !fast) return null;
    return { status: { ...slow, jobs: fast.jobs }, marker: fast.marker, accounts };
  };

  const send = () => {
    const s = snapshot();
    if (!s) return;
    const json = JSON.stringify(s);
    if (json === last) return;
    last = json;
    for (const page of pages) page(json);
  };

  const readFast = async () => {
    const [rows, state] = await Promise.all([jobRows(pool), readAdminState(pool)]);
    fast = { jobs: jobsOf(rows, state), marker: markerOf(rows, state) };
    send();
  };
  const readSlow = async () => {
    slow = await slowStatus(deps, startedAt);
    send();
  };
  const readAccounts = async () => {
    if (!proxy) return;
    try {
      accounts = inUseOrder(await listAccounts(proxy));
    } catch (err) {
      log.warn({ err }, 'the admin page could not list the AI accounts');
    }
    send();
  };
  const soon = () => {
    clearTimeout(settle);
    settle = setTimeout(() => void readFast().catch((err) => log.warn({ err }, 'admin view read failed')), SETTLE_MS);
  };

  const listen = async () => {
    const client = new pg.Client({
      // The transaction pooler takes LISTEN and then never passes a notification on.
      connectionString: env.PRIMARY_SESSION_URL ?? env.PRIMARY_URL,
      ssl: env.PRIMARY_SSL === 'require' ? { rejectUnauthorized: false } : undefined,
      application_name: 'breader-admin-listen',
    });
    const lost = () => {
      if (listener !== client) return;
      listener = null;
      client.end().catch(() => {});
      if (up) again = setTimeout(() => void listen(), AGAIN_MS);
    };
    client.on('error', lost);
    client.on('end', lost);
    client.on('notification', soon);
    try {
      await client.connect();
      await client.query('LISTEN breader_admin');
      if (!up) {
        await client.end();
        return;
      }
      listener = client;
      soon();
    } catch (err) {
      log.warn({ err }, 'the admin page could not listen for changes; reading them every few seconds instead');
      client.end().catch(() => {});
      if (up) again = setTimeout(() => void listen(), AGAIN_MS);
    }
  };

  const watching = () => {
    addCommand(pool, 'watching').catch(() => {});
  };

  const start = () => {
    up = true;
    void readSlow();
    void readFast().catch(() => {});
    void readAccounts();
    void listen();
    watching();
    timers = [
      setInterval(() => void readSlow(), SLOW_MS),
      setInterval(() => void readAccounts(), ACCOUNTS_MS),
      setInterval(watching, WATCHING_MS),
      setInterval(() => { if (!listener) void readFast().catch(() => {}); }, FALLBACK_MS),
      setInterval(() => void readFast().catch(() => {}), BACKSTOP_MS),
    ];
  };

  const stop = () => {
    up = false;
    for (const t of timers) clearInterval(t);
    timers = [];
    clearTimeout(settle);
    clearTimeout(again);
    const l = listener;
    listener = null;
    l?.end().catch(() => {});
    slow = null;
    fast = null;
    last = '';
  };

  return {
    /** Calls `page` with the view now, when there is one, and every time it changes. Gives back how to stop. */
    watch(page: (json: string) => void): () => void {
      clearTimeout(linger);
      pages.add(page);
      if (!up) start();
      else if (last) page(last);
      return () => {
        pages.delete(page);
        if (pages.size) return;
        clearTimeout(linger);
        linger = setTimeout(() => { if (!pages.size) stop(); }, LINGER_MS);
      };
    },
    /** Read again now: after the page changed something the stream wouldn't hear of by itself. */
    refresh() {
      if (up) soon();
    },
    refreshAccounts() {
      if (up) void readAccounts();
    },
    /** Everything, read now: for /admin/status. */
    async read(): Promise<Snapshot> {
      const [s, rows, state] = await Promise.all([slowStatus(deps, startedAt), jobRows(pool), readAdminState(pool).catch(() => null)]);
      const st = state ?? ADMIN_DEFAULTS;
      return { status: { ...s, jobs: jobsOf(rows, st) }, marker: markerOf(rows, st), accounts };
    },
    close: stop,
  };
}
