import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import * as ort from 'onnxruntime-web';
import { SIZE, merged, ordered, panelsIn, type Fit } from './find.ts';

/*
 * Finds a manga page's panels with the panel model on the laptop, in a thread of its own so the
 * API keeps answering. One page at a time, as the model can't run twice at once. It's about a
 * second a page on four threads of a laptop, and holds about 300 MB while it's open.
 */

export interface Request {
  id: number;
  w: number;
  h: number;
  /** Each window of the page as the model sees it, its square's pixels, and where it came from. */
  windows: Array<{ input: Float32Array; fit: Fit; span: [number, number] }>;
}

export type Reply =
  | { id: number; ok: true; panels: Array<Array<[number, number]>>; sure: number[] }
  | { id: number; ok: false; error: string };

const { threads, model } = workerData as { threads: number; model: string };

// Bundled (dist/panels/worker.js), the engine's own files sit in dist/ort; from the source, it finds them itself.
const bundled = new URL('../ort/', import.meta.url);
if (existsSync(new URL('ort-wasm-simd-threaded.wasm', bundled))) {
  ort.env.wasm.wasmPaths = {
    mjs: new URL('ort-wasm-simd-threaded.mjs', bundled).href,
    wasm: new URL('ort-wasm-simd-threaded.wasm', bundled).href,
  };
}
ort.env.wasm.numThreads = threads;
ort.env.logLevel = 'error';

let session: Promise<ort.InferenceSession> | null = null;
const open = () => (session ??= readFile(model).then((b) => ort.InferenceSession.create(b, { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 })));

async function find(req: Request) {
  const s = await open();
  const found = [];
  for (const [k, win] of req.windows.entries()) {
    const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', win.input, [1, 3, SIZE, SIZE]) });
    const t = out[s.outputNames[0]];
    const n = t.dims[2];
    found.push(...panelsIn(t.data as Float32Array, n, win.fit, win.span, k === req.windows.length - 1, k === 0, req.w, req.h));
    t.dispose();
  }
  const panels = ordered(req.windows.length > 1 ? merged(found) : found, req.w, req.h);
  return { panels: panels.map((p) => p.quad), sure: panels.map((p) => Math.round(p.sure * 1000) / 1000) };
}

/** Pages one after another: the engine runs one at a time. */
let line: Promise<unknown> = Promise.resolve();

parentPort!.on('message', (req: Request) => {
  line = line.then(() => find(req)).then(
    (r) => parentPort!.postMessage({ id: req.id, ok: true, ...r } satisfies Reply),
    (err: unknown) => parentPort!.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies Reply),
  );
});
