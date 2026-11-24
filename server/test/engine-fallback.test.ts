import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { afterAll, describe, expect, it } from 'vitest';
import { makeEngine, turnedAway, withFallback, type Engine, type EngineTimes, type Job, type Result } from '../src/engine/index.ts';
import { busyError, offError } from '../src/engine/scheduler.ts';
import { makeEngineApp, type Pool } from '../src/engine/serve.ts';
import { PANEL_ROUND } from '../src/panels/round.ts';

/*
 * Engines on call (ENGINE_FALLBACK_URLS, ADR 0004): Modal, which stops when nobody asks it
 * anything. A job goes there only when the laptop's engines are down or busy, and it's asked
 * nothing while it rests. Fake engines over HTTP, counting what they're asked.
 */

const TOKEN = 'a-token-of-sixteen-or-more';
const quick: EngineTimes = { tickMs: 20, restAfterMs: 150, wakeMs: 1_000, retryMs: 60_000 };

const servers: ServerType[] = [];
const engines: Engine[] = [];
afterAll(async () => {
  for (const e of engines) await e.close();
  for (const s of servers) s.close();
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await wait(10);
  }
  throw new Error('never came true');
}

async function listen(app: Hono): Promise<{ url: string; server: ServerType }> {
  const server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

/** An engine whose "MP3" is the text it was given; counts every request it's sent. */
async function start(o: { panel?: boolean } = {}) {
  const said: string[] = [];
  const pool: Pool = {
    async run(_slot, body) {
      if (body.type === 'say') said.push(body.text);
      return { mp3: new Uint8Array([0xff, 0xfb]), samples: 10, rate: 24_000 };
    },
    stop: () => {},
    close: async () => {},
  };
  let panel: { file: string; round: number } | null = { file: '/m/live.onnx', round: 9 };
  if (o.panel === false) panel = null;
  const engine = makeEngineApp({
    pool,
    size: { workers: 2, threads: 2, budgetMb: 4_000, lowMb: 500 },
    cores: 4,
    speechDir: '/nowhere',
    panel,
    token: TOKEN,
    files: { ensure: async () => ({ engine: 'piper' as const, model: '/m/a.onnx', config: '/m/a.json' }), progress: async () => ({ loaded: 1, total: 1 }) },
  });
  const counted = { asked: 0 };
  const app = new Hono();
  app.all('*', (c) => {
    counted.asked += 1;
    return engine.fetch(c.req.raw);
  });
  const { url, server } = await listen(app);
  return { url, server, said, counted };
}

/** An engine that answers nothing but 503, as Modal does when it can't start one. */
async function broken() {
  const counted = { asked: 0 };
  const app = new Hono();
  app.all('*', (c) => {
    counted.asked += 1;
    return c.json({ error: 'no' }, 503);
  });
  const { url } = await listen(app);
  return { url, counted };
}

function connect(primary: string[], fallback: string[], token = TOKEN): Engine {
  const e = makeEngine({ ENGINE_URLS: primary, ENGINE_FALLBACK_URLS: fallback, ENGINE_TOKEN: token }, quick)!;
  engines.push(e);
  return e;
}

const say = (text: string): Job => ({ kind: 'live', who: 'me', model: null, body: () => ({ ask: { type: 'say', voice: 'piper:a', text, speed: 1 } }) });

describe('engines on call', () => {
  it('are asked nothing while the laptop’s engine does the work', async () => {
    const laptop = await start();
    const modal = await start();
    const engine = connect([laptop.url], [modal.url]);
    await until(() => engine.stats().engines[0].up);
    await engine.run(say('Hello.'));
    expect(laptop.said).toEqual(['Hello.']);
    expect(modal.said).toEqual([]);
    expect(modal.counted.asked).toBe(0);
  });

  it('take a job when the laptop’s engine is down, and are woken for it', async () => {
    const laptop = await start();
    const modal = await start();
    const engine = connect([laptop.url], [modal.url]);
    await until(() => engine.stats().engines[0].up);
    laptop.server.close();
    (laptop.server as import('node:http').Server).closeAllConnections();
    await until(() => !engine.stats().engines[0].up);
    await engine.run(say('Still here.'));
    expect(modal.said).toEqual(['Still here.']);
    expect(engine.stats().engines.map((e) => e.up)).toEqual([false, true]);
  });

  it('are the only engine where none other is set', async () => {
    const modal = await start();
    const engine = connect([], [modal.url]);
    expect(engine.stats().engines.length).toBe(1);
    expect(modal.counted.asked).toBe(0);
    await engine.run(say('Only you.'));
    expect(modal.said).toEqual(['Only you.']);
  });

  it('rest after a quiet while, asked nothing more and not short, and wake for the next job', async () => {
    const modal = await start();
    const engine = connect([], [modal.url]);
    await engine.run(say('One.'));
    expect(engine.stats().engines[0].up).toBe(true);
    await until(() => !engine.stats().engines[0].up);
    const asked = modal.counted.asked;
    await wait(200);
    expect(modal.counted.asked).toBe(asked);
    expect(engine.short).toBe(false);
    await engine.run(say('Two.'));
    expect(modal.said).toEqual(['One.', 'Two.']);
  });

  it('turn jobs away at once for a while after they didn’t wake', async () => {
    const modal = await broken();
    const engine = connect([], [modal.url]);
    await expect(engine.run(say('Hi.'))).rejects.toMatchObject({ off: true });
    expect(modal.counted.asked).toBe(1);
    await expect(engine.run(say('Hi again.'))).rejects.toMatchObject({ off: true });
    expect(modal.counted.asked).toBe(1);
  });

  it('say the panel round this release ships before they’re asked, then their own', async () => {
    const modal = await start({ panel: false });
    const engine = connect([], [modal.url]);
    expect(engine.panels()).toBe(PANEL_ROUND);
    expect(modal.counted.asked).toBe(0);
    await engine.run(say('Hm.'));
    expect(engine.panels()).toBeNull();
  });

  it('none set, and no engine at all', () => {
    expect(makeEngine({ ENGINE_URLS: [], ENGINE_FALLBACK_URLS: [], ENGINE_TOKEN: TOKEN })).toBeNull();
  });
});

/** An engine that runs jobs the way it's told, counting them. */
function fake(o: { fails?: Error; up?: boolean; round?: number | null; short?: boolean } = {}) {
  const ran: string[] = [];
  const e: Engine = {
    async run(job) {
      ran.push(job.who);
      if (o.fails) throw o.fails;
      return { head: { ok: true }, bytes: new Uint8Array() } as unknown as Result;
    },
    waiting: () => 1,
    short: o.short ?? false,
    panels: () => o.round ?? null,
    progress: async () => ({ loaded: o.up ? 1 : 2, total: 2 }),
    stats: () => ({
      engines: [{ up: o.up ?? true, workers: 1, started: 0, busy: 0, heldMb: 0, budgetMb: 0, freeMb: 0, low: false, models: [] }],
      waiting: { live: 1, panel: 0 },
      done: { live: 0, panel: 0 },
    }),
    close: async () => {},
  };
  return { e, ran };
}

describe('a job and its fallback', () => {
  it('goes to the fallback when the laptop’s engines are down or busy', async () => {
    for (const err of [offError('down'), busyError('busy')]) {
      const laptop = fake({ fails: err });
      const modal = fake();
      await withFallback(laptop.e, modal.e).run(say('x'));
      expect(modal.ran).toEqual(['me']);
    }
  });

  it('fails as it failed when an engine ran it and it went wrong, without the fallback', async () => {
    const laptop = fake({ fails: new Error('a bad voice') });
    const modal = fake();
    await expect(withFallback(laptop.e, modal.e).run(say('x'))).rejects.toThrow('a bad voice');
    expect(modal.ran).toEqual([]);
  });

  it('takes the laptop’s panel round, its progress while it’s up, and counts both', async () => {
    const both = withFallback(fake({ round: 4, up: true }).e, fake({ round: 9 }).e);
    expect(both.panels()).toBe(4);
    expect(await both.progress('piper:a')).toEqual({ loaded: 1, total: 2 });
    expect(both.waiting('live')).toBe(2);
    expect(both.stats().engines.length).toBe(2);
    const down = withFallback(fake({ round: null, up: false }).e, fake({ round: 9, up: false }).e);
    expect(down.panels()).toBe(9);
    expect(await down.progress('piper:a')).toEqual({ loaded: 2, total: 2 });
  });

  it('is short only when both are', () => {
    expect(withFallback(fake({ short: true }).e, fake({ short: false }).e).short).toBe(false);
    expect(withFallback(fake({ short: false }).e, fake({ short: true }).e).short).toBe(false);
    expect(withFallback(fake({ short: true }).e, fake({ short: true }).e).short).toBe(true);
  });

  it('knows a job turned away from one that failed', () => {
    expect(turnedAway(offError('x'))).toBe(true);
    expect(turnedAway(busyError('x'))).toBe(true);
    expect(turnedAway(new Error('x'))).toBe(false);
    expect(turnedAway(null)).toBe(false);
  });
});
