import { existsSync, readFileSync, statSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { PagePanels } from '@breader/shared';
import type { Env } from '../env.ts';
import { log } from '../log.ts';
import type { Picture } from '../manga/disk.ts';
import { PAD, SIZE, fitOf, windows, type Fit } from './find.ts';
import type { Reply, Request } from './worker.ts';

/*
 * Manga panels found on the laptop with the panel model trained on the owner's labels
 * (ai/panels), for every browser signed in to a library: the app asks for a manga page's panels as
 * it fetches the page, and zooms on them itself. The model runs in a worker thread (worker.ts),
 * started when it's first needed and let go after ten quiet minutes. A page's panels are kept
 * once found, as its picture doesn't change.
 */

export interface Panels {
  /** The model's round (ai/panels/model/live.json). */
  round: number;
  /** A page's panels: found once, by its key, from its picture. */
  find(key: string, picture: () => Promise<Picture>): Promise<PagePanels>;
  close(): Promise<void>;
}

const IDLE_MS = 10 * 60_000;
/** Pages waiting beyond this many are turned away: the app finds those itself. */
const MOST_WAITING = 32;
/** Pages' panels kept, a few hundred bytes each. */
const KEPT = 5000;

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
    out.push({ input: squareOf(rgb, w, span, fit), fit, span });
  }
  return { w, h, windows: out };
}

/**
 * A window scaled into the model's square the way OpenCV's bilinear resize does it, as the model
 * was trained and checked on: each pixel from the four nearest, with no smoothing first. Another
 * resize moves the corners the model's less sure of by tens of pixels.
 */
function squareOf(rgb: Uint8Array, w: number, [top, bottom]: [number, number], fit: Fit): Float32Array {
  const plane = SIZE * SIZE;
  const input = new Float32Array(3 * plane).fill(PAD / 255);
  const sx = w / fit.w;
  const sy = (bottom - top) / fit.h;
  const last = bottom - top - 1;
  for (let y = 0; y < fit.h; y++) {
    const fy = Math.min(Math.max((y + 0.5) * sy - 0.5, 0), last);
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, last);
    const ay = fy - y0;
    const r0 = (top + y0) * w * 3;
    const r1 = (top + y1) * w * 3;
    const to = (y + fit.top) * SIZE + fit.left;
    for (let x = 0; x < fit.w; x++) {
      const fx = Math.min(Math.max((x + 0.5) * sx - 0.5, 0), w - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(x0 + 1, w - 1) * 3;
      const ax = fx - x0;
      const a = x0 * 3;
      for (let c = 0; c < 3; c++) {
        const v0 = rgb[r0 + a + c] * (1 - ax) + rgb[r0 + x1 + c] * ax;
        const v1 = rgb[r1 + a + c] * (1 - ax) + rgb[r1 + x1 + c] * ax;
        input[c * plane + to + x] = Math.round(v0 * (1 - ay) + v1 * ay) / 255;
      }
    }
  }
  return input;
}

export function makePanels(env: Env): Panels | null {
  const model = modelOf(env);
  if (!model) {
    log.warn('the panel model isn’t here, so the app finds panels itself');
    return null;
  }
  const threads = env.PANEL_THREADS ?? Math.max(1, Math.min(4, availableParallelism() - 1));
  let sharp: Promise<Sharp> | null = null;

  let worker: Worker | null = null;
  let next = 1;
  const pending = new Map<number, { w: Worker; resolve: (r: Extract<Reply, { ok: true }>) => void; reject: (e: Error) => void }>();
  let idle: NodeJS.Timeout | undefined;
  const kept = new Map<string, PagePanels>();
  const finding = new Map<string, Promise<PagePanels>>();

  function start() {
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
      if (worker === w) worker = null;
      for (const [id, p] of pending) {
        if (p.w !== w) continue;
        pending.delete(id);
        p.reject(new Error(`The panel model stopped (${code}).`));
      }
    });
    log.info({ threads, round: model!.round }, 'panel worker started');
    return w;
  }

  function call(req: Omit<Request, 'id'>): Promise<Extract<Reply, { ok: true }>> {
    worker ??= start();
    clearTimeout(idle);
    idle = setTimeout(() => {
      if (pending.size || !worker) return;
      log.info('panel worker idle, letting it go');
      void worker.terminate();
      worker = null;
    }, IDLE_MS);
    idle.unref();
    const id = next++;
    const w = worker;
    return new Promise((resolve, reject) => {
      pending.set(id, { w, resolve, reject });
      w.postMessage({ ...req, id }, req.windows.map((x) => x.input.buffer as ArrayBuffer));
    });
  }

  return {
    round: model.round,
    find(key, picture) {
      const had = kept.get(key);
      if (had) {
        // Used again, it's kept longest.
        kept.delete(key);
        kept.set(key, had);
        return Promise.resolve(had);
      }
      let p = finding.get(key);
      if (p) return p;
      if (finding.size >= MOST_WAITING) return Promise.reject(Object.assign(new Error('The panel model is busy.'), { busy: true }));
      p = (async () => {
        const pic = await picture();
        sharp ??= import('sharp').then((m) => m.default);
        const req = await windowsOf(await sharp, pic.data);
        const r = await call(req);
        const found: PagePanels = { round: model.round, w: req.w, h: req.h, panels: r.panels, sure: r.sure };
        kept.set(key, found);
        if (kept.size > KEPT) kept.delete(kept.keys().next().value!);
        return found;
      })();
      finding.set(key, p);
      p.then(() => finding.delete(key), () => finding.delete(key));
      return p;
    },
    async close() {
      clearTimeout(idle);
      await worker?.terminate();
      worker = null;
    },
  };
}
