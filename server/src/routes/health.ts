import { Hono } from 'hono';
import type { AppEnv, Deps } from '../context.ts';

const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error('timeout')), ms))]);

export function healthRoutes(deps: Deps) {
  const { env, pool, mirror, engine, egress, busy } = deps;
  const r = new Hono<AppEnv>();

  /**
   * Liveness, with no database call: the app probes this to decide whether to fail back. On the
   * laptop, how busy its engines are (ADR 0002): engines up, workers busy of all, jobs waiting, short of memory.
   * Where set, the busy sign (lib/busy.ts) and this month's egress (lib/egress.ts): the app chooses
   * another server while either says so.
   */
  r.get('/health', (c) => {
    const s = engine?.stats();
    const up = s?.engines.filter((e) => e.up) ?? [];
    const engineBusy = s && {
      up: up.length,
      workers: up.reduce((n, e) => n + e.workers, 0),
      busy: up.reduce((n, e) => n + e.busy, 0),
      waiting: s.waiting.live + s.waiting.panel,
      low: !!engine?.short,
    };
    const out: Record<string, unknown> = { ok: true, role: env.ROLE, release: env.RELEASE };
    if (engineBusy) out.engine = engineBusy;
    if (busy?.()) out.busy = true;
    if (egress) out.egress = { usedMb: egress.usedMb(), limitMb: egress.limitMb, near: egress.near() };
    return c.json(out);
  });

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
