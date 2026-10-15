import { existsSync, readFileSync, statSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { PagePanels } from '@breader/shared';
import { fitOf, squareOf, windows } from '@breader/shared/panels';
import type { Env } from '../env.ts';
import { log } from '../log.ts';
import type { Picture } from '../manga/disk.ts';
import { makeSeats, type Seats } from './seats.ts';
import type { Reply, Request } from './worker.ts';

/*
 * Manga panels found on the laptop with the panel model trained on the owner's labels
 * (ai/panels), for any reader who takes one of its seats (seats.ts): the app asks for a page's
 * panels as it fetches the page, and zooms on them itself. The model runs in worker threads
 * (worker.ts), started when they're first needed and let go after ten quiet minutes. A page's
 * panels are kept once found, as its picture doesn't change.
 *
 * Readers take turns: each one's pages wait in a line of their own, and the workers take the next
 * page from each line in turn, so a chapter opened by one doesn't hold up a page another is on.
 */

export interface Panels {
  /** The model's round (ai/panels/model/live.json). */
  round: number;
  seats: Seats;
  /** A page's panels: found once, by its key, from its picture, in `who`'s turn. */
  find(key: string, picture: () => Promise<Picture>, who?: string): Promise<PagePanels>;
  close(): Promise<void>;
}

const IDLE_MS = 10 * 60_000;
/** A reader's pages waiting beyond this many are turned away: the app finds those itself. */
const MOST_WAITING = 32;
/** Pages' panels kept, a few hundred bytes each. */
const KEPT = 5000;
/** Pages each worker has at once: one it's on, and the next made ready meanwhile. */
const DEPTH = 2;

type Sharp = (typeof import('sharp'))['default'];

/** The model and its round: beside the bundle in the image (Dockerfile), or in ai/panels from the source. */
function modelOf(env: Env): { file: string; round: number } | null {
  const fromSource = import.meta.url.endsWith('.ts');
  const file = env.PANEL_MODEL ?? fileURLToPath(new URL(fromSource ? '../../../ai/panels/model/live.onnx' : '../panels/live.onnx', import.meta.url));
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

/** The picture as the model sees it: each window letterboxed into its square, as channels of 0 to 1. */
async function windowsOf(sharp: Sharp, data: Uint8Array): Promise<Omit<Request, 'id'>> {
  const { data: rgb, info } = await sharp(data).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels } = info;
  if (channels !== 3) throw new Error(`The page came out with ${channels} channels.`);
  const out: Request['windows'] = [];
  for (const span of windows(w, h)) {
    const fit = fitOf(w, span[1] - span[0]);
    out.push({ input: squareOf(rgb, w, 3, span, fit), fit, span });
  }
  return { w, h, windows: out };
}

export function makePanels(env: Env): Panels | null {
  const model = modelOf(env);
  if (!model) {
    log.warn('the panel model isn’t here, so the app finds panels itself');
    return null;
  }
  const threads = env.PANEL_THREADS ?? Math.max(1, Math.min(4, availableParallelism() - 1));
  const workers = env.PANEL_WORKERS;
  const seats = makeSeats(env.PANEL_SEATS);
  let sharp: Promise<Sharp> | null = null;

  interface Job { key: string; picture: () => Promise<Picture>; resolve: (p: PagePanels) => void; reject: (e: Error) => void }
  interface Slot { w: Worker | null; busy: number }
  const slots: Slot[] = Array.from({ length: workers }, () => ({ w: null, busy: 0 }));
  /** Each reader's pages waiting, in the order the readers take turns. */
  const lines = new Map<string, Job[]>();
  let next = 1;
  const pending = new Map<number, { w: Worker; resolve: (r: Extract<Reply, { ok: true }>) => void; reject: (e: Error) => void }>();
  let idle: NodeJS.Timeout | undefined;
  const kept = new Map<string, PagePanels>();
  const finding = new Map<string, Promise<PagePanels>>();

  function start(slot: Slot) {
    // Bundled, this runs from dist/api.js and the worker is dist/panels/worker.js; from the source, it's next door.
    const file = import.meta.url.endsWith('.ts') ? new URL('./worker.ts', import.meta.url) : new URL('./panels/worker.js', import.meta.url);
    const w = new Worker(file, { workerData: { threads, model: model!.file } });
    w.on('message', (r: Reply) => {
      const p = pending.get(r.id);
      if (!p) return;
      pending.delete(r.id);
      if (r.ok) p.resolve(r);
      else p.reject(new Error(r.error));
    });
    w.on('error', (err) => log.error({ err }, 'panel worker failed'));
    w.on('exit', (code) => {
      if (slot.w === w) slot.w = null;
      for (const [id, p] of pending) {
        if (p.w !== w) continue;
        pending.delete(id);
        p.reject(new Error(`The panel model stopped (${code}).`));
      }
    });
    log.info({ threads, workers, round: model!.round }, 'panel worker started');
    return w;
  }

  /** Lets the workers go once nothing's come for a while. */
  function rest() {
    clearTimeout(idle);
    idle = setTimeout(() => {
      if (pending.size || slots.some((s) => s.busy)) return;
      log.info('panel workers idle, letting them go');
      for (const s of slots) {
        void s.w?.terminate();
        s.w = null;
      }
    }, IDLE_MS);
    idle.unref();
  }

  function call(slot: Slot, req: Omit<Request, 'id'>): Promise<Extract<Reply, { ok: true }>> {
    slot.w ??= start(slot);
    const id = next++;
    const w = slot.w;
    return new Promise((resolve, reject) => {
      pending.set(id, { w, resolve, reject });
      w.postMessage({ ...req, id }, req.windows.map((x) => x.input.buffer as ArrayBuffer));
    });
  }

  async function run(slot: Slot, job: Job) {
    try {
      const pic = await job.picture();
      sharp ??= import('sharp').then((m) => m.default);
      const req = await windowsOf(await sharp, pic.data);
      const r = await call(slot, req);
      const found: PagePanels = { round: model!.round, w: req.w, h: req.h, panels: r.panels, sure: r.sure };
      kept.set(job.key, found);
      if (kept.size > KEPT) kept.delete(kept.keys().next().value!);
      job.resolve(found);
    } catch (err) {
      job.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Gives each worker with room the next reader's next page. */
  function pump() {
    for (;;) {
      const slot = slots.reduce((a, b) => (b.busy < a.busy ? b : a));
      if (slot.busy >= DEPTH) return;
      const first = lines.entries().next();
      if (first.done) return;
      const [who, line] = first.value;
      const job = line.shift()!;
      // The reader's turn is over: to the back of the line, if there's more of theirs.
      lines.delete(who);
      if (line.length) lines.set(who, line);
      slot.busy++;
      rest();
      void run(slot, job).finally(() => {
        slot.busy--;
        rest();
        pump();
      });
    }
  }

  return {
    round: model.round,
    seats,
    find(key, picture, who = '') {
      const had = kept.get(key);
      if (had) {
        // Used again, it's kept longest.
        kept.delete(key);
        kept.set(key, had);
        return Promise.resolve(had);
      }
      let p = finding.get(key);
      if (p) return p;
      const line = lines.get(who) ?? [];
      if (line.length >= MOST_WAITING) return Promise.reject(Object.assign(new Error('The panel model is busy.'), { busy: true }));
      p = new Promise<PagePanels>((resolve, reject) => {
        line.push({ key, picture, resolve, reject });
        if (!lines.has(who)) lines.set(who, line);
      });
      finding.set(key, p);
      p.then(() => finding.delete(key), () => finding.delete(key));
      pump();
      return p;
    },
    async close() {
      clearTimeout(idle);
      seats.close();
      await Promise.all(slots.map((s) => s.w?.terminate()));
      for (const s of slots) s.w = null;
    },
  };
}
