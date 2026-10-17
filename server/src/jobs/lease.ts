import type pg from 'pg';

/** How long a hold lasts when its machine stops renewing it (it renews every 30 s). */
const HOLD_SECONDS = 120;

/**
 * The laptop and the backup both run the whole stack, but only one worker at a time does the jobs
 * that must happen once. This takes them for this machine, or keeps them, unless another machine
 * holds them and renewed lately. Whoever has them keeps them while it runs. True when this one has them.
 */
export async function holdLease(pool: pg.Pool, machine: string): Promise<boolean> {
  const { rows } = await pool.query(
    `INSERT INTO worker_lease (id, holder, until) VALUES (1, $1, now() + make_interval(secs => $2))
     ON CONFLICT (id) DO UPDATE SET holder = EXCLUDED.holder, until = EXCLUDED.until
     WHERE worker_lease.holder = EXCLUDED.holder OR worker_lease.until < now()
     RETURNING holder`,
    [machine, HOLD_SECONDS],
  );
  return rows.length > 0;
}
