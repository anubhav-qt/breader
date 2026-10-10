import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as ort from 'onnxruntime-web';
import LABELS from './clap-labels.json';
import { MUSIC } from './youtube.ts';

/*
 * What a track sounds like, heard rather than measured: LAION's CLAP (github.com/LAION-AI/CLAP,
 * Apache-2.0), a model that places sounds and words in one space, so a track can be held up
 * against words like "sad" or "piano". This is its version trained on music,
 * larger_clap_music_and_speech, as onnx files (huggingface.co/Xenova/larger_clap_music_and_speech).
 * Its audio half runs here on onnxruntime's WebAssembly build, the engine the server voice uses;
 * the words were placed once with its text half, and are kept in clap-labels.json.
 *
 * It listens to a few ten-second stretches spread through a track and says which words fit it
 * best: its mood, its instruments, whether anyone sings, and its pace. The director (music.ts)
 * reads this beside the loudness (sound.ts), as Gemini can't hear. They're a model's best
 * guesses, not a person's ear.
 *
 * The model is fetched once into the work folder (78 MB) and checked against its hash. Loaded, it
 * holds about 800 MB, kept for as long as the marker runs.
 */

const REVISION = 'e9fd5ac1dbf3280936a7fc3ec8a020453ff184db';
const MODEL_URL = `https://huggingface.co/Xenova/larger_clap_music_and_speech/resolve/${REVISION}/onnx/audio_model_quantized.onnx`;
const MODEL_SHA256 = '021dd4fb962b4ed20cc3a6730b09e0ccf9f9c49931047032118a3b64828513a6';
const MODEL = join(MUSIC, 'clap', 'audio_model_quantized.onnx');

/** What the model hears at a time: ten seconds at 48 kHz, as 1001 frames of 64 mel bands. */
const RATE = 48_000;
export const SAMPLES = 10 * RATE;
const FFT = 1024;
const HOP = 480;
const BANDS = 64;
export const FRAMES = SAMPLES / HOP + 1;
const BINS = FFT / 2 + 1;
/** The bands cover 50 Hz to 14 kHz. */
const LOWEST_HZ = 50;
const HIGHEST_HZ = 14_000;
/** Stretches heard per track. */
const STRETCHES = 4;

// Bundled (ai/dist/marker.js), the engine's own files sit in ai/dist/ort; from the source, it finds them itself.
const bundled = new URL('ort/', import.meta.url);
if (existsSync(new URL('ort-wasm-simd-threaded.wasm', bundled))) {
  ort.env.wasm.wasmPaths = {
    mjs: new URL('ort-wasm-simd-threaded.mjs', bundled).href,
    wasm: new URL('ort-wasm-simd-threaded.wasm', bundled).href,
  };
}
ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';

/* ---- The sound as the model takes it: a log-mel spectrogram, made the way CLAP's own code makes it ---- */

/** The periodic Hann window. */
const WINDOW = new Float64Array(FFT);
for (let i = 0; i < FFT; i++) WINDOW[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT);

/** Slaney's mel scale, as librosa has it: even steps below 1 kHz, a logarithm above. */
function hertzToMel(hz: number): number {
  if (hz < 1000) return (3 * hz) / 200;
  return 15 + (27 * Math.log(hz / 1000)) / Math.log(6.4);
}

function melToHertz(mel: number): number {
  if (mel < 15) return (200 * mel) / 3;
  return 1000 * Math.exp((Math.log(6.4) * (mel - 15)) / 27);
}

