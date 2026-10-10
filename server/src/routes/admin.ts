import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import type pg from 'pg';
import { z } from 'zod';
import { ACCOUNT_KINDS, LIMITS } from '@breader/shared';
import type { AppEnv, Deps } from '../context.ts';
import { cancelSignIn, cliproxyFor, finishSignIn, listAccounts, removeAccount, signInStatus, startSignIn, type Cliproxy } from '../lib/cliproxy.ts';
import { ApiError, parse, readJson } from '../lib/errors.ts';
import { rateLimit } from '../lib/http.ts';
import { adminPage } from './admin-page.ts';

const ConnectRequest = z.object({ kind: z.enum(ACCOUNT_KINDS) });
const State = z.string().min(1).max(200);
const FinishRequest = z.object({ state: State, redirectUrl: z.string().min(1).max(4000) });
const CancelRequest = z.object({ state: State });

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

/*
 * The status page (backend design §12): which server answers, how current the laptop's copy is,
 * how full Supabase and R2 are, and how the worker's jobs went. Both servers serve it, at
 * api.…/admin and fb.…/admin, behind ADMIN_TOKEN. Without the token set, neither path exists.
 * Accounts with an admin role replace the token in Phase 2.
 *
 * On the laptop it also connects the AI accounts the marker's research and music run on
 * (lib/cliproxy.ts): Antigravity, Claude Code and Codex, each with its limits.
 */
export function adminRoutes(deps: Deps) {
  const { env, pool, mirror } = deps;
  const r = new Hono<AppEnv>();
  if (!env.ADMIN_TOKEN) return r;
  const token = Buffer.from(env.ADMIN_TOKEN);
  const started = Date.now();

  const checkToken = (c: Context<AppEnv>) => {
    const given = Buffer.from((c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, ''));
    if (given.length !== token.length || !timingSafeEqual(given, token)) {
      throw new ApiError(401, 'not_admin', 'That isn’t the admin token.');
    }
    c.header('Cache-Control', 'no-store');
  };

  r.get('/admin', (c) => {
    const nonce = randomBytes(16).toString('base64');
    c.header('Cache-Control', 'no-store');
    c.header('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    c.header('Referrer-Policy', 'no-referrer');
    return c.html(adminPage(nonce));
  });

  r.get('/admin/status', rateLimit({ name: 'admin', max: 30, windowMs: 60_000 }), async (c) => {
    checkToken(c);

    const [db, feed, libraries, books, files, jobs, meta] = await Promise.all([
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
      all<{ name: string; last_ok_at: Date | null; last_error: string | null; last_error_at: Date | null; detail: unknown }>(
        pool,
        'SELECT name, last_ok_at, last_error, last_error_at, detail FROM job_runs ORDER BY name',
      ),
      one<{ timeline: string }>(pool, 'SELECT timeline FROM sync_meta WHERE id = 1'),
    ]);
    const copy = mirror
      ? await one<{ lag: number; loaded_at: Date | null }>(
          mirror.pool,
          'SELECT extract(epoch FROM now() - updated_at)::int AS lag, loaded_at FROM mirror_state WHERE id = 1',
        )
      : null;

    return c.json({
      server: { role: env.ROLE, release: env.RELEASE, uptimeSeconds: Math.round((Date.now() - started) / 1000), sentry: !!env.SENTRY_DSN },
      request: {
        ip: c.var.ip,
        from: env.CLIENT_IP_HEADER,
        headers: Object.fromEntries(
          ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip', 'true-client-ip'].flatMap((h) => {
            const v = c.req.header(h);
            return v ? [[h, v]] : [];
          }),
        ),
      },
      supabase: db && { up: true, bytes: db.bytes, freeBytes: 500 * 1024 * 1024, timeline: meta?.timeline ?? null },
      feed,
      copy: mirror ? copy ?? { down: true } : null,
      libraries,
      books,
      files: { byStatus: files, freeBytes: 10 * 1024 * 1024 * 1024 },
      jobs,
    });
  });

  // The AI accounts: only the laptop runs the proxy (in its worker).
  const accounts = rateLimit({ name: 'admin-accounts', max: 120, windowMs: 60_000 });
  const proxy = (c: Context<AppEnv>): Cliproxy => {
    checkToken(c);
    const p = cliproxyFor(env);
    if (!p || env.ROLE !== 'laptop') throw new ApiError(404, 'no_proxy', 'AI accounts are on the laptop’s status page only.');
    return p;
  };

  r.get('/admin/accounts', accounts, async (c) => {
    const p = proxy(c);
    return c.json({ accounts: await listAccounts(p) });
  });

  r.post('/admin/accounts/connect', accounts, async (c) => {
    const p = proxy(c);
    const body = parse(ConnectRequest, await readJson(c));
    return c.json(await startSignIn(p, body.kind));
  });

  r.post('/admin/accounts/finish', accounts, async (c) => {
    const p = proxy(c);
    const body = parse(FinishRequest, await readJson(c));
    await finishSignIn(p, body.state, body.redirectUrl.trim());
    return c.json({ ok: true });
  });

  r.get('/admin/accounts/status', accounts, async (c) => {
    const p = proxy(c);
    const state = parse(State, c.req.query('state'));
    return c.json(await signInStatus(p, state));
  });

  r.post('/admin/accounts/cancel', accounts, async (c) => {
    const p = proxy(c);
    const body = parse(CancelRequest, await readJson(c));
    await cancelSignIn(p, body.state);
    return c.json({ ok: true });
  });

  r.delete('/admin/accounts/:id', accounts, async (c) => {
    const p = proxy(c);
    const id = parse(z.string().min(1).max(300), c.req.param('id'));
    await removeAccount(p, id);
    return c.json({ ok: true });
  });

  return r;
}
