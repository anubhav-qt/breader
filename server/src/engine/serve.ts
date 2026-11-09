import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { Hono } from 'hono';
import { z } from 'zod';
import { fitOf, squareOf, windows } from '@breader/shared/panels';
import { log } from '../log.ts';
import { makeFiles, modelOfVoice, VOICES } from '../speech/files.ts';
import { bytesOf, floats, frame, unframe, type Answered, type Info, type Run } from './wire.ts';
import type { Answer, Body, Reply } from './worker.ts';

/*
 * An engine (ADR 0002): a service of its own, beside the API or on another machine, that runs the
 * model jobs the API's scheduler (scheduler.ts, index.ts) hands it, each on the worker thread it
 * names. It sizes its pool from its own cores and memory, fetches the voices' files it needs, holds
 * the panel model, and cuts pages into the model's windows itself, so only a page's picture travels.
 *
 *   node dist/engine/main.js      (main.ts)
 */

const MB = 1024 * 1024;

export const EngineEnv = z.object({
  ENGINE_PORT: z.coerce.number().int().default(8790),
  /** Asked of the API when set: an engine on another machine is reached over the network. */
  ENGINE_TOKEN: z.string().min(16).optional(),
  SPEECH_DIR: z.string().default('/data/voices'),
  PANEL_MODEL: z.string().optional(),
  ENGINE_WORKERS: z.coerce.number().int().min(1).max(64).optional(),
  ENGINE_THREADS: z.coerce.number().int().min(1).max(16).optional(),
  ENGINE_MEMORY_MB: z.coerce.number().int().min(256).max(1_000_000).optional(),
  ENGINE_LOW_MB: z.coerce.number().int().min(0).max(1_000_000).optional(),
  ENGINE_BESIDE_LIVE: z.coerce.number().int().min(0).max(64).optional(),
});
export type EngineEnv = z.infer<typeof EngineEnv>;

/** Physical cores: ONNX Runtime gains little from a core's second thread. Logical ones if unknown. */
export function coresOf(cpuinfo?: string): number {
  try {
    const text = cpuinfo ?? readFileSync('/proc/cpuinfo', 'utf8');
    const cores = new Set<string>();
    for (const block of text.split(/\n\s*\n/)) {
      const phys = /^physical id\s*:\s*(\d+)/m.exec(block)?.[1];
      const core = /^core id\s*:\s*(\d+)/m.exec(block)?.[1];
      if (phys !== undefined && core !== undefined) cores.add(`${phys}:${core}`);
    }
    if (cores.size) return cores.size;
  } catch {
    // Not Linux: below.
  }
  return availableParallelism();
}

export interface Size {
  workers: number;
  threads: number;
  budgetMb: number;
  lowMb: number;
  besideLive: number;
}

/**
 * The pool's size: a worker for each two cores, of four threads each (measured on 8 cores, test
 * stack: a Kokoro sentence alone in 0.72 s, against 1.1 s with 3 of 2; audiobooks alone 2.95
 * sentences a second, against 2.5). Models held up to half the memory free; short of memory under
 * a quarter of that, or 1 GB if less. While anyone reads aloud, audiobooks use no worker
 * (ENGINE_BESIDE_LIVE): each one at it slows a live sentence by a third or so.
 */
export function sizeOf(env: Pick<EngineEnv, 'ENGINE_WORKERS' | 'ENGINE_THREADS' | 'ENGINE_MEMORY_MB' | 'ENGINE_LOW_MB' | 'ENGINE_BESIDE_LIVE'>, cores: number, freeMb: number): Size {
  const threads = env.ENGINE_THREADS ?? Math.min(4, cores);
  const workers = env.ENGINE_WORKERS ?? Math.max(1, Math.floor(cores / 2));
  const budgetMb = env.ENGINE_MEMORY_MB ?? Math.max(512, Math.floor(freeMb / 2));
  const lowMb = env.ENGINE_LOW_MB ?? Math.min(1024, Math.floor(budgetMb / 4));
  // Any audiobook work slows a live sentence (a third, with one worker of four at it), so none.
  const besideLive = env.ENGINE_BESIDE_LIVE ?? 0;
  return { workers, threads, budgetMb, lowMb, besideLive };
}

