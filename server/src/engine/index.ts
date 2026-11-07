import type { Env } from '../env.ts';
import { log } from '../log.ts';
import { Scheduler, type Job, type Kind, type Payload, type Runner, type Stats } from './scheduler.ts';
import { frame, unframe, type Answered, type Done, type Info, type Run } from './wire.ts';

/*
 * The API's side of the engines (ADR 0002): the scheduler (scheduler.ts), and how it reaches each
 * engine at ENGINE_URLS (serve.ts) over HTTP. Every 2 seconds it asks each engine how it is (its
 * workers, its memory); one that doesn't answer is down until it does.
 */

export type { Job, Kind, Stats } from './scheduler.ts';
export { busyError, droppedError, offError } from './scheduler.ts';

export interface Result {
  head: Done;
  bytes: Uint8Array;
}

export interface Engine {
  run(job: Job): Promise<Result>;
  waiting(kind: Kind, who?: string): number;
  /** Turns away what waits in `who`'s line for `sub`. */
  drop(kind: Kind, who: string, sub: string): void;
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
/** Longer than any job: a page of a long strip, a long paragraph's MP3. */
const RUN_MS = 5 * 60_000;
const ASK_MS = 1_500;

/** Reaches the engines over HTTP. */
export function httpRunner(urls: string[], token?: string): Runner & { info(h: number): Promise<Info>; get(h: number, path: string): Promise<unknown> } {
  const headers = (more: Record<string, string> = {}) => ({ ...more, ...(token ? { authorization: `Bearer ${token}` } : {}) });
  const base = urls.map((u) => u.replace(/\/+$/, ''));
  const get = async (h: number, path: string) => {
    const r = await fetch(`${base[h]}${path}`, { headers: headers(), signal: AbortSignal.timeout(ASK_MS) });
    if (!r.ok) throw new Error(`The engine answered ${r.status}.`);
    return r.json();
  };
  return {
    get,
    info: (h) => get(h, '/v1/info') as Promise<Info>,
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

export function makeEngine(env: Pick<Env, 'ENGINE_URLS' | 'ENGINE_TOKEN'>): Engine | null {
  const urls = env.ENGINE_URLS;
  if (!urls.length) return null;
  const runner = httpRunner(urls, env.ENGINE_TOKEN);
  const s = new Scheduler(runner, {
    hosts: urls.length,
    onLow: (h, low, free) => {
      if (low) log.warn({ engine: urls[h], freeMb: Math.round(free) }, 'engine short of memory: only live reading starts there');
      else log.info({ engine: urls[h], freeMb: Math.round(free) }, 'engine has memory again');
    },
  });
  const rounds: Array<number | null> = urls.map(() => null);
  const up: boolean[] = urls.map(() => false);

  async function ask(h: number) {
    try {
      const info = await runner.info(h);
      if (!up[h]) log.info({ engine: urls[h], workers: info.workers, threads: info.threads, budgetMb: info.budgetMb, panels: info.panels }, 'engine up');
      up[h] = true;
      rounds[h] = info.panels;
      s.host(h, info);
    } catch (err) {
      if (up[h]) log.warn({ engine: urls[h], err: (err as Error).message }, 'engine down');
      up[h] = false;
      rounds[h] = null;
      s.host(h, null);
    }
  }
  const askAll = () => Promise.all(urls.map((_, h) => ask(h)));
  void askAll();
  const timer = setInterval(() => void askAll(), TICK_MS);
  timer.unref();

  return {
    run: (job) => s.run(job) as Promise<Result>,
    waiting: (kind, who) => s.waiting(kind, who),
    drop: (kind, who, sub) => s.drop(kind, who, sub),
    get short() {
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
      clearInterval(timer);
      s.close();
    },
  };
}
