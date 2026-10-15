import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import * as ort from 'onnxruntime-web';
import { SIZE, pagePanels, type Fit } from '@breader/shared/panels';

/*
 * Finds a manga page's panels with the panel model on the laptop, in a thread of its own so the
 * API keeps answering. One page at a time, as the model can't run twice at once. It's about 0.4 s
 * a page on four threads of a Ryzen 7 9800X3D, and about a second on the laptop's Ryzen 7 5800U,
 * and holds about 300 MB while it's open.
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
  const outs = [];
  for (const win of req.windows) {
    const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', win.input, [1, 3, SIZE, SIZE]) });
    const t = out[s.outputNames[0]];
    outs.push({ out: (t.data as Float32Array).slice(), n: t.dims[2], fit: win.fit, span: win.span });
    t.dispose();
  }
  return pagePanels(outs, req.w, req.h);
}

/** Pages one after another: the engine runs one at a time. */
let line: Promise<unknown> = Promise.resolve();

parentPort!.on('message', (req: Request) => {
  line = line.then(() => find(req)).then(
    (r) => parentPort!.postMessage({ id: req.id, ok: true, ...r } satisfies Reply),
    (err: unknown) => parentPort!.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies Reply),
  );
});
