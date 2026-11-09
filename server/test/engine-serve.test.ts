import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { afterAll, describe, expect, it } from 'vitest';
import { makeEngine, type Engine } from '../src/engine/index.ts';
import { makeEngineApp, threadPool, type Pool } from '../src/engine/serve.ts';
import { frame, unframe } from '../src/engine/wire.ts';
import type { Body } from '../src/engine/worker.ts';
import { makePanels } from '../src/panels/index.ts';
import { makeSpeech } from '../src/speech/index.ts';
import { env } from './helpers.ts';

/*
 * An engine (serve.ts) and the API talking to it over HTTP (index.ts), with a fake pool of workers
 * in place of ONNX Runtime: a sentence's "MP3" is its text, a page's panels one for each row of
 * its pixels.
 */

const TOKEN = 'a-token-of-sixteen-or-more';
const enc = (t: string) => new TextEncoder().encode(t);
/** An "MP3": a frame's first two bytes (as speech/index.ts checks for), then the text. */
const mp3 = (t: string) => new Uint8Array([0xff, 0xfb, ...enc(t)]);
const text = (b: Uint8Array) => new TextDecoder().decode(b.subarray(2));

interface Seen { slot: number; body: Body; drop: string[] }

function fakePool(o: { wait?: () => Promise<void> } = {}) {
  const seen: Seen[] = [];
  const stopped: number[] = [];
  const pool: Pool = {
    async run(slot, body, _transfer, drop) {
      seen.push({ slot, body, drop });
      await o.wait?.();
      switch (body.type) {
        case 'say':
          return { mp3: mp3(body.text), samples: body.text.length * 10, rate: 24_000 };
        case 'panels':
          return { panels: Array.from(body.px, () => [[0, 0], [1, 0], [1, 1]] as Array<[number, number]>), sure: Array.from(body.px, () => 0.9), w: body.w, h: body.h };
        default:
          return {};
      }
    },
    stop: (slot) => { stopped.push(slot); },
    close: async () => {},
  };
  return { pool, seen, stopped };
}

const files = {
  ensure: async (voice: string) => {
    if (!voice.startsWith('piper:')) throw new Error(`No such voice: ${voice}`);
    return { engine: 'piper' as const, model: `/m/${voice}.onnx`, config: `/m/${voice}.json` };
  },
  progress: async () => ({ loaded: 5, total: 10 }),
};

/** A page opened as a row of pixels for each of its picture's bytes. */
const cut = async (data: Uint8Array, model: string) => ({
  type: 'panels' as const,
  model,
  w: 100,
  h: 100 * data.length,
  px: new Uint8Array(data.length),
});

const servers: ServerType[] = [];
const engines: Engine[] = [];
afterAll(async () => {
  for (const e of engines) await e.close();
  for (const s of servers) s.close();
});

async function start(o: { workers?: number; token?: string; panel?: boolean; wait?: () => Promise<void>; free?: () => number } = {}) {
  const f = fakePool({ wait: o.wait });
  const app = makeEngineApp({
    pool: f.pool,
    size: { workers: o.workers ?? 2, threads: 2, budgetMb: 4_000, lowMb: 500 },
    cores: 4,
    speechDir: '/nowhere',
    panel: o.panel === false ? null : { file: '/m/live.onnx', round: 9 },
    token: o.token,
    files,
    cut,
    free: o.free,
  });
  const server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  servers.push(server);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { ...f, app, url, server };
}

async function connect(urls: string[], token?: string) {
  const e = makeEngine({ ENGINE_URLS: urls, ENGINE_TOKEN: token })!;
  engines.push(e);
  for (let i = 0; i < 100 && !e.stats().engines.some((x) => x.up); i++) await new Promise((r) => setTimeout(r, 20));
  return e;
}

const runOn = (app: { request: (p: string, i?: RequestInit) => Response | Promise<Response> }, head: unknown, bytes?: Uint8Array, auth = `Bearer ${TOKEN}`) =>
  app.request('/v1/run', { method: 'POST', headers: { authorization: auth }, body: frame(head, bytes) });

