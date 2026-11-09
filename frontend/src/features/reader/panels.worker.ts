/// <reference lib="webworker" />
import type { InferenceSession } from 'onnxruntime-web';
import { findPanels, takesOf, type Takes } from '@breader/shared/panels';
import { hosted, load, type Want } from './voice/store';

/*
 * The panel model on this device (panelModel.ts), off the page's thread: the same model and the
 * same reading of its answers as the laptop's (server panels/, shared panels.ts). On the graphics
 * chip where the browser lends it (WebGPU), and on the processor otherwise, a thread of it, as more
 * would need a cross-origin isolated page, which would break covers and logins.
 *
 * A page is read as the labeller's guesser reads it (ai/panels/model/guess.py): its pixels as they
 * are in the file, as OpenCV opens it, with no colour profile applied; and, for a model that takes
 * any size, in the least rectangle round it, not the square.
 */

type Ort = typeof import('onnxruntime-web');

export type PanelsWork =
  | { type: 'start'; model: Want }
  /** The page's picture: its file, opened here, or the picture itself. */
  | { type: 'find'; pic: Blob | ImageBitmap };
export type PanelsAsk = PanelsWork & { id: number };

export type PanelsReply =
  | { id: number; ok: true; gpu?: boolean; w?: number; h?: number; panels?: Array<Array<[number, number]>>; sure?: number[] }
  | { id: number; ok: false; error: string }
  | { id: number; bytes: number };

const scope = self as unknown as DedicatedWorkerGlobalScope;
let ort: Ort | null = null;
let session: InferenceSession | null = null;
/** How the model takes its pictures (shared takesOf). */
let takes: Takes = takesOf(undefined);
/**
 * On the graphics chip, a model that takes any size is about a third faster made for one size
 * (measured in Chrome: 107 ms a page, not 152), with the same answers, but making one takes about
 * 2 seconds, where the model as it came takes a new size at no cost. So pages are read with the
 * model as it came, and once a size has come AFTER times (a chapter's pages are mostly one or two
 * sizes), one is made for it while no page waits, and used for that size from then on: one at a
 * time, so the chip holds the model twice at most.
 */
const AFTER = 3;
let anySize: { onnx: Uint8Array; names: Array<number | string> } | null = null;
let own: { key: string; s: InferenceSession } | null = null;
const counts = new Map<string, number>();
let wanted: { key: string; fix: Record<string, number> } | null = null;
/** Sizes one couldn't be made for, not tried again. */
const cannot = new Set<string>();

/** The model's input's shape, where the runtime says it. */
const shapeOf = (s: InferenceSession) => {
  const m = s.inputMetadata?.[0];
  return m && m.isTensor ? m.shape : undefined;
};

async function start(id: number, model: Want) {
  const gpu = !!(await (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu?.requestAdapter().catch(() => null));
  let bytes = 0;
  const heard = (n: number) => {
    bytes += n;
    scope.postMessage({ id, bytes } satisfies PanelsReply);
  };
  const [wasm, onnx] = await Promise.all([load(hosted(gpu ? 'ort-gpu' : 'ort-cpu')), load(model, heard)]);
  ort = gpu ? await import('onnxruntime-web/webgpu') : await import('onnxruntime-web/wasm');
  ort.env.wasm.wasmBinary = wasm.buffer as ArrayBuffer;
  ort.env.wasm.numThreads = 1;
  ort.env.logLevel = 'error';
  if (gpu) {
    try {
      session = await ort.InferenceSession.create(onnx, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all', logSeverityLevel: 3 });
      const shape = shapeOf(session);
      takes = takesOf(shape);
      if (takes.rect && shape) anySize = { onnx, names: [...shape] };
      return { gpu: true };
    } catch (e) {
      console.warn('The panel model couldn’t start on WebGPU:', e);
    }
  }
  session = await ort.InferenceSession.create(onnx, { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 });
  takes = takesOf(shapeOf(session));
  return { gpu: false };
}

/** The model to run k windows fitted as `fit` on: the one made for that size, where there is one. */
function sessionFor(k: number, fit: { wide: number; tall: number }): InferenceSession {
  if (!anySize) return session!;
  const key = `${k} ${fit.tall} ${fit.wide}`;
  if (own?.key === key) return own.s;
  if (cannot.has(key)) return session!;
  if (counts.size > 100) counts.clear();
  const n = (counts.get(key) ?? 0) + 1;
  counts.set(key, n);
  if (n >= AFTER) {
    const fix: Record<string, number> = {};
    const [batch, , tall, wide] = anySize.names;
    for (const [name, v] of [[batch, k], [tall, fit.tall], [wide, fit.wide]] as const) if (typeof name === 'string') fix[name] = v;
    wanted = { key, fix };
  }
  return session!;
}

/** The model made for the size wanted, in place of the one made before. */
async function makeWanted() {
  const w = wanted;
  wanted = null;
  if (!w || !ort || !anySize || own?.key === w.key) return;
  const old = own;
  own = null;
  await old?.s.release().catch(() => {});
  try {
    const s = await ort.InferenceSession.create(anySize.onnx, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all', logSeverityLevel: 3, freeDimensionOverrides: w.fix });
    own = { key: w.key, s };
  } catch (e) {
    cannot.add(w.key);
    console.warn('The panel model couldn’t be made for one size:', e);
  }
}

async function find(sent: Blob | ImageBitmap) {
  if (!ort || !session) throw new Error('The panel model hasn’t started.');
  let pic = sent;
  // As OpenCV opens it: no colour profile, colours not mixed with how see-through they are.
  if (pic instanceof Blob) pic = await createImageBitmap(pic, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const { width: w, height: h } = pic;
  const canvas = new OffscreenCanvas(w, h);
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (!g) throw new Error('No canvas to read the page from.');
  g.drawImage(pic, 0, 0);
  pic.close();
  const px = g.getImageData(0, 0, w, h).data;
  // What the picture leaves clear, a canvas keeps no colour for: white, as the guesser's OpenCV has a GIF's.
  for (let i = 3; i < px.length; i += 4) if (px[i] === 0) px[i - 3] = px[i - 2] = px[i - 1] = 255;
  const found = await findPanels(px, w, h, 4, takes, async (data, k, fit) => {
    const s = sessionFor(k, fit);
    const input = new ort!.Tensor('float32', data, [k, 3, fit.tall, fit.wide]);
    const out = await s.run({ [s.inputNames[0]]: input });
    const t = out[s.outputNames[0]];
    // Off the graphics chip, if it's there.
    const got = ((await t.getData()) as Float32Array).slice();
    const n = t.dims[2];
    t.dispose();
    input.dispose();
    return { out: got, n };
  });
  return { w, h, ...found };
}

/** Pages one after another: the engine runs one at a time. And how many are waiting. */
let line: Promise<unknown> = Promise.resolve();
let waiting = 0;

scope.onmessage = (e: MessageEvent<PanelsAsk>) => {
  const m = e.data;
  waiting += 1;
  line = line
    .then((): Promise<object> => (m.type === 'start' ? start(m.id, m.model) : find(m.pic)))
    .then(
      (r) => scope.postMessage({ id: m.id, ok: true, ...r } satisfies PanelsReply),
      (err: unknown) => scope.postMessage({ id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies PanelsReply),
    )
    .then(() => {
      waiting -= 1;
      // Nothing waiting: the time to make the model for a size that keeps coming.
      if (!waiting && wanted) line = line.then(makeWanted);
    });
};
