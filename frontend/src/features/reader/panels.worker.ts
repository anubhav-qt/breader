/// <reference lib="webworker" />
import type { InferenceSession } from 'onnxruntime-web';
import { SIZE, fitOf, pagePanels, squareOf, windows } from '@breader/shared/panels';
import { hosted, load, type Want } from './voice/store';

/*
 * The panel model on this device (panelModel.ts), off the page's thread: the same model and the
 * same reading of its answers as the laptop's (server panels/, shared panels.ts). On the graphics
 * chip where the browser lends it (WebGPU), and on the processor otherwise, a thread of it, as more
 * would need a cross-origin isolated page, which would break covers and logins.
 */

type Ort = typeof import('onnxruntime-web');

export type PanelsWork =
  | { type: 'start'; model: Want }
  | { type: 'find'; pic: ImageBitmap };
export type PanelsAsk = PanelsWork & { id: number };

export type PanelsReply =
  | { id: number; ok: true; gpu?: boolean; w?: number; h?: number; panels?: Array<Array<[number, number]>> }
  | { id: number; ok: false; error: string }
  | { id: number; bytes: number };

const scope = self as unknown as DedicatedWorkerGlobalScope;
let ort: Ort | null = null;
let session: InferenceSession | null = null;

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
      return { gpu: true };
    } catch (e) {
      console.warn('The panel model couldn’t start on WebGPU:', e);
    }
  }
  session = await ort.InferenceSession.create(onnx, { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 });
  return { gpu: false };
}

async function find(pic: ImageBitmap) {
  if (!ort || !session) throw new Error('The panel model hasn’t started.');
  const { width: w, height: h } = pic;
  const canvas = new OffscreenCanvas(w, h);
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (!g) throw new Error('No canvas to read the page from.');
  g.drawImage(pic, 0, 0);
  pic.close();
  const px = g.getImageData(0, 0, w, h).data;
  const outs = [];
  for (const span of windows(w, h)) {
    const fit = fitOf(w, span[1] - span[0]);
    const input = new ort.Tensor('float32', squareOf(px, w, 4, span, fit), [1, 3, SIZE, SIZE]);
    const out = await session.run({ [session.inputNames[0]]: input });
    const t = out[session.outputNames[0]];
    // Off the graphics chip, if it's there.
    const data = (await t.getData()) as Float32Array;
    outs.push({ out: data.slice(), n: t.dims[2], fit, span });
    t.dispose();
    input.dispose();
  }
  return { w, h, ...pagePanels(outs, w, h) };
}

/** Pages one after another: the engine runs one at a time. */
let line: Promise<unknown> = Promise.resolve();

scope.onmessage = (e: MessageEvent<PanelsAsk>) => {
  const m = e.data;
  line = line.then((): Promise<object> => (m.type === 'start' ? start(m.id, m.model) : find(m.pic))).then(
    (r) => scope.postMessage({ id: m.id, ok: true, ...r } satisfies PanelsReply),
    (err: unknown) => scope.postMessage({ id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies PanelsReply),
  );
};