/** Each band's weights over the FFT's bins: a triangle, scaled so every band holds about the same energy. */
function melBank(): Float64Array[] {
  const low = hertzToMel(LOWEST_HZ);
  const high = hertzToMel(HIGHEST_HZ);
  const edges: number[] = [];
  for (let i = 0; i < BANDS + 2; i++) edges.push(melToHertz(low + ((high - low) * i) / (BANDS + 1)));
  const bank: Float64Array[] = [];
  for (let b = 0; b < BANDS; b++) {
    const left = edges[b];
    const centre = edges[b + 1];
    const right = edges[b + 2];
    const scale = 2 / (right - left);
    const weights = new Float64Array(BINS);
    for (let k = 0; k < BINS; k++) {
      const hz = (k * RATE) / FFT;
      const rising = (hz - left) / (centre - left);
      const falling = (right - hz) / (right - centre);
      weights[k] = Math.max(0, Math.min(rising, falling)) * scale;
    }
    bank.push(weights);
  }
  return bank;
}

const BANK = melBank();

function reversedBits(i: number, bits: number): number {
  let r = 0;
  for (let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1);
  return r;
}

const BITS = Math.log2(FFT);
const REVERSED = Array.from({ length: FFT }, (_, i) => reversedBits(i, BITS));
const COS = Array.from({ length: FFT / 2 }, (_, k) => Math.cos((2 * Math.PI * k) / FFT));
const SIN = Array.from({ length: FFT / 2 }, (_, k) => Math.sin((2 * Math.PI * k) / FFT));