/** The panel model and its round: beside the bundle in the image (Dockerfile), or in ai/panels from the source. */
export function panelModelOf(given?: string): { file: string; round: number } | null {
  const fromSource = import.meta.url.endsWith('.ts');
  const file = given ?? fileURLToPath(new URL(fromSource ? '../../../ai/panels/model/live.onnx' : '../../panels/live.onnx', import.meta.url));
  // Checked out without Git LFS, it's a pointer of a few lines, not the model.
  if (!existsSync(file) || statSync(file).size < 1_000_000) return null;
  let round = 0;
  try {
    round = (JSON.parse(readFileSync(file.replace(/\.onnx$/, '.json'), 'utf8')) as { round: number }).round;
  } catch {
    // Unnamed, it's still the model.
  }
  return { file, round };
}

/** Worker threads, by slot, each started when first given a job. */
export interface Pool {
  run(slot: number, body: Body, transfer: ArrayBuffer[], drop: string[]): Promise<Answer>;
  stop(slot: number): void;
  close(): Promise<void>;
}

export function threadPool(threads: number, file?: URL): Pool {
  const workers = new Map<number, Worker>();
  const pending = new Map<number, { w: Worker; resolve: (a: Answer) => void; reject: (e: Error) => void }>();
  /** Workers let go of while running a job: they end once it's done. */
  const leaving = new Set<Worker>();
  let next = 1;
  let closed = false;

  // Ended mid-run, ONNX Runtime's native run calls back into a thread that's gone, and the whole
  // engine aborts (seen when the API stopped while audiobooks were made), so a worker ends idle.
  function endIfIdle(w: Worker) {
    for (const p of pending.values()) if (p.w === w) return;
    leaving.delete(w);
    void w.terminate();
  }

  function start(slot: number) {
    // Bundled, this runs from dist/engine/main.js and the worker is next door; from the source too.
    const f = file ?? new URL(import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js', import.meta.url);
    const w = new Worker(f, { workerData: { threads } });
    w.on('message', (r: Reply) => {
      const p = pending.get(r.id);
      if (!p) return;
      pending.delete(r.id);
      if (r.ok) p.resolve(r.answer);
      else p.reject(new Error(r.error));
      if (leaving.has(w)) endIfIdle(w);
    });
    w.on('error', (err) => log.error({ err, slot }, 'engine worker failed'));
    w.on('exit', (code) => {
      leaving.delete(w);
      if (workers.get(slot) === w) workers.delete(slot);
      for (const [id, p] of pending) {
        if (p.w !== w) continue;
        pending.delete(id);
        p.reject(Object.assign(new Error(`The engine's worker stopped (${code}).`), { stopped: true }));
      }
    });
    workers.set(slot, w);
    log.info({ slot, threads }, 'engine worker started');
    return w;
  }

  return {
    run(slot, body, transfer, drop) {
      // Stopping: the API asks again elsewhere, or here once the engine is back.
      if (closed) return Promise.reject(Object.assign(new Error('The engine is stopping.'), { stopped: true }));
      const w = workers.get(slot) ?? start(slot);
      const id = next++;
      return new Promise<Answer>((resolve, reject) => {
        pending.set(id, { w, resolve, reject });
        w.postMessage({ id, body, drop }, transfer);
      });
    },
    stop(slot) {
      const w = workers.get(slot);
      if (!w) return;
      workers.delete(slot);
      log.info({ slot }, 'engine worker let go');
      // The slot's next job starts a new worker, holding nothing, as the scheduler expects.
      leaving.add(w);
      endIfIdle(w);
    },
    /** Every worker ends once its job is done. */
    async close() {
      closed = true;
      const all = [...workers.values(), ...leaving];
      workers.clear();
      const ended = Promise.all(all.map((w) => new Promise((r) => w.once('exit', r))));
      for (const w of all) {
        leaving.add(w);
        endIfIdle(w);
      }
      await ended;
    },
  };
}

type Sharp = (typeof import('sharp'))['default'];
let sharp: Promise<Sharp> | null = null;

/** The picture as the model sees it: each window letterboxed into its square, as channels of 0 to 1. */
export async function windowsOf(data: Uint8Array, model: string): Promise<Extract<Body, { type: 'panels' }>> {
  sharp ??= import('sharp').then((m) => m.default);
  const { data: rgb, info } = await (await sharp)(data).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels } = info;
  if (channels !== 3) throw new Error(`The page came out with ${channels} channels.`);
  const out: Extract<Body, { type: 'panels' }>['windows'] = [];
  for (const span of windows(w, h)) {
    const fit = fitOf(w, span[1] - span[0]);
    out.push({ input: squareOf(rgb, w, 3, span, fit), fit, span });
  }
  return { type: 'panels', model, w, h, windows: out };
}