describe('an engine', () => {
  it('asks for its token when it has one', async () => {
    const { app } = await start({ token: TOKEN });
    expect((await app.request('/v1/info')).status).toBe(401);
    expect((await app.request('/v1/info', { headers: { authorization: 'Bearer wrong-token-of-the-same-size' } })).status).toBe(401);
    expect((await app.request('/v1/info', { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    expect((await runOn(app, { slot: 0, drop: [], ask: { type: 'load', voice: 'piper:a' } }, undefined, 'Bearer nope')).status).toBe(401);
    // Its health is anyone's to see.
    expect((await app.request('/health')).status).toBe(200);
  });

  it('says how it is', async () => {
    const { app } = await start({ free: () => 1234.4 });
    const info = (await (await app.request('/v1/info')).json()) as Record<string, unknown>;
    expect(info).toMatchObject({ cores: 4, workers: 2, threads: 2, budgetMb: 4_000, lowMb: 500, freeMb: 1234, panels: 9 });
    expect(typeof info.boot).toBe('string');
  });

  it('turns away a worker it hasn’t, a job it doesn’t know, and a body that isn’t one', async () => {
    const { app } = await start();
    expect((await runOn(app, { slot: 2, drop: [], ask: { type: 'load', voice: 'piper:a' } })).status).toBe(400);
    expect((await runOn(app, { slot: -1, drop: [], ask: { type: 'load', voice: 'piper:a' } })).status).toBe(400);
    expect((await runOn(app, { slot: 0.5, drop: [], ask: { type: 'load', voice: 'piper:a' } })).status).toBe(400);
    expect((await runOn(app, { slot: 0, drop: 'x', ask: { type: 'load', voice: 'piper:a' } })).status).toBe(400);
    expect((await runOn(app, { slot: 0, drop: [], ask: { type: 'dance' } })).status).toBe(400);
    // Audiobooks are made on readers' devices: an engine makes no sound or MP3 for one.
    expect((await runOn(app, { slot: 0, drop: [], ask: { type: 'sound', voice: 'piper:a', text: 'Hi.', speed: 1 } })).status).toBe(400);
    expect((await runOn(app, { slot: 0, drop: [], ask: { type: 'encode', rate: 16_000 } }, new Uint8Array(8))).status).toBe(400);
    expect((await app.request('/v1/run', { method: 'POST', body: 'no' })).status).toBe(400);
    expect((await app.request('/v1/run', { method: 'POST', body: new Uint8Array(0) })).status).toBe(400);
    expect((await app.request('/v1/progress?voice=piper:nope')).status).toBe(400);
  });

  it('answers a voice it hasn’t with the reason, not a crash', async () => {
    const { app } = await start();
    const r = await runOn(app, { slot: 0, drop: [], ask: { type: 'say', voice: 'user:mine', text: 'Hi.', speed: 1 } });
    expect(unframe(new Uint8Array(await r.arrayBuffer())).head).toEqual({ ok: false, error: 'No such voice: user:mine' });
  });

  it('names a voice’s model for its worker, and passes on what to let go of', async () => {
    const { app, seen } = await start();
    await runOn(app, { slot: 1, drop: ['kokoro'], ask: { type: 'say', voice: 'piper:kristin', text: 'Hi.', speed: 1.5 } });
    expect(seen[0]).toMatchObject({ slot: 1, drop: ['kokoro'], body: { type: 'say', key: 'piper:kristin', text: 'Hi.', speed: 1.5 } });
  });

  it('says a page’s panels are none of its business without the model', async () => {
    const { app } = await start({ panel: false });
    const r = await runOn(app, { slot: 0, drop: [], ask: { type: 'panels' } }, new Uint8Array(1));
    expect(unframe(new Uint8Array(await r.arrayBuffer())).head).toMatchObject({ ok: false });
    expect(((await (await app.request('/v1/info')).json()) as { panels: unknown }).panels).toBeNull();
  });

  it('stops a worker when asked, and only one it has', async () => {
    const { app, stopped } = await start();
    for (const slot of [1, 7, -1, 'x']) await app.request('/v1/stop', { method: 'POST', body: JSON.stringify({ slot }) });
    expect(stopped).toEqual([1]);
  });
});

describe('the API and its engines', () => {
  it('reads aloud through an engine', async () => {
    const { url, seen } = await start({ token: TOKEN });
    const engine = await connect([url], TOKEN);
    const dir = await mkdtemp(join(tmpdir(), 'said-'));
    try {
      const speech = makeSpeech({ ...env, SPEECH_DIR: dir }, engine);
      const said = await speech.say('piper:kristin', 'It was dark.', 1, 'me');
      expect(text(said.mp3)).toBe('It was dark.');
      expect(said).toMatchObject({ samples: 120, rate: 24_000 });
      // Said once: a second time is kept.
      await speech.say('piper:kristin', 'It was dark.', 1, 'me');
      expect(seen.filter((s) => s.body.type === 'say').length).toBe(1);
      expect(await speech.ready('piper:kristin', 1_000, 'me')).toEqual({ ready: true, loaded: 5, total: 10 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('can’t reach an engine with the wrong token, and turns live reading away', async () => {
    const { url } = await start({ token: TOKEN });
    const engine = await connect([url], 'not-the-right-token-at-all');
    expect(engine.stats().engines[0].up).toBe(false);
    const speech = makeSpeech({ ...env, SPEECH_DIR: join(tmpdir(), 'never') }, engine);
    await expect(speech.say('piper:kristin', 'Hi.', 1)).rejects.toMatchObject({ off: true });
  });

  it('finds a page’s panels on an engine that has the model', async () => {
    const { url } = await start();
    const engine = await connect([url]);
    const panels = makePanels(env, engine);
    expect(panels.on).toBe(true);
    expect(panels.round).toBe(9);
    const found = await panels.find('ch:1', async () => ({ data: new Uint8Array(3), type: 'image/png' }), 'lib');
    expect(found).toMatchObject({ round: 9, w: 100, h: 300, sure: [0.9, 0.9, 0.9] });
    expect(found.panels.length).toBe(3);
  });

  it('says panels are off with no engine that has the model', async () => {
    const { url } = await start({ panel: false });
    const engine = await connect([url]);
    const panels = makePanels(env, engine);
    expect(panels.on).toBe(false);
    await expect(panels.find('ch:2', async () => ({ data: new Uint8Array(1), type: 'image/png' }), 'lib')).rejects.toMatchObject({ busy: true });
  });

  it('notices an engine going away and coming back', async () => {
    const one = await start();
    const engine = await connect([one.url]);
    one.server.close();
    (one.server as import('node:http').Server).closeAllConnections();
    for (let i = 0; i < 200 && engine.stats().engines[0].up; i++) await new Promise((r) => setTimeout(r, 20));
    expect(engine.stats().engines[0].up).toBe(false);
  });
});

describe('the pool of workers', () => {
  // A worker that takes `ms` over each job and says which thread it ran on.
  const SLOW = `import { parentPort, threadId } from 'node:worker_threads';
parentPort.on('message', ({ id, body }) => setTimeout(() => parentPort.postMessage({ id, ok: true, answer: { samples: threadId } }), body.ms));`;

  async function slowPool() {
    const dir = await mkdtemp(join(tmpdir(), 'breader-pool-'));
    const file = join(dir, 'slow.mjs');
    await writeFile(file, SLOW);
    return { pool: threadPool(1, pathToFileURL(file)), dir };
  }
  const job = (ms: number) => ({ type: 'load', ms }) as unknown as Body;

  it('lets a worker go only once its job is done, and starts the slot a new one', async () => {
    const { pool, dir } = await slowPool();
    try {
      const first = pool.run(0, job(300), [], []);
      await new Promise((r) => setTimeout(r, 50));
      pool.stop(0);
      // Ended mid-run, ONNX Runtime's native side would abort the whole engine.
      const a = await first;
      const b = await pool.run(0, job(0), [], []);
      expect(a.samples).toBeGreaterThan(0);
      expect(b.samples).not.toBe(a.samples);
    } finally {
      await pool.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('closes once the jobs running are done', async () => {
    const { pool, dir } = await slowPool();
    try {
      const first = pool.run(0, job(300), [], []);
      const second = pool.run(1, job(0), [], []);
      await second;
      await new Promise((r) => setTimeout(r, 50));
      const closing = pool.close();
      // Jobs asked while it closes aren't started: the API asks again later.
      await expect(pool.run(1, job(0), [], [])).rejects.toMatchObject({ stopped: true });
      await closing;
      expect((await first).samples).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('lets an idle worker go at once', async () => {
    const { pool, dir } = await slowPool();
    try {
      const a = await pool.run(0, job(0), [], []);
      pool.stop(0);
      pool.stop(0);
      const b = await pool.run(0, job(0), [], []);
      expect(b.samples).not.toBe(a.samples);
    } finally {
      await pool.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
