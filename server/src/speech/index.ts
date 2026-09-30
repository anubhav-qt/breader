import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { Env } from '../env.ts';
import { log } from '../log.ts';
import { makeFiles, VOICES } from './files.ts';
import type { Reply, Request } from './worker.ts';

/*
 * The server voice: the laptop reads aloud for a phone that can't run a voice itself, a sentence
 * at a time, as the app asks (routes/speech.ts). The voices' files download the first time each is
 * wanted (files.ts), and the engine runs in a worker thread (worker.ts), started when it's first
 * needed and let go after ten quiet minutes, with the memory it holds.
 */

export interface Said {
  mp3: Uint8Array;
  /** The sound's length before it was made MP3, which pads it. */
  samples: number;
  rate: number;
}

export interface Speech {
  voices: string[];
  /**
   * Makes a voice ready, its files here and loaded, waiting up to `wait` ms. Not ready by then, it
   * carries on, and the app asks again, showing how much of its files has arrived.
   */
  ready(voice: string, wait: number): Promise<{ ready: boolean; loaded: number; total: number }>;
  say(voice: string, text: string, speed: number): Promise<Said>;
  close(): Promise<void>;
}

const IDLE_MS = 10 * 60_000;
/** Sentences waiting beyond this many are turned away: something is asking far faster than it listens. */
const MOST_WAITING = 24;

export function makeSpeech(env: Env): Speech {
  const files = makeFiles(env.SPEECH_DIR);
  const threads = env.SPEECH_THREADS ?? Math.max(1, Math.min(4, availableParallelism() - 1));

  let worker: Worker | null = null;
  let next = 1;
  const pending = new Map<number, { w: Worker; resolve: (r: Extract<Reply, { ok: true }>) => void; reject: (e: Error) => void }>();
  let idle: NodeJS.Timeout | undefined;

  /** A worker stopped: what it was asked fails, and nothing else. */
  const drop = (w: Worker, why: Error) => {
    for (const [id, p] of pending) {
      if (p.w !== w) continue;
      pending.delete(id);
      p.reject(why);
    }
  };

  function start() {
    // Bundled, this runs from dist/api.js and the worker is dist/speech/worker.js; from the source, it's next door.
    const file = import.meta.url.endsWith('.ts') ? new URL('./worker.ts', import.meta.url) : new URL('./speech/worker.js', import.meta.url);
    const w = new Worker(file, { workerData: { threads } });
    w.on('message', (r: Reply) => {
      const p = pending.get(r.id);
      if (!p) return;
      pending.delete(r.id);
      if (r.ok) p.resolve(r);
      else p.reject(new Error(r.error));
    });
    w.on('error', (err) => log.error({ err }, 'speech worker failed'));
    w.on('exit', (code) => {
      if (worker === w) worker = null;
      drop(w, new Error(`The voice stopped (${code}).`));
    });
    log.info({ threads }, 'speech worker started');
    return w;
  }

  function call(req: Request): Promise<Extract<Reply, { ok: true }>> {
    if (pending.size >= MOST_WAITING) return Promise.reject(Object.assign(new Error('The voice is busy.'), { busy: true }));
    worker ??= start();
    clearTimeout(idle);
    idle = setTimeout(() => {
      if (pending.size || !worker) return;
      log.info('speech worker idle, letting it go');
      void worker.terminate();
      worker = null;
    }, IDLE_MS);
    idle.unref();
    const id = next++;
    const w = worker;
    return new Promise((resolve, reject) => {
      pending.set(id, { w, resolve, reject });
      w.postMessage({ ...req, id });
    });
  }

  /** Voices being made ready, so asking again waits on the same work. */
  const readying = new Map<string, Promise<void>>();

  return {
    voices: VOICES,
    async ready(voice, wait) {
      let p = readying.get(voice);
      if (!p) {
        p = files.ensure(voice).then((f) => call({ type: 'load', key: voice, files: f })).then(() => undefined);
        readying.set(voice, p);
        // Done or failed, the next ask starts afresh: a let-go worker loads it again.
        p.then(() => readying.delete(voice), () => readying.delete(voice));
      }
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<false>((r) => { timer = setTimeout(() => r(false), wait); });
      try {
        const ready = await Promise.race([p.then(() => true as const), late]);
        return { ready, ...(await files.progress(voice)) };
      } finally {
        clearTimeout(timer);
      }
    },
    async say(voice, text, speed) {
      const f = await files.ensure(voice);
      const r = await call({ type: 'say', key: voice, files: f, text, speed });
      return { mp3: r.mp3!, samples: r.samples!, rate: r.rate! };
    },
    async close() {
      clearTimeout(idle);
      await worker?.terminate();
      worker = null;
    },
  };
}
