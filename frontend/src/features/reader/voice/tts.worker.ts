/// <reference lib="webworker" />
import type { InferenceSession, Tensor } from 'onnxruntime-web';
import { KOKORO_PACK_BYTES, KOKORO_RATE, kokoroInput, piperInput, type PiperConfig } from '@breader/shared/speech';
import { hosted, load, type Want } from './store';

/*
 * Turns sentences into sound, off the page's thread. One worker runs one engine:
 *
 *   piper   Normal mode. VITS voices, one model per voice, on the CPU (WebAssembly).
 *   kokoro  Immersive. One model for every voice, each voice a 510 × 256 table of styles, on the GPU.
 *
 * The page sends requests with an id and gets one reply per id, plus progress while files load.
 */

type Ort = typeof import('onnxruntime-web');

export type { PiperConfig };

export type Request =
  | { type: 'start'; engine: 'piper' | 'kokoro' }
  /**
   * Loads a voice's files: Piper's model and settings, and its speaker in a model of several; or a
   * Kokoro pack (and the model, once), and a second one to blend it with half and half.
   */
  | { type: 'voice'; key: string; model?: Want; config?: Want; speaker?: number; pack?: Want; mix?: Want; british?: boolean }
  | { type: 'say'; key: string; text: string; speed: number }
  /** Lets go of a voice: one tried out before it was uploaded. */
  | { type: 'forget'; key: string };

export type Reply =
  | { id: number; ok: true; audio?: Float32Array; rate?: number }
  | { id: number; ok: false; error: string; gpu?: boolean }
  | { id: number; progress: { name: string; bytes: number } };

const scope = self as unknown as DedicatedWorkerGlobalScope;
let ort: Ort | null = null;
let engine: 'piper' | 'kokoro' = 'piper';
/** Kokoro's one model. */
let kokoro: InferenceSession | null = null;
const voices = new Map<string, { session?: InferenceSession; model?: string; config?: PiperConfig; speaker?: number; pack?: Float32Array; british?: boolean }>();
/** Piper's models, by file: the speakers of one model share it. */
const sessions = new Map<string, InferenceSession>();

const post = (r: Reply, transfer: Transferable[] = []) => scope.postMessage(r, transfer);

async function fetchAll(id: number, wants: Want[]) {
  return Promise.all(wants.map((w) => load(w, (bytes) => post({ id, progress: { name: w.name, bytes } }))));
}

async function start(id: number, which: 'piper' | 'kokoro') {
  engine = which;
  // Asked before anything downloads: a browser can have WebGPU and no graphics chip to lend it.
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
  if (which === 'kokoro' && !(await gpu?.requestAdapter().catch(() => null))) throw Object.assign(new Error('This browser can’t run Immersive voices.'), { gpu: true });
  const [wasm] = await fetchAll(id, [hosted(which === 'kokoro' ? 'ort-gpu' : 'ort-cpu')]);
  ort = which === 'kokoro' ? await import('onnxruntime-web/webgpu') : await import('onnxruntime-web/wasm');
  ort.env.wasm.wasmBinary = wasm.buffer as ArrayBuffer;
  // More threads need a cross-origin isolated page, which would break covers and logins.
  ort.env.wasm.numThreads = 1;
  ort.env.logLevel = 'error';
  if (which === 'kokoro') {
    const [model] = await fetchAll(id, [hosted('kokoro')]);
    try {
      kokoro = await ort.InferenceSession.create(model, { executionProviders: ['webgpu'], logSeverityLevel: 3 });
    } catch (e) {
      console.warn('Kokoro couldn’t start on WebGPU:', e);
      throw Object.assign(new Error('Immersive voices couldn’t start on this device’s graphics chip.'), { gpu: true });
    }
  }
}