export interface EngineDeps {
  pool: Pool;
  size: Size;
  cores: number;
  speechDir: string;
  panel: { file: string; round: number } | null;
  token?: string;
  free?: () => number;
  /** Cuts a page into windows; tests pass their own. */
  cut?: typeof windowsOf;
  /** The voices' files; tests pass their own, so nothing is downloaded. */
  files?: Pick<ReturnType<typeof makeFiles>, 'ensure' | 'progress'>;
}

/** The engine's HTTP side. */
export function makeEngineApp(d: EngineDeps) {
  const files = d.files ?? makeFiles(d.speechDir);
  const free = d.free ?? (() => process.availableMemory() / MB);
  const cut = d.cut ?? windowsOf;
  const boot = crypto.randomUUID();
  const token = d.token ? Buffer.from(d.token) : null;
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true }));

  app.use('/v1/*', async (c, next) => {
    if (token) {
      const given = Buffer.from((c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, ''));
      if (given.length !== token.length || !timingSafeEqual(given, token)) return c.json({ error: 'That isn’t the engine’s token.' }, 401);
    }
    await next();
  });

  app.get('/v1/info', (c) =>
    c.json({ boot, cores: d.cores, ...d.size, freeMb: Math.round(free()), panels: d.panel?.round ?? null } satisfies Info),
  );

  app.get('/v1/progress', async (c) => {
    const voice = c.req.query('voice') ?? '';
    if (!VOICES.includes(voice)) return c.json({ error: 'No such voice.' }, 400);
    return c.json(await files.progress(voice));
  });

  app.post('/v1/stop', async (c) => {
    const { slot } = (await c.req.json()) as { slot: number };
    if (Number.isInteger(slot) && slot >= 0 && slot < d.size.workers) d.pool.stop(slot);
    return c.json({ ok: true });
  });

  app.post('/v1/run', async (c) => {
    let run: Run;
    let bytes: Uint8Array;
    try {
      ({ head: run, bytes } = unframe<Run>(new Uint8Array(await c.req.arrayBuffer())));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    const { slot, drop, ask } = run;
    if (!Number.isInteger(slot) || slot < 0 || slot >= d.size.workers || !Array.isArray(drop)) return c.json({ error: 'No such worker.' }, 400);
    const answer = (head: Answered, out?: Uint8Array) => c.body(frame(head, out), 200, { 'content-type': 'application/octet-stream' });
    try {
      let body: Body;
      let transfer: ArrayBuffer[] = [];
      if (ask.type === 'load' || ask.type === 'say' || ask.type === 'sound') {
        const f = await files.ensure(ask.voice);
        const key = modelOfVoice(ask.voice);
        body = ask.type === 'load' ? { type: 'load', key, files: f } : { type: ask.type, key, files: f, text: ask.text, speed: ask.speed };
      } else if (ask.type === 'encode') {
        // A copy of its own, to hand to the worker.
        const audio = floats(bytes).slice();
        body = { type: 'encode', audio, rate: ask.rate };
        transfer = [audio.buffer as ArrayBuffer];
      } else if (ask.type === 'panels') {
        if (!d.panel) return answer({ ok: false, error: 'This engine hasn’t the panel model.' });
        body = await cut(bytes, d.panel.file);
        transfer = body.windows.map((x) => x.input.buffer as ArrayBuffer);
      } else {
        return c.json({ error: 'No such job.' }, 400);
      }
      const r = await d.pool.run(slot, body, transfer, drop);
      if (ask.type === 'say') return answer({ ok: true, samples: r.samples, rate: r.rate }, r.mp3);
      if (ask.type === 'sound') return answer({ ok: true, rate: r.rate }, bytesOf(r.audio!));
      if (ask.type === 'encode') return answer({ ok: true }, r.mp3);
      if (ask.type === 'panels') return answer({ ok: true, panels: r.panels, sure: r.sure, w: r.w, h: r.h });
      return answer({ ok: true });
    } catch (err) {
      return answer({ ok: false, error: err instanceof Error ? err.message : String(err), stopped: (err as { stopped?: boolean }).stopped });
    }
  });

  return app;
}
