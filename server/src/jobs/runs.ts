import type pg from 'pg';

/*
 * The worker's jobs note how each run went in job_runs, in Supabase, so the status page on either
 * server can show when each last worked and why it last failed, even while the laptop is off.
 */

export async function recordOk(pool: pg.Pool, name: string, detail: unknown) {
  await pool.query(
    `INSERT INTO job_runs (name, last_ok_at, detail) VALUES ($1, now(), $2)
     ON CONFLICT (name) DO UPDATE SET last_ok_at = now(), detail = EXCLUDED.detail`,
    [name, JSON.stringify(detail ?? null)],
  );
}

export async function recordError(pool: pg.Pool, name: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  await pool.query(
    `INSERT INTO job_runs (name, last_error, last_error_at) VALUES ($1, $2, now())
     ON CONFLICT (name) DO UPDATE SET last_error = EXCLUDED.last_error, last_error_at = now()`,
    [name, message.slice(0, 2000)],
  );
}

/** What a job is doing right now, in its detail, without saying it worked (the AI marker's live view). */
export async function recordLive(pool: pg.Pool, name: string, detail: unknown) {
  await pool.query(
    `INSERT INTO job_runs (name, detail) VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET detail = EXCLUDED.detail`,
    [name, JSON.stringify(detail ?? null)],
  );
}

/** Whether a job last worked more than `days` ago, or never has. */
export async function due(pool: pg.Pool, name: string, days: number): Promise<boolean> {
  const { rows } = await pool.query<{ due: boolean }>(
    `SELECT coalesce(max(last_ok_at) < now() - make_interval(days => $2), true) AS due FROM job_runs WHERE name = $1`,
    [name, days],
  );
  return rows[0].due;
}