async function loadVoice(id: number, m: Extract<Request, { type: 'voice' }>) {
  if (voices.has(m.key)) return;
  if (!ort) throw new Error('The voice engine hasn’t started.');
  if (engine === 'kokoro') {
    const wants = [m.pack!];
    if (m.mix) wants.push(m.mix);
    const packs = await fetchAll(id, wants);
    for (const b of packs) if (b.byteLength !== KOKORO_PACK_BYTES) throw new Error('That isn’t a Kokoro voice pack.');
    const pack = new Float32Array(packs[0].buffer, packs[0].byteOffset, packs[0].byteLength / 4);
    if (!m.mix) {
      voices.set(m.key, { pack, british: !!m.british });
      return;
    }
    // A blend: the two packs averaged, style by style.
    const other = new Float32Array(packs[1].buffer, packs[1].byteOffset, packs[1].byteLength / 4);
    const both = new Float32Array(pack.length);
    for (let i = 0; i < pack.length; i++) both[i] = (pack[i] + other[i]) / 2;
    voices.set(m.key, { pack: both, british: !!m.british });
    return;
  }
  const model = m.model!.name;
  let session = sessions.get(model);
  const [config] = await fetchAll(id, [m.config!]);
  const cfg = JSON.parse(new TextDecoder().decode(config)) as PiperConfig;
  if (!cfg.phoneme_id_map || !cfg.audio?.sample_rate) throw new Error('That isn’t a Piper voice’s .onnx.json.');
  if (!session) {
    const [bytes] = await fetchAll(id, [m.model!]);
    session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 });
    sessions.set(model, session);
  }
  voices.set(m.key, { session, model, config: cfg, speaker: m.speaker ?? 0 });
}

/** Lets go of a voice, and of its model once no other speaker of it is held. */
async function forget(key: string) {
  const v = voices.get(key);
  voices.delete(key);
  if (!v?.session) return;
  for (const other of voices.values()) if (other.session === v.session) return;
  sessions.delete(v.model!);
  await v.session.release();
}

const int64 = (ids: number[]) => BigInt64Array.from(ids, (n) => BigInt(n));

async function say(m: Extract<Request, { type: 'say' }>): Promise<{ audio: Float32Array; rate: number }> {
  const v = voices.get(m.key);
  if (!v || !ort) throw new Error('That voice isn’t loaded.');
  const T = ort.Tensor;
  if (engine === 'kokoro') {
    const { ids, style } = await kokoroInput(m.text, !!v.british, v.pack!);
    const out = await kokoro!.run({
      input_ids: new T('int64', int64(ids), [1, ids.length]),
      style: new T('float32', style, [1, 256]),
      speed: new T('float32', new Float32Array([m.speed]), [1]),
    });
    return { audio: new Float32Array((out.waveform as Tensor).data as Float32Array), rate: KOKORO_RATE };
  }
  const cfg = v.config!;
  const { ids, scales, speakers } = await piperInput(m.text, cfg, m.speed);
  const feeds: Record<string, Tensor> = {
    input: new T('int64', int64(ids), [1, ids.length]),
    input_lengths: new T('int64', int64([ids.length]), [1]),
    scales: new T('float32', new Float32Array(scales), [3]),
  };
  if (speakers > 1) feeds.sid = new T('int64', int64([v.speaker ?? 0]), [1]);
  const out = await v.session!.run(feeds);
  // A copy: the result may sit in memory the engine reuses, which can't be handed to the page.
  return { audio: new Float32Array((out[v.session!.outputNames[0]] as Tensor).data as Float32Array), rate: cfg.audio.sample_rate };
}

async function handle(m: Request & { id: number }) {
  try {
    if (m.type === 'start') await start(m.id, m.engine);
    else if (m.type === 'voice') await loadVoice(m.id, m);
    else if (m.type === 'forget') await forget(m.key);
    else {
      const { audio, rate } = await say(m);
      post({ id: m.id, ok: true, audio, rate }, [audio.buffer]);
      return;
    }
    post({ id: m.id, ok: true });
  } catch (err) {
    post({ id: m.id, ok: false, error: err instanceof Error ? err.message : String(err), gpu: !!(err as { gpu?: boolean })?.gpu });
  }
}

// One request at a time: a model can't run twice at once.
let queue = Promise.resolve();
scope.onmessage = (e: MessageEvent<Request & { id: number }>) => {
  queue = queue.then(() => handle(e.data));
};
