import type { Env } from '../env.ts';
import { log } from '../log.ts';
import { PANEL_ROUND } from '../panels/round.ts';
import { Scheduler, type Job, type Kind, type Payload, type Runner, type Stats } from './scheduler.ts';
import { frame, unframe, type Answered, type Done, type Info, type Run } from './wire.ts';

/*
 * The API's side of the engines (ADR 0002): the scheduler (scheduler.ts), and how it reaches each
 * engine at ENGINE_URLS (serve.ts) over HTTP. Every 2 seconds it asks each engine how it is (its
 * workers, its memory); one that doesn't answer is down until it does.
 *
 * Fallback engines (ENGINE_FALLBACK_URLS, ADR 0004: Modal, which stops when nobody asks it
 * anything) are on call: a job goes to them only when every engine at ENGINE_URLS is down or
 * turns it away as busy. They're asked nothing until a job comes, and nothing again once they've
 * been quiet a while, so they can stop.
 */

export type { Job, Kind, Stats } from './scheduler.ts';
export { busyError, offError } from './scheduler.ts';

export interface Result {
  head: Done;
  bytes: Uint8Array;
}

export interface Engine {
  run(job: Job): Promise<Result>;
  waiting(kind: Kind, who?: string): number;
  /** No engine up, or every one short of memory. */
  readonly short: boolean;
  /** The panel model's round on an engine that has it, or null. */
  panels(): number | null;
  /** How much of a voice's files an engine has. */
  progress(voice: string): Promise<{ loaded: number; total: number }>;
  stats(): Stats;
  close(): Promise<void>;
}

/** How often each engine is asked how it is. */
const TICK_MS = 2_000;
/** Longer than any job: a page of a long strip, a long sentence. */
const RUN_MS = 5 * 60_000;
const ASK_MS = 1_500;

/** Reaches the engines over HTTP. */
export function httpRunner(urls: string[], token?: string): Runner & { info(h: number, waitMs?: number): Promise<Info>; get(h: number, path: string, waitMs?: number): Promise<unknown> } {
  const headers = (more: Record<string, string> = {}) => ({ ...more, ...(token ? { authorization: `Bearer ${token}` } : {}) });
  const base = urls.map((u) => u.replace(/\/+$/, ''));
  const get = async (h: number, path: string, waitMs = ASK_MS) => {
    const r = await fetch(`${base[h]}${path}`, { headers: headers(), signal: AbortSignal.timeout(waitMs) });
    if (!r.ok) throw new Error(`The engine answered ${r.status}.`);
    return r.json();
  };
  return {
    get,
    info: (h, waitMs) => get(h, '/v1/info', waitMs) as Promise<Info>,
    async run(h, slot, payload, drop) {
      const p = payload as Payload & { ask: Run['ask'] };
      let res: Response;
      try {
        res = await fetch(`${base[h]}/v1/run`, {
          method: 'POST',
          headers: headers({ 'content-type': 'application/octet-stream' }),
          body: frame({ slot, drop, ask: p.ask } satisfies Run, p.bytes),
          signal: AbortSignal.timeout(RUN_MS),
        });
      } catch (err) {
        // Not reached: whatever its worker held is lost to us.
        throw Object.assign(new Error(`The engine couldn’t be reached: ${(err as Error).message}`), { stopped: true });
      }
      if (!res.ok) throw Object.assign(new Error(`The engine answered ${res.status}.`), { stopped: res.status >= 500 });
      const { head, bytes } = unframe<Answered>(new Uint8Array(await res.arrayBuffer()));
      if (!head.ok) throw Object.assign(new Error(head.error), { stopped: !!head.stopped });
      return { head, bytes } satisfies Result;
    },
    stop(h, slot) {
      void fetch(`${base[h]}/v1/stop`, { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify({ slot }), signal: AbortSignal.timeout(ASK_MS) }).catch(() => {});
    },
  };
}

export interface EngineTimes {
  /** How often an engine is asked how it is. */
  tickMs?: number;
  /** A fallback engine quiet this long, nothing running or waiting, is asked nothing more. */
  restAfterMs?: number;
  /** How long a fallback engine may take to start and answer. */
  wakeMs?: number;
  /** After a fallback engine didn't wake, jobs are turned away this long before it's tried again. */
  retryMs?: number;
}

/** A fallback engine rests after this long quiet: Modal stops its container a little after (infra/modal). */
const REST_AFTER_MS = 2 * 60_000;
/** Modal starting a container, and the engine in it loading. */
const WAKE_MS = 90_000;
const RETRY_MS = 60_000;

/** Whether a job was turned away for want of an engine, rather than failing on one. */
export function turnedAway(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { off?: boolean; busy?: boolean };
  if (e.off) return true;
  if (e.busy) return true;
  return false;
}

