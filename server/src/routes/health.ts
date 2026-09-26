import { Hono } from 'hono';
import type { AppEnv, Deps } from '../context.ts';

const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error('timeout')), ms))]);

export function healthRoutes(deps: Deps) {
  const { env, pool, mirror } = deps;
  const r = new Hono<AppEnv>();

  /** Liveness, with no database call: the app probes this to decide whether to fail back. */
  r.get('/health', (c) => c.json({ ok: true, role: env.ROLE, release: env.RELEASE }));

  /** For monitors: Supabase reachable, and how current the laptop's copy is. */
  r.get('/ready', async (c) => {
    const out: Record<string, unknown> = { role: env.ROLE, release: env.RELEASE };
    let ok = true;
    try {
      const { rows } = await within(pool.query<{ ack: number | null }>('select extract(epoch from now() - ack_at)::int as ack from feed_state where id = 1'), 2000);
      out.primary = 'up';
      out.mirrorAckSecondsAgo = rows[0]?.ack ?? null;
    } catch {
      ok = false;
      out.primary = 'down';
    }
    if (mirror) {
      try {
        const { rows } = await within(mirror.pool.query<{ lag: number }>('select extract(epoch from now() - updated_at)::int as lag from mirror_state where id = 1'), 2000);
        out.mirror = { lagSeconds: rows[0]?.lag ?? null };
      } catch {
        out.mirror = 'down';
      }
    }
    return c.json({ ok, ...out }, ok ? 200 : 503);
  });

  return r;
}
