import type pg from 'pg';
import { adminStateOf, type AdminState } from '@breader/shared/admin';

/*
 * What the admin page changes and asks for, in Supabase, so every process sees it wherever the
 * page was answered from: the API on either server writes, and the worker and the AI marker read.
 *
 * - admin_state: one row of settings (shared/src/admin.ts), read afresh every few seconds.
 * - admin_commands: things to do once, each taken by the one process that does it. A command
 *   older than COMMAND_TTL_S is let go, so a click while the laptop was off doesn't fire later.
 *
 * The marker imports this too (ai/tools/control.ts), so it reaches only for pg and shared.
 */

const COMMAND_TTL_S = 600;

export async function readAdminState(pool: pg.Pool): Promise<AdminState> {
  const { rows } = await pool.query<{ data: unknown }>('SELECT data FROM admin_state WHERE id = 1');
  return adminStateOf(rows[0]?.data);
}

/** Changes the state in one go, so two changes at once can't undo each other. Returns it changed. */
export async function changeAdminState(pool: pg.Pool, change: (s: AdminState) => AdminState): Promise<AdminState> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO admin_state (id, data) VALUES (1, '{}') ON CONFLICT (id) DO NOTHING`);
    const { rows } = await client.query<{ data: unknown }>('SELECT data FROM admin_state WHERE id = 1 FOR UPDATE');
    const next = change(adminStateOf(rows[0]?.data));
    await client.query('UPDATE admin_state SET data = $1, updated_at = now() WHERE id = 1', [JSON.stringify(next)]);
    await client.query('COMMIT');
    return next;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function addCommand(pool: pg.Pool, kind: string, args: object = {}) {
  await pool.query('INSERT INTO admin_commands (kind, args) VALUES ($1, $2)', [kind, JSON.stringify(args)]);
}

export interface Command {
  id: number;
  kind: string;
  args: Record<string, unknown>;
}

/** Takes the commands of these kinds no one has taken, oldest first, so no other process does them too. */
export async function takeCommands(pool: pg.Pool, kinds: string[]): Promise<Command[]> {
  if (!kinds.length) return [];
  const { rows } = await pool.query<Command>(
    `UPDATE admin_commands SET done_at = now()
     WHERE done_at IS NULL AND kind = ANY($1) AND at > now() - make_interval(secs => $2)
     RETURNING id, kind, args`,
    [kinds, COMMAND_TTL_S],
  );
  // Now and then, the ones done or let go a day ago.
  if (Math.random() < 0.01) await pool.query(`DELETE FROM admin_commands WHERE at < now() - interval '1 day'`).catch(() => {});
  return rows.sort((a, b) => a.id - b.id);
}

/** Says a job is running, or not any more, for the admin page. */
export async function markRunning(pool: pg.Pool, name: string, running: boolean) {
  await pool.query(
    `INSERT INTO job_runs (name, running_since) VALUES ($1, CASE WHEN $2::boolean THEN now() END)
     ON CONFLICT (name) DO UPDATE SET running_since = CASE WHEN $2::boolean THEN now() END`,
    [name, running],
  );
}

/** The worker's jobs the admin page knows, by name, and who runs them. */
export const WORKER_JOBS = ['backup', 'restore-drill', 'clean-up', 'storage-check', 'extensions', 'yt-dlp'] as const;
export const API_JOBS = ['manga-prefetch', 'manga-keep', 'ai-fill'] as const;
export const ADMIN_JOBS: readonly string[] = [...WORKER_JOBS, ...API_JOBS];
/** A job's "run now" command. */
export const runKind = (name: string) => `run:${name}`;

/**
 * Runs a scheduled job unless the admin page switched it off, saying it's running meanwhile.
 * `fn` gives back what to note in job_runs, as the worker's jobs do; this only says when it runs.
 */
export async function asJob<T>(pool: pg.Pool, name: string, fn: () => Promise<T>, o: { evenIfOff?: boolean } = {}): Promise<T | null> {
  if (!o.evenIfOff) {
    const s = await readAdminState(pool).catch(() => null);
    if (s?.jobsOff.includes(name)) return null;
  }
  await markRunning(pool, name, true).catch(() => {});
  try {
    return await fn();
  } finally {
    await markRunning(pool, name, false).catch(() => {});
  }
}
