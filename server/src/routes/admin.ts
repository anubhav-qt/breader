import { timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { ACCOUNT_KINDS, FirstAction, MarkerPatch, MusicImport, QueueAction, StagesAction, musicImportKey, musicImportProblems, queueKey, withStages } from '@breader/shared';
import type { AppEnv, Deps } from '../context.ts';
import { ADMIN_JOBS, addCommand, changeAdminState, runKind } from '../lib/admin.ts';
import { adminHub, inUseOrder } from '../lib/admin-live.ts';
import { cancelSignIn, cliproxyFor, finishSignIn, listAccounts, putFirst, removeAccount, signInStatus, startSignIn, type Cliproxy } from '../lib/cliproxy.ts';
import { ApiError, parse, readJson } from '../lib/errors.ts';
import { rateLimit } from '../lib/http.ts';

const ConnectRequest = z.object({ kind: z.enum(ACCOUNT_KINDS) });
const State = z.string().min(1).max(200);
const FinishRequest = z.object({ state: State, redirectUrl: z.string().min(1).max(4000) });
const CancelRequest = z.object({ state: State });
const JobName = z.string().refine((n) => ADMIN_JOBS.includes(n), 'No such job.');
const JobOn = z.object({ on: z.boolean() });
const ModelCheck = z.object({ id: z.string().regex(/^[\w.-]+\/[\w.:-]+$/).optional() });
/** How many books asked to go next are remembered, the latest first. */
const NEXT_KEPT = 200;
/** A comment down the stream this often, so nothing between here and the page takes it for idle. */
const PING_MS = 20_000;

/*
 * The admin page (frontend/src/admin), served with the app at /admin, talks to this on whichever
 * server answers, behind ADMIN_TOKEN. Without the token set, none of it exists. Accounts with an
 * admin role replace the token in Phase 2.
 *
 * - /admin/stream pushes everything the page shows, each time it changes (lib/admin-live.ts).
 * - The marker's settings, its queue (next, kept back, tried again, stopped, a step done again,
 *   each reader's first book) and the worker's jobs (run now, on or off) go into admin_state and admin_commands
 *   (lib/admin.ts), for the worker and the marker to take up within a few seconds.
 * - On the laptop it also connects the AI accounts the marker's research and music run on
 *   (lib/cliproxy.ts): Antigravity, Claude Code and Codex, each with its limits, and which goes first.
 * - And it takes a book's music scored somewhere else (shared/src/ai.ts, MusicImport): checked
 *   against the book's file here, then left in the file store for the AI marker, which stores its
 *   tracks and puts it into the file (ai/tools/marker.ts).
 */
export function adminRoutes(deps: Deps) {
  const { env, pool, storage } = deps;
  const r = new Hono<AppEnv>();
  if (!env.ADMIN_TOKEN) return r;
  const token = Buffer.from(env.ADMIN_TOKEN);
  const hub = adminHub(deps);

  const checkToken = (c: Context<AppEnv>) => {
    const given = Buffer.from((c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, ''));
    if (given.length !== token.length || !timingSafeEqual(given, token)) {
      throw new ApiError(401, 'not_admin', 'That isn’t the admin token.');
    }
    c.header('Cache-Control', 'no-store');
  };

  /** Who asked, as this server sees them. */
  const requestOf = (c: Context<AppEnv>) => ({
    ip: c.var.ip,
    from: env.CLIENT_IP_HEADER,
    headers: Object.fromEntries(
      ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip', 'true-client-ip'].flatMap((h) => {
        const v = c.req.header(h);
        return v ? [[h, v]] : [];
      }),
    ),
  });

  // The page itself is the app's.
  r.get('/admin', (c) => {
    const app = env.APP_URL ?? env.ALLOWED_ORIGINS[0];
    if (!app) throw new ApiError(404, 'not_found', 'No such endpoint.');
    return c.redirect(`${app.replace(/\/+$/, '')}/admin`, 302);
  });

  r.get('/admin/status', rateLimit({ name: 'admin', max: 30, windowMs: 60_000 }), async (c) => {
    checkToken(c);
    const s = await hub.read();
    return c.json({ ...s.status, request: requestOf(c), marker: s.marker });
  });

  r.get('/admin/stream', rateLimit({ name: 'admin-stream', max: 30, windowMs: 60_000 }), (c) => {
    checkToken(c);
    const request = requestOf(c);
    return streamSSE(c, async (s) => {
      let sent = Promise.resolve();
      const stop = hub.watch((json) => {
        const data = `{"request":${JSON.stringify(request)},${json.slice(1)}`;
        sent = sent.then(() => s.writeSSE({ event: 'snapshot', data })).catch(() => {});
      });
      const ping = setInterval(() => {
        sent = sent.then(async () => { await s.write(': ping\n\n'); }).catch(() => {});
      }, PING_MS);
      await new Promise<void>((done) => s.onAbort(() => done()));
      clearInterval(ping);
      stop();
    });
  });

  const control = rateLimit({ name: 'admin-control', max: 120, windowMs: 60_000 });

  r.post('/admin/settings', control, async (c) => {
    checkToken(c);
    const patch = parse(MarkerPatch, await readJson(c));
    const s = await changeAdminState(pool, (st) => ({ ...st, marker: { ...st.marker, ...patch } }));
    return c.json({ settings: s.marker });
  });

  // Who does which stages of the pipeline: for some books, or for books to come.
  r.post('/admin/stages', control, async (c) => {
    checkToken(c);
    const a = parse(StagesAction, await readJson(c));
    const s = await changeAdminState(pool, (st) => withStages(st, a));
    return c.json({ stages: s.stages });
  });

  // NVIDIA's models checked now, all of them or one, by the marker (ai/tools/models.ts).
  r.post('/admin/models/check', control, async (c) => {
    checkToken(c);
    const { id } = parse(ModelCheck, await readJson(c));
    await addCommand(pool, 'models', id ? { id } : {});
    return c.json({ ok: true }, 202);
  });

  r.post('/admin/queue', control, async (c) => {
    checkToken(c);
    const a = parse(QueueAction, await readJson(c));
    const key = queueKey(a.id, a.task);
    const without = (list: string[]) => list.filter((k) => k !== key);
    if (a.action === 'next') {
      await changeAdminState(pool, (st) => ({ ...st, held: without(st.held), next: [key, ...without(st.next)].slice(0, NEXT_KEPT) }));
    } else if (a.action === 'hold') {
      const held = a.held ?? true;
      await changeAdminState(pool, (st) => ({ ...st, held: held ? [key, ...without(st.held)] : without(st.held) }));
    } else if (a.action === 'retry') {
      await changeAdminState(pool, (st) => ({ ...st, held: without(st.held) }));
      await addCommand(pool, 'retry', { id: a.id, task: a.task });
    } else if (a.action === 'stop') {
      // Back to the queue, kept back until it's let go.
      await changeAdminState(pool, (st) => ({ ...st, held: [key, ...without(st.held)] }));
      await addCommand(pool, 'stop', { id: a.id, task: a.task });
    } else {
      await addCommand(pool, 'redo', { id: a.id, task: a.task });
    }
    return c.json({ ok: true });
  });

  // A reader's first book, picked here over their own pick, or the pick taken back.
  r.post('/admin/first', control, async (c) => {
    checkToken(c);
    const a = parse(FirstAction, await readJson(c));
    await changeAdminState(pool, (st) => {
      const firstFor = { ...st.firstFor };
      if (a.id) firstFor[a.library] = a.id;
      else delete firstFor[a.library];
      return { ...st, firstFor };
    });
    return c.json({ ok: true });
  });

  r.post('/admin/jobs/:name/run', control, async (c) => {
    checkToken(c);
    const name = parse(JobName, c.req.param('name'));
    await addCommand(pool, runKind(name), { name });
    return c.json({ ok: true }, 202);
  });

  r.post('/admin/jobs/:name/on', control, async (c) => {
    checkToken(c);
    const name = parse(JobName, c.req.param('name'));
    const { on } = parse(JobOn, await readJson(c));
    await changeAdminState(pool, (st) => {
      const rest = st.jobsOff.filter((n) => n !== name);
      return { ...st, jobsOff: on ? rest : [...rest, name] };
    });
    return c.json({ ok: true });
  });

  r.post(
    '/admin/music',
    rateLimit({ name: 'admin-music', max: 10, windowMs: 60_000 }),
    bodyLimit({
      maxSize: 4 * 1024 * 1024,
      onError: () => { throw new ApiError(413, 'too_large', 'That file is too large for music: 4 MB at most.'); },
    }),
    async (c) => {
      checkToken(c);
      const upload = parse(MusicImport, await readJson(c));
      const problems = musicImportProblems(upload);
      if (problems.length) {
        throw new ApiError(400, 'bad_music', `The music has ${problems.length} problems. The first: ${problems[0]}`);
      }
      const { rows } = await pool.query<{ sections: string[] }>("SELECT data->'sections' AS sections FROM ai_notes WHERE sha256 = $1", [upload.sha256]);
      const row = rows[0];
      if (!row) {
        throw new ApiError(404, 'not_marked', 'No book file with that SHA-256 has AI marks here yet. Its music can go in once it has.');
      }
      if (row.sections.join(' ') !== upload.sections.join(' ')) {
        throw new ApiError(409, 'reads_differently', 'That book file reads differently here than where the music was scored, so the music would land on the wrong paragraphs.');
      }
      const body = Buffer.from(JSON.stringify(upload));
      await storage.put(musicImportKey(upload.sha256), body, body.length);
      return c.json({ cues: upload.score.cues.length, tracks: upload.score.tracks.length, soundtrack: upload.soundtrack.tracks.length }, 202);
    },
  );

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
    return c.json({ accounts: inUseOrder(await listAccounts(p)) });
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

  r.post('/admin/accounts/:id/first', accounts, async (c) => {
    const p = proxy(c);
    const id = parse(z.string().min(1).max(300), c.req.param('id'));
    await putFirst(p, id);
    hub.refreshAccounts();
    return c.json({ ok: true });
  });

  r.get('/admin/accounts/status', accounts, async (c) => {
    const p = proxy(c);
    const state = parse(State, c.req.query('state'));
    const status = await signInStatus(p, state);
    if (status.status === 'ok') hub.refreshAccounts();
    return c.json(status);
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
    hub.refreshAccounts();
    return c.json({ ok: true });
  });

  return r;
}
