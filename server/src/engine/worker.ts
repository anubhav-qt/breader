import { readFile } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { Mp3Encoder } from '@breezystack/lamejs';
import * as ort from 'onnxruntime-node';
import { KOKORO_PACK_BYTES, KOKORO_RATE, kokoroInput, piperInput, type PiperConfig } from '@breader/shared/speech';
import { SIZE, pagePanels, type Fit } from '@breader/shared/panels';
import type { VoiceFiles } from '../speech/files.ts';
import { PANELS } from './models.ts';

/*
 * One of the engine's workers (ADR 0002): a thread of its own, so the API keeps answering, that runs
 * any model job it's given, one at a time, as ONNX Runtime's native run holds its thread till it's
 * done. It holds the models its jobs needed until the engine (scheduler.ts) tells it to let go.
 *
 * Voices: the same engine and text-to-sounds steps as the voices in the browser (frontend
 * voice/tts.worker.ts), so a voice sounds alike either way, answered as MP3 (about a seventh of the
 * raw sound's bytes) for phones on mobile data. Panels: the panel model trained on the owner's
 * labels (ai/panels), on a page's windows as the API cut them (panels/index.ts).
 *
 * Measured on a Ryzen 7 9800X3D, 2 threads: a Kokoro sentence about 1.7 s while three others run,
 * a Piper one about 90 ms, a panel window about 110 ms. Held: Kokoro about 750 MB (one model for
 * all its voices), a Piper voice about 250 MB, the panel model about 500 MB.
 */

/** Voices name their model by `key` (models.ts), which may speak for several of them. */
export type Body =
  | { type: 'load'; key: string; files: VoiceFiles }
  | { type: 'say'; key: string; files: VoiceFiles; text: string; speed: number }
  /** An audiobook's sentence, as sound, to be put together with the rest of its paragraph. */
  | { type: 'sound'; key: string; files: VoiceFiles; text: string; speed: number }
  /** An audiobook's paragraph, put together, as MP3. */
  | { type: 'encode'; audio: Float32Array; rate: number }
  /** A page's panels: each window as the model sees it, its square's pixels, and where it came from. */
  | { type: 'panels'; model: string; w: number; h: number; windows: Array<{ input: Float32Array; fit: Fit; span: [number, number] }> };

export interface Message {
  id: number;
  body: Body;
  /** Models to let go of first. */
  drop: string[];
}

export interface Answer {
  mp3?: Uint8Array;
  audio?: Float32Array;
  samples?: number;
  rate?: number;
  panels?: Array<Array<[number, number]>>;
  sure?: number[];
  /** The page's size, with its panels. */
  w?: number;
  h?: number;
}

export type Reply = { id: number; ok: true; answer: Answer } | { id: number; ok: false; error: string };

/** MP3 at this many kilobits a second: clear for speech, about 22 MB an hour. */
const KBPS = 48;

const { threads } = workerData as { threads: number };

const sessions = new Map<string, Promise<ort.InferenceSession>>();
const configs = new Map<string, Promise<PiperConfig>>();
/** Kokoro's voice packs, by their files: small (0.5 MB), let go with the model. */
const packs = new Map<string, Promise<Float32Array>>();

const open = (key: string, file: string) => {
  let s = sessions.get(key);
  if (!s) {
    s = ort.InferenceSession.create(file, {
      executionProviders: ['cpu'],
      intraOpNumThreads: threads,
      interOpNumThreads: 1,
      graphOptimizationLevel: 'all',
      logSeverityLevel: 3,
    });
    sessions.set(key, s);
    // One that failed to open is tried afresh next time.
    s.catch(() => sessions.delete(key));
  }
  return s;
};

async function drop(keys: string[]) {
  for (const key of keys) {
    const s = sessions.get(key);
    sessions.delete(key);
    configs.delete(key);
    if (key === 'kokoro') packs.clear();
    await s?.then((x) => x.release()).catch(() => {});
  }
}