/** The fast Fourier transform, in place: the classic radix-2 one. */
function fft(re: Float64Array, im: Float64Array) {
  for (let i = 0; i < FFT; i++) {
    const j = REVERSED[i];
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let size = 2; size <= FFT; size *= 2) {
    const half = size / 2;
    const stride = FFT / size;
    for (let start = 0; start < FFT; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = COS[k * stride];
        const wi = -SIN[k * stride];
        const a = start + k;
        const b = a + half;
        const tr = wr * re[b] - wi * im[b];
        const ti = wr * im[b] + wi * re[b];
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

/** Ten seconds exactly: a shorter stretch is repeated to fill them, as the model was taught, then padded with silence. */
export function tenSeconds(samples: Float32Array): Float32Array {
  if (!samples.length) throw new Error('ffmpeg gave no sound for it.');
  const out = new Float32Array(SAMPLES);
  if (samples.length >= SAMPLES) {
    out.set(samples.subarray(0, SAMPLES));
    return out;
  }
  const times = Math.floor(SAMPLES / samples.length);
  for (let i = 0; i < times; i++) out.set(samples, i * samples.length);
  return out;
}

/** Ten seconds of sound as the model takes it: each frame's energy in each mel band, in decibels. */
export function features(wave: Float32Array): Float32Array {
  // Reflected at both ends by half a frame, so the first and last frames are centred on the ends.
  const half = FFT / 2;
  const padded = new Float64Array(SAMPLES + FFT);
  for (let i = 0; i < SAMPLES; i++) padded[half + i] = wave[i];
  for (let i = 1; i <= half; i++) {
    padded[half - i] = wave[i];
    padded[half + SAMPLES - 1 + i] = wave[SAMPLES - 1 - i];
  }
  const out = new Float32Array(FRAMES * BANDS);
  const re = new Float64Array(FFT);
  const im = new Float64Array(FFT);
  const power = new Float64Array(BINS);
  for (let f = 0; f < FRAMES; f++) {
    for (let i = 0; i < FFT; i++) {
      re[i] = padded[f * HOP + i] * WINDOW[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < BINS; k++) power[k] = re[k] * re[k] + im[k] * im[k];
    for (let b = 0; b < BANDS; b++) {
      const weights = BANK[b];
      let energy = 0;
      for (let k = 0; k < BINS; k++) energy += weights[k] * power[k];
      out[f * BANDS + b] = 10 * Math.log10(Math.max(energy, 1e-10));
    }
  }
  return out;
}

/* ---- Listening ---- */

/** Where the stretches start, in seconds: spread evenly through the track, none running past its end. */
export function stretches(seconds: number): number[] {
  const room = Math.max(0, seconds - 10);
  const starts: number[] = [];
  for (let i = 0; i < STRETCHES; i++) starts.push(Math.round((room * (i + 0.5)) / STRETCHES));
  return starts;
}

/** Ten seconds of a track from a second on, as ffmpeg decodes it: one channel at 48 kHz. */
function decode(file: string, from: number): Promise<Float32Array> {
  const args = ['-nostdin', '-v', 'error', '-ss', String(from), '-t', '10', '-i', file, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', 'pipe:1'];
  return new Promise((resolve, reject) => {
    execFile(process.env.FFMPEG || 'ffmpeg', args, { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`ffmpeg couldn’t decode it: ${String(stderr).trim().split('\n').pop() ?? err.message}`));
        return;
      }
      const bytes = stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.byteLength);
      resolve(new Float32Array(bytes));
    });
  });
}

/** Scaled to length 1. */
export function unit(v: ArrayLike<number>): number[] {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const length = Math.sqrt(sum);
  const out: number[] = [];
  for (let i = 0; i < v.length; i++) out.push(v[i] / length);
  return out;
}

let fetching: Promise<void> | null = null;

async function fetchModel() {
  const res = await fetch(MODEL_URL, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) throw new Error(`Couldn’t fetch the listening model: ${res.status}.`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const sum = createHash('sha256').update(bytes).digest('hex');
  if (sum !== MODEL_SHA256) throw new Error('The listening model came back different from the one expected, so it isn’t used.');
  mkdirSync(dirname(MODEL), { recursive: true });
  writeFileSync(`${MODEL}.part`, bytes);
  renameSync(`${MODEL}.part`, MODEL);
}

let session: ort.InferenceSession | null = null;

/** The model, loaded once: fetched first if it isn't here yet. */
async function loaded(): Promise<ort.InferenceSession> {
  if (session) return session;
  if (!existsSync(MODEL)) {
    // One fetch, however many tracks are waiting for it.
    if (!fetching) fetching = fetchModel();
    try {
      await fetching;
    } finally {
      fetching = null;
    }
  }
  session = await ort.InferenceSession.create(readFileSync(MODEL), { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 });
  return session;
}

/** Where a track sits among the words: its stretches' places, averaged. */
async function placeOf(file: string, seconds: number): Promise<number[]> {
  const model = await loaded();
  const sum: number[] = [];
  for (const from of stretches(seconds)) {
    const input = new ort.Tensor('float32', features(tenSeconds(await decode(file, from))), [1, 1, FRAMES, BANDS]);
    const output = await model.run({ input_features: input });
    const place = unit(output.audio_embeds.data as Float32Array);
    for (let i = 0; i < place.length; i++) sum[i] = (sum[i] ?? 0) + place[i];
  }
  return unit(sum);
}

export interface Label {
  word: string;
  vector: number[];
}

export interface LabelGroup {
  name: string;
  /** How many of its words to give. */
  pick: number;
  labels: Label[];
}

/** The words nearest a track's place, group by group: "sad and calm; piano and strings; no singing; slow". */
export function wordsFor(place: ArrayLike<number>, groups: LabelGroup[]): string {
  const said: string[] = [];
  for (const g of groups) {
    const scored: Array<{ word: string; score: number }> = [];
    for (const l of g.labels) {
      let score = 0;
      for (let i = 0; i < l.vector.length; i++) score += l.vector[i] * place[i];
      scored.push({ word: l.word, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const words = scored.slice(0, g.pick).map((s) => s.word);
    said.push(words.join(' and '));
  }
  return said.join('; ');
}

/** The track being heard: the model runs one at a time, so the next waits for it. */
let hearing: Promise<unknown> = Promise.resolve();

/** What a track sounds like to the model, from its audio file. */
export async function hear(file: string, seconds: number): Promise<string> {
  const before = hearing;
  const mine = (async () => {
    await before.catch(() => {});
    return wordsFor(await placeOf(file, seconds), LABELS.groups);
  })();
  hearing = mine;
  return mine;
}
