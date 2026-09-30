import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { Mp3Encoder } from '@breezystack/lamejs';
import * as ort from 'onnxruntime-web';
import { piperInput, type PiperConfig } from '@breader/shared/speech';
import type { VoiceFiles } from './files.ts';

/*
 * Turns sentences into sound on the laptop, in a thread of its own so the API keeps answering. It
 * runs the same engine and the same text-to-sounds steps as the voices in the browser
 * (frontend voice/tts.worker.ts), so a voice sounds alike either way, and answers with MP3, about a
 * seventh of the bytes of the raw sound, for phones on mobile data.
 *
 * One request at a time, as a model can't run twice at once. It holds two voices (2 voices reads
 * with a pair), about 150 MB each; a third lets go of the one used longest ago.
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

const voices = new Map<string, { session: ort.InferenceSession; config: PiperConfig }>();

async function load(key: string, files: VoiceFiles) {
  const had = voices.get(key);
  if (had) {
    // Used most recently now.
    voices.delete(key);
    voices.set(key, had);
    return had;
  }
  const [model, config] = await Promise.all([readFile(files.model), readFile(files.config, 'utf8')]);
  const cfg = JSON.parse(config) as PiperConfig;
  const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 });
  while (voices.size >= HELD) {
    const [oldest, v] = voices.entries().next().value!;
    voices.delete(oldest);
    await v.session.release();
  }
  const v = { session, config: cfg };
  voices.set(key, v);
  return v;
}

const int64 = (ids: number[]) => BigInt64Array.from(ids, (n) => BigInt(n));

async function say(m: Extract<Request, { type: 'say' }>) {
  const { session, config } = await load(m.key, m.files);
  const { ids, scales, speakers } = await piperInput(m.text, config, m.speed);
  const feeds: Record<string, ort.Tensor> = {
    input: new ort.Tensor('int64', int64(ids), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', int64([ids.length]), [1]),
    scales: new ort.Tensor('float32', new Float32Array(scales), [3]),
  };
  if (speakers > 1) feeds.sid = new ort.Tensor('int64', int64([0]), [1]);
  const out = await session.run(feeds);
  const audio = (out[session.outputNames[0]] as ort.Tensor).data as Float32Array;
  const rate = config.audio.sample_rate;
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