/** The engines at `urls`. On call: asked only while jobs come, woken by the first. */
function engineAt(urls: string[], token: string | undefined, onCall: boolean, times: EngineTimes): Engine {
  const tickMs = times.tickMs ?? TICK_MS;
  const restAfterMs = times.restAfterMs ?? REST_AFTER_MS;
  const wakeMs = times.wakeMs ?? WAKE_MS;
  const retryMs = times.retryMs ?? RETRY_MS;
  const runner = httpRunner(urls, token);
  const s = new Scheduler(runner, {
    hosts: urls.length,
    onLow: (h, low, free) => {
      if (low) log.warn({ engine: urls[h], freeMb: Math.round(free) }, 'engine short of memory: only live reading starts there');
      else log.info({ engine: urls[h], freeMb: Math.round(free) }, 'engine has memory again');
    },
  });
  const up: boolean[] = urls.map(() => false);
  // What each engine last said of the panel model. An engine on call that hasn't said yet is taken
  // to have the round this release ships, as its image is this release's (infra/modal).
  const rounds: Array<number | null> = urls.map(() => (onCall ? PANEL_ROUND : null));
  let timer: NodeJS.Timeout | null = null;
  let awake = false;
  let waking: Promise<void> | null = null;
  let lastUsed = 0;
  let failedAt = -Infinity;
  let running = 0;

  async function ask(h: number, waitMs?: number) {
    try {
      const info = await runner.info(h, waitMs);
      if (!up[h]) log.info({ engine: urls[h], workers: info.workers, panelWorkers: info.panelWorkers, threads: info.threads, budgetMb: info.budgetMb, panels: info.panels }, 'engine up');
      up[h] = true;
      rounds[h] = info.panels;
      s.host(h, info);
    } catch (err) {
      if (up[h]) log.warn({ engine: urls[h], err: (err as Error).message }, 'engine down');
      up[h] = false;
      if (!onCall) rounds[h] = null;
      s.host(h, null);
    }
  }
  const askAll = (waitMs?: number) => Promise.all(urls.map((_, h) => ask(h, waitMs)));

  function quiet(): boolean {
    if (running > 0) return false;
    if (s.waiting('live') > 0) return false;
    if (s.waiting('panel') > 0) return false;
    return Date.now() - lastUsed >= restAfterMs;
  }

  /** Asked nothing more: its engines are taken as down, and it may stop. */
  function rest() {
    if (timer) clearInterval(timer);
    timer = null;
    awake = false;
    for (const [h] of urls.entries()) {
      up[h] = false;
      s.host(h, null);
    }
    log.info({ engines: urls.length }, 'fallback engines resting');
  }

  async function tick() {
    await askAll();
    if (onCall && awake && quiet()) rest();
  }

  function watch() {
    timer = setInterval(() => void tick(), tickMs);
    timer.unref();
  }

  async function wakeUp() {
    log.info({ engines: urls.length }, 'waking the fallback engines');
    await askAll(wakeMs);
    if (!up.some(Boolean)) {
      failedAt = Date.now();
      log.warn({ engines: urls.length }, 'the fallback engines didn’t wake');
      return;
    }
    awake = true;
    watch();
  }

  /** Woken, unless it failed to wake a moment ago. */
  async function wake() {
    if (awake) return;
    if (Date.now() - failedAt < retryMs) return;
    // Jobs that come while it wakes wait on the same waking.
    if (!waking) waking = wakeUp();
    try {
      await waking;
    } finally {
      waking = null;
    }
  }

  if (onCall) {
    // Nothing asked until a job comes.
  } else {
    void askAll();
    watch();
  }

  async function run(job: Job): Promise<Result> {
    lastUsed = Date.now();
    if (onCall) await wake();
    running += 1;
    try {
      return (await s.run(job)) as Result;
    } finally {
      running -= 1;
      lastUsed = Date.now();
    }
  }

  return {
    run,
    waiting: (kind, who) => s.waiting(kind, who),
    get short() {
      // Resting, it isn't short: a job wakes it.
      if (onCall && !awake) return false;
      return s.short;
    },
    panels: () => rounds.find((r) => r !== null) ?? null,
    async progress(voice) {
      const h = up.findIndex(Boolean);
      if (h < 0) return { loaded: 0, total: 0 };
      return (await runner.get(h, `/v1/progress?voice=${encodeURIComponent(voice)}`)) as { loaded: number; total: number };
    },
    stats: () => s.stats(),
    async close() {
      if (timer) clearInterval(timer);
      s.close();
    },
  };
}

/** Jobs to `primary`, and to `fallback` only when every primary engine is down or turns them away. */
export function withFallback(primary: Engine, fallback: Engine): Engine {
  function primaryUp(): boolean {
    return primary.stats().engines.some((e) => e.up);
  }

  return {
    async run(job) {
      try {
        return await primary.run(job);
      } catch (err) {
        if (!turnedAway(err)) throw err;
        log.debug({ kind: job.kind, err: (err as Error).message }, 'a job goes to the fallback engines');
        return fallback.run(job);
      }
    },
    waiting: (kind, who) => primary.waiting(kind, who) + fallback.waiting(kind, who),
    get short() {
      if (!primary.short) return false;
      return fallback.short;
    },
    panels() {
      const round = primary.panels();
      if (round !== null) return round;
      return fallback.panels();
    },
    progress(voice) {
      if (primaryUp()) return primary.progress(voice);
      return fallback.progress(voice);
    },
    stats() {
      const a = primary.stats();
      const b = fallback.stats();
      return {
        engines: [...a.engines, ...b.engines],
        waiting: { live: a.waiting.live + b.waiting.live, panel: a.waiting.panel + b.waiting.panel },
        done: { live: a.done.live + b.done.live, panel: a.done.panel + b.done.panel },
      };
    },
    async close() {
      await primary.close();
      await fallback.close();
    },
  };
}

/** The engines at ENGINE_URLS, with those at ENGINE_FALLBACK_URLS on call behind them; null with neither. */
export function makeEngine(env: Pick<Env, 'ENGINE_URLS' | 'ENGINE_FALLBACK_URLS' | 'ENGINE_TOKEN'>, times: EngineTimes = {}): Engine | null {
  let primary: Engine | null = null;
  if (env.ENGINE_URLS.length) primary = engineAt(env.ENGINE_URLS, env.ENGINE_TOKEN, false, times);
  let fallback: Engine | null = null;
  if (env.ENGINE_FALLBACK_URLS.length) fallback = engineAt(env.ENGINE_FALLBACK_URLS, env.ENGINE_TOKEN, true, times);
  if (!fallback) return primary;
  if (!primary) return fallback;
  return withFallback(primary, fallback);
}