async function packOf(file: string) {
  const b = await readFile(file);
  if (b.byteLength !== KOKORO_PACK_BYTES) throw new Error('That isn’t a Kokoro voice pack.');
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

/** A Kokoro voice's pack: its own, or a blend's two averaged, style by style. */
function kokoroPack(files: Extract<VoiceFiles, { engine: 'kokoro' }>) {
  const key = `${files.pack}\n${files.mix ?? ''}`;
  let p = packs.get(key);
  if (!p) {
    p = (async () => {
      const one = await packOf(files.pack);
      if (!files.mix) return one;
      const other = await packOf(files.mix);
      const both = new Float32Array(one.length);
      for (let i = 0; i < one.length; i++) both[i] = (one[i] + other[i]) / 2;
      return both;
    })();
    packs.set(key, p);
    p.catch(() => packs.delete(key));
  }
  return p;
}

function piperConfig(key: string, files: Extract<VoiceFiles, { engine: 'piper' }>) {
  let c = configs.get(key);
  if (!c) {
    c = readFile(files.config, 'utf8').then((t) => JSON.parse(t) as PiperConfig);
    configs.set(key, c);
    c.catch(() => configs.delete(key));
  }
  return c;
}

async function load(key: string, files: VoiceFiles) {
  await open(key, files.model);
  if (files.engine === 'kokoro') await kokoroPack(files);
  else await piperConfig(key, files);
}

const int64 = (ids: number[]) => BigInt64Array.from(ids, (n) => BigInt(n));

async function sound(key: string, files: VoiceFiles, text: string, speed: number): Promise<{ audio: Float32Array; rate: number }> {
  const s = await open(key, files.model);
  if (files.engine === 'kokoro') {
    const { ids, style } = await kokoroInput(text, files.british, await kokoroPack(files));
    const out = await s.run({
      input_ids: new ort.Tensor('int64', int64(ids), [1, ids.length]),
      style: new ort.Tensor('float32', style, [1, 256]),
      speed: new ort.Tensor('float32', new Float32Array([speed]), [1]),
    });
    return { audio: (out.waveform as ort.Tensor).data as Float32Array, rate: KOKORO_RATE };
  }
  const config = await piperConfig(key, files);
  const { ids, scales, speakers } = await piperInput(text, config, speed);
  const feeds: Record<string, ort.Tensor> = {
    input: new ort.Tensor('int64', int64(ids), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', int64([ids.length]), [1]),
    scales: new ort.Tensor('float32', new Float32Array(scales), [3]),
  };
  if (speakers > 1) feeds.sid = new ort.Tensor('int64', int64([files.speaker ?? 0]), [1]);
  const out = await s.run(feeds);
  return { audio: (out[s.outputNames[0]] as ort.Tensor).data as Float32Array, rate: config.audio.sample_rate };
}

function mp3(audio: Float32Array, rate: number) {
  const pcm = new Int16Array(audio.length);
  for (let i = 0; i < audio.length; i++) pcm[i] = Math.max(-1, Math.min(1, audio[i])) * 0x7fff;
  const enc = new Mp3Encoder(1, rate, KBPS);
  const parts: Uint8Array[] = [];
  for (let i = 0; i < pcm.length; i += 1152) parts.push(enc.encodeBuffer(pcm.subarray(i, i + 1152)));
  parts.push(enc.flush());
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function panels(b: Extract<Body, { type: 'panels' }>) {
  const s = await open(PANELS, b.model);
  const outs = [];
  for (const win of b.windows) {
    const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', win.input, [1, 3, SIZE, SIZE]) });
    const t = out[s.outputNames[0]] as ort.Tensor;
    outs.push({ out: (t.data as Float32Array).slice(), n: t.dims[2], fit: win.fit, span: win.span });
  }
  return { ...pagePanels(outs, b.w, b.h), w: b.w, h: b.h };
}

async function handle(b: Body): Promise<Answer> {
  switch (b.type) {
    case 'load':
      await load(b.key, b.files);
      return {};
    case 'say': {
      const { audio, rate } = await sound(b.key, b.files, b.text, b.speed);
      return { mp3: mp3(audio, rate), samples: audio.length, rate };
    }
    case 'sound': {
      const { audio, rate } = await sound(b.key, b.files, b.text, b.speed);
      // A copy of its own, to hand over: the engine's may share its memory.
      return { audio: audio.slice(), rate };
    }
    case 'encode':
      return { mp3: mp3(b.audio, b.rate) };
    case 'panels':
      return await panels(b);
  }
}

/** One job at a time, in the order sent: an engine shared by two APIs may be sent two at once. */
let line: Promise<void> = Promise.resolve();

parentPort!.on('message', (m: Message) => {
  line = line.then(async () => {
    let r: Reply;
    try {
      await drop(m.drop);
      r = { id: m.id, ok: true, answer: await handle(m.body) };
    } catch (err) {
      r = { id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const moved = r.ok ? [r.answer.mp3?.buffer, r.answer.audio?.buffer].filter((b): b is ArrayBuffer => b instanceof ArrayBuffer) : [];
    parentPort!.postMessage(r, moved);
  });
});
