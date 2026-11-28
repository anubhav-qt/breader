import { readFile } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { Mp3Encoder } from '@breezystack/lamejs';
import * as ort from 'onnxruntime-node';
import { Phonon, PHONON_RATE } from '@breader/shared/speech';
import { findPanels, takesOf } from '@breader/shared/panels';
import { SPEECH_MODEL, type VoiceFiles } from '../speech/files.ts';
import { PANELS } from './models.ts';

/*
 * One of the engine's workers (ADR 0002): a thread of its own, so the API keeps answering, that runs
 * any model job it's given, one at a time, as ONNX Runtime's native run holds its thread till it's
 * done. It holds the models its jobs needed until the engine (scheduler.ts) tells it to let go.
 *
 * Voices: Phonon (ADR 0005), the same model and code as in the browser (shared speech.ts, frontend
 * voice/tts.worker.ts), so a voice sounds alike either way, answered as MP3 (about a seventh of the
 * raw sound's bytes) for phones on mobile data. Its WebAssembly runs on one thread whatever the
 * worker's `threads`. Panels: the panel model trained on the owner's labels (ai/panels), on a page's
 * pixels as the API opened them (serve.ts), fitted and read as the labeller's guesser does (shared
 * findPanels).
 *
 * Measured on a Ryzen 7 9800X3D, 2 threads: a panel window about 110 ms, the panel model held about
 * 500 MB. Phonon on an M-series Mac: 8.5 times faster than speech, about 380 MB (models.ts); not
 * measured on the laptop yet.
 */

/** Every voice is Phonon's (SPEECH_MODEL, models.ts): one model, each voice a file loaded into it. */
export type Body =
  | { type: 'load'; voice: string; files: VoiceFiles }
  | { type: 'say'; voice: string; files: VoiceFiles; text: string }
  /** A page's panels, from its pixels, red first, three to each. */
  /** A page's pixels, and the model's round: a round says how its pages are read (shared takesOf). */
  | { type: 'panels'; model: string; round: number; w: number; h: number; px: Uint8Array };

export interface Message {
  id: number;
  body: Body;
  /** Models to let go of first. */
  drop: string[];
}

export interface Answer {
  mp3?: Uint8Array;
  samples?: number;
  rate?: number;
  /** How long Phonon took to say it, in milliseconds: the engine's speed (serve.ts). */
  ms?: number;
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
/** Phonon, once a voice was wanted, for the rest of this worker's life. */
let phonon: Promise<Phonon> | null = null;

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
    // Phonon's memory goes only with this thread, so the pool ends the worker instead (serve.ts).
    if (key === SPEECH_MODEL) continue;
    const s = sessions.get(key);
    sessions.delete(key);
    await s?.then((x) => x.release()).catch(() => {});
  }
}

/** Phonon started from its files, once. */
function phononFrom(files: VoiceFiles) {
  if (!phonon) {
    const p = (async () => {
      const [wasm, model, tokenizer, config] = await Promise.all([files.wasm, files.model, files.tokenizer, files.config].map((f) => readFile(f)));
      return Phonon.load({ wasm, model, tokenizer, config });
    })();
    phonon = p;
    // One that failed to start is tried afresh next time.
    p.catch(() => {
      if (phonon === p) phonon = null;
    });
  }
  return phonon;
}

/** Phonon, with this voice loaded into it. */
async function load(voice: string, files: VoiceFiles) {
  const p = await phononFrom(files);
  if (!p.hasVoice(voice)) p.addVoice(voice, await readFile(files.voice));
  return p;
}

async function sound(voice: string, files: VoiceFiles, text: string): Promise<{ audio: Float32Array; rate: number }> {
  const p = await load(voice, files);
  return { audio: await p.say(voice, text), rate: PHONON_RATE };
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
  const m = s.inputMetadata[0];
  const found = await findPanels(b.px, b.w, b.h, 3, takesOf(m?.isTensor ? m.shape : undefined, b.round), async (input, k, fit) => {
    const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', input, [k, 3, fit.tall, fit.wide]) });
    const t = out[s.outputNames[0]] as ort.Tensor;
    return { out: t.data as Float32Array, n: t.dims[2] };
  });
  return { ...found, w: b.w, h: b.h };
}

async function handle(b: Body): Promise<Answer> {
  switch (b.type) {
    case 'load':
      await load(b.voice, b.files);
      return {};
    case 'say': {
      // Loaded first, so the time is the sentence's alone.
      await load(b.voice, b.files);
      const began = performance.now();
      const { audio, rate } = await sound(b.voice, b.files, b.text);
      const ms = performance.now() - began;
      return { mp3: mp3(audio, rate), samples: audio.length, rate, ms };
    }
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
    const moved = r.ok && r.answer.mp3?.buffer instanceof ArrayBuffer ? [r.answer.mp3.buffer] : [];
    parentPort!.postMessage(r, moved);
  });
});
