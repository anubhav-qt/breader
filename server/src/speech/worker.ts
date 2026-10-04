import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { Mp3Encoder } from '@breezystack/lamejs';
import * as ort from 'onnxruntime-web';
import { KOKORO_PACK_BYTES, KOKORO_RATE, kokoroInput, piperInput, type PiperConfig } from '@breader/shared/speech';
import type { VoiceFiles } from './files.ts';

/*
 * Turns sentences into sound on the laptop, in a thread of its own so the API keeps answering. It
 * runs the same engine and the same text-to-sounds steps as the voices in the browser
 * (frontend voice/tts.worker.ts), so a voice sounds alike either way, and answers with MP3, about a
 * seventh of the bytes of the raw sound, for phones on mobile data.
 *
 * One request at a time, as a model can't run twice at once. It holds two voices (2 voices reads
 * with a pair); a third lets go of the one used longest ago. A Normal voice is about 150 MB. The
 * heavy ones share one model, about 1 GB while any of them is held (it runs at about twice real
 * time on four threads of an M-series Mac), and each adds half a megabyte.
 */

export type Request =
  | { type: 'load'; key: string; files: VoiceFiles }
  | { type: 'say'; key: string; files: VoiceFiles; text: string; speed: number };

export type Reply =
  | { id: number; ok: true; mp3?: Uint8Array; samples?: number; rate?: number }
  | { id: number; ok: false; error: string };

const HELD = 2;
/** MP3 at this many kilobits a second: clear for speech, about 22 MB an hour. */
const KBPS = 48;

// Bundled (dist/speech/worker.js), the engine's own files sit in dist/ort; from the source, it finds them itself.
const bundled = new URL('../ort/', import.meta.url);
if (existsSync(new URL('ort-wasm-simd-threaded.wasm', bundled))) {
  ort.env.wasm.wasmPaths = {
    mjs: new URL('ort-wasm-simd-threaded.mjs', bundled).href,
    wasm: new URL('ort-wasm-simd-threaded.wasm', bundled).href,
  };
}
ort.env.wasm.numThreads = (workerData as { threads: number }).threads;
ort.env.logLevel = 'error';

type Voice =
  | { engine: 'piper'; session: ort.InferenceSession; config: PiperConfig }
  | { engine: 'kokoro'; pack: Float32Array; british: boolean };

const voices = new Map<string, Voice>();
/** Kokoro's one model, for all its voices: held while one of them is. */
let kokoro: ort.InferenceSession | null = null;

const session = async (file: string) => ort.InferenceSession.create(await readFile(file), { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 });

async function open(files: VoiceFiles): Promise<Voice> {
  if (files.engine === 'kokoro') {
    kokoro ??= await session(files.model);
    const b = await readFile(files.pack);
    if (b.byteLength !== KOKORO_PACK_BYTES) throw new Error('That isn’t a Kokoro voice pack.');
    return { engine: 'kokoro', pack: new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)), british: files.british };
  }
  const [model, config] = await Promise.all([session(files.model), readFile(files.config, 'utf8')]);
  return { engine: 'piper', session: model, config: JSON.parse(config) as PiperConfig };
}

async function load(key: string, files: VoiceFiles) {
  const had = voices.get(key);
  if (had) {
    // Used most recently now.
    voices.delete(key);
    voices.set(key, had);
    return had;
  }
  const v = await open(files);
  while (voices.size >= HELD) {
    const [oldest, gone] = voices.entries().next().value!;
    voices.delete(oldest);
    if (gone.engine === 'piper') await gone.session.release();
  }
  voices.set(key, v);
  if (kokoro && ![...voices.values()].some((h) => h.engine === 'kokoro')) {
    await kokoro.release();
    kokoro = null;
  }
  return v;
}

const int64 = (ids: number[]) => BigInt64Array.from(ids, (n) => BigInt(n));

async function sound(v: Voice, text: string, speed: number): Promise<{ audio: Float32Array; rate: number }> {
  if (v.engine === 'kokoro') {
    const { ids, style } = await kokoroInput(text, v.british, v.pack);
    const out = await kokoro!.run({
      input_ids: new ort.Tensor('int64', int64(ids), [1, ids.length]),
      style: new ort.Tensor('float32', style, [1, 256]),
      speed: new ort.Tensor('float32', new Float32Array([speed]), [1]),
    });
    return { audio: (out.waveform as ort.Tensor).data as Float32Array, rate: KOKORO_RATE };
  }
  const { ids, scales, speakers } = await piperInput(text, v.config, speed);
  const feeds: Record<string, ort.Tensor> = {
    input: new ort.Tensor('int64', int64(ids), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', int64([ids.length]), [1]),
    scales: new ort.Tensor('float32', new Float32Array(scales), [3]),
  };
  if (speakers > 1) feeds.sid = new ort.Tensor('int64', int64([0]), [1]);
  const out = await v.session.run(feeds);
  return { audio: (out[v.session.outputNames[0]] as ort.Tensor).data as Float32Array, rate: v.config.audio.sample_rate };
}

async function say(m: Extract<Request, { type: 'say' }>) {
  const { audio, rate } = await sound(await load(m.key, m.files), m.text, m.speed);
  return { mp3: mp3(audio, rate), samples: audio.length, rate };
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

async function handle(m: Request & { id: number }): Promise<Reply> {
  try {
    if (m.type === 'load') {
      await load(m.key, m.files);
      return { id: m.id, ok: true };
    }
    return { id: m.id, ok: true, ...(await say(m)) };
  } catch (err) {
    return { id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

let queue = Promise.resolve();
parentPort!.on('message', (m: Request & { id: number }) => {
  queue = queue.then(async () => {
    const r = await handle(m);
    parentPort!.postMessage(r, r.ok && r.mp3 ? [r.mp3.buffer as ArrayBuffer] : []);
  });
});
