import { useSyncExternalStore } from 'react';
import { api } from '../../../lib/api';
import { engineFiles, filesOf, noGpu, weight, type Engine, type VoiceInfo } from './catalog';
import { startingHeavy } from './prefs';
import { has, type Want } from './store';
import type { Reply, Request } from './tts.worker';

/*
 * The page's side of speech: a worker per engine (tts.worker.ts), what's loading and how far it's
 * got, and playing what comes back.
 */

export interface Clip {
  audio: Float32Array;
  rate: number;
}

/* Loading, for the play button and the voice sheet. */

export interface LoadState {
  /** The voice being made ready, or null when nothing is loading. */
  key: string | null;
  loaded: number;
  total: number;
  error: string | null;
  /** The error is this browser lacking what Immersive needs. */
  gpu?: boolean;
}

let loadState: LoadState = { key: null, loaded: 0, total: 0, error: null };
const loadSubs = new Set<() => void>();
const setLoad = (s: Partial<LoadState>) => {
  loadState = { ...loadState, ...s };
  loadSubs.forEach((f) => f());
};
/** Reading aloud stopped over something other than loading: the voice sheet says what. Null clears it. */
export const failed = (error: string | null) => setLoad({ key: null, error, gpu: false });
/** Reading aloud starts again: what went wrong last time no longer applies. */
export const retry = () => { if (loadState.error && loadState.key === null) setLoad({ error: null, gpu: false }); };
export const useLoadState = () => useSyncExternalStore(
  (f) => { loadSubs.add(f); return () => { loadSubs.delete(f); }; },
  () => loadState,
);

/* Workers */

interface Pending {
  resolve: (r: Extract<Reply, { ok: true }>) => void;
  reject: (e: Error & { gpu?: boolean }) => void;
  onBytes?: (name: string, n: number) => void;
}

class Runner {
  private worker = new Worker(new URL('./tts.worker.ts', import.meta.url), { type: 'module' });
  private next = 1;
  private pending = new Map<number, Pending>();
  started: Promise<void> | null = null;
  voices = new Map<string, Promise<void>>();

  constructor() {
    this.worker.onmessage = (e: MessageEvent<Reply>) => {
      const r = e.data;
      const p = this.pending.get(r.id);
      if (!p) return;
      if ('progress' in r) { p.onBytes?.(r.progress.name, r.progress.bytes); return; }
      this.pending.delete(r.id);
      if (r.ok) p.resolve(r);
      else p.reject(Object.assign(new Error(r.error), { gpu: r.gpu }));
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'The voice engine stopped.'));
      this.pending.clear();
    };
  }

  call(req: Request, onBytes?: Pending['onBytes']) {
    const id = this.next++;
    return new Promise<Extract<Reply, { ok: true }>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onBytes });
      this.worker.postMessage({ ...req, id });
    });
  }

  stop() {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error('Stopped'));
    this.pending.clear();
  }
}

const runners: Partial<Record<Engine, Runner>> = {};

/** One engine runs at a time: its models are big. */
function runner(e: Engine) {
  for (const k of Object.keys(runners) as Engine[]) {
    if (k !== e) { runners[k]!.stop(); delete runners[k]; }
  }
  return (runners[e] ??= new Runner());
}

/** An uploaded voice's files come through a signed link, fetched only when they aren't cached. */
async function linked(w: Want | undefined, fileId: string | null | undefined): Promise<Want | undefined> {
  if (!w || !fileId || (await has(w))) return w;
  const { url } = await api.get<{ url: string }>(`/v1/voices/files/${encodeURIComponent(fileId)}/link`);
  return { ...w, from: [url] };
}

/** Everything this voice still has to download, and roughly how many bytes that is. */
export async function missing(v: VoiceInfo) {
  const f = filesOf(v);
  const all = [...engineFiles(v.engine), f.model, f.config, f.pack].filter((w): w is Want => !!w);
  const out: Want[] = [];
  for (const w of all) if (!(await has(w))) out.push(w);
  return { files: out, bytes: weight(out) };
}

/** Starts the voice's engine and loads the voice, showing progress while files arrive. */
export function prepare(v: VoiceInfo): Promise<void> {
  const r = runner(v.engine);
  const ready = r.voices.get(v.key);
  if (ready) return ready;
  const p = (async () => {
    const f = filesOf(v);
    const wants = [...(r.started ? [] : engineFiles(v.engine)), f.model, f.config, f.pack].filter((w): w is Want => !!w);
    const total = wants.reduce((n, w) => n + w.size, 0);
    let loaded = 0;
    setLoad({ key: v.key, loaded: 0, total, error: null, gpu: false });
    const onBytes = (_: string, n: number) => {
      loaded += n;
      setLoad({ loaded: Math.min(loaded, total) });
    };
    try {
      if (!(await Promise.all(wants.map(has))).every(Boolean)) void navigator.storage?.persist?.().catch(() => {});
      if (v.engine === 'kokoro') startingHeavy(v.key);
      r.started ??= r.call({ type: 'start', engine: v.engine }, onBytes).then(() => undefined);
      await r.started;
      const u = v.upload;
      await r.call({
        type: 'voice',
        key: v.key,
        model: await linked(f.model, u?.fileId),
        config: await linked(f.config, u?.configId),
        pack: await linked(f.pack, u?.fileId),
        british: v.british,
      }, onBytes);
      setLoad({ key: null, loaded: total });
      if (v.engine === 'kokoro') startingHeavy(null);
    } catch (e) {
      if (v.engine === 'kokoro') startingHeavy(null);
      r.voices.delete(v.key);
      const err = e as Error & { gpu?: boolean };
      setLoad({ key: null, error: err.message, gpu: !!err.gpu });
      if (err.gpu) noGpu();
      // A failed start leaves the worker unusable; the next try gets a fresh one.
      if (runners[v.engine] === r) { r.stop(); delete runners[v.engine]; }
      throw e;
    }
  })();
  r.voices.set(v.key, p);
  return p;
}

export async function synth(v: VoiceInfo, text: string, speed: number): Promise<Clip> {
  await prepare(v);
  const res = await runner(v.engine).call({ type: 'say', key: v.key, text, speed });
  return { audio: res.audio!, rate: res.rate! };
}

/** Unloads a voice from its engine. */
export async function drop(v: VoiceInfo) {
  const r = runners[v.engine];
  if (!r) return;
  r.voices.delete(v.key);
  await r.call({ type: 'forget', key: v.key }).catch(() => {});
}

/* Playing */

/*
 * Through one <audio> element rather than Web Audio: phones keep a media element playing with the
 * screen locked or the browser in the background, the lock screen's controls work it, and iPhones
 * don't mute it with the silent switch.
 */

let element: HTMLAudioElement | null = null;
const audio = () => {
  if (!element) {
    element = new Audio();
    element.preload = 'auto';
  }
  return element;
};

/** 16-bit mono WAV. */
export function wav(samples: Float32Array, rate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const text = (at: number, str: string) => { for (let i = 0; i < str.length; i++) v.setUint8(at + i, str.charCodeAt(i)); };
  text(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return new Blob([buf], { type: 'audio/wav' });
}

let silence: string | null = null;

/**
 * Call from the tap that starts reading aloud: browsers only let sound start from one, and a media
 * element that has played once may play again later without one.
 */
export function unlock() {
  const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
  if (session) session.type = 'playback';
  const a = audio();
  if (!a.paused) return;
  silence ??= URL.createObjectURL(wav(new Float32Array(2400), 24_000));
  a.src = silence;
  void a.play().catch(() => {});
}

let current: { clip: Clip; a: HTMLAudioElement } | null = null;

/** How loud the voice is right now, 0 to 1, for things that move with it. */
export function level() {
  const p = current;
  if (!p || p.a.paused) return 0;
  const { audio: x, rate } = p.clip;
  const mid = Math.floor(p.a.currentTime * rate);
  let sum = 0;
  let n = 0;
  for (let i = Math.max(0, mid - 512); i < Math.min(x.length, mid + 512); i++, n++) sum += x[i] * x[i];
  return n ? Math.min(1, Math.sqrt(sum / n) * 4) : 0;
}

export interface Playing {
  /**
   * Settles when the clip ends, is stopped, is paused from outside (a call, the lock screen), or
   * the browser won't play it at all (`refusal` says why).
   */
  done: Promise<'ended' | 'stopped' | 'paused' | 'refused'>;
  refusal: string | null;
  /** How far through it is, 0 to 1. */
  time: () => number;
  stop: () => void;
}

export function play(clip: Clip): Playing {
  const a = audio();
  const url = URL.createObjectURL(wav(clip.audio, clip.rate));
  const length = clip.audio.length / clip.rate;
  let stopped = false;
  let started = false;
  a.src = url;
  current = { clip, a };
  const out: Playing = { done: null!, refusal: null, time: () => Math.min(1, a.currentTime / length), stop: () => {} };
  out.done = new Promise((resolve) => {
    let settled = false;
    const finish = (how: 'ended' | 'stopped' | 'paused' | 'refused') => {
      if (settled) return;
      settled = true;
      a.removeEventListener('ended', ended);
      a.removeEventListener('pause', paused);
      if (current?.clip === clip) current = null;
      URL.revokeObjectURL(url);
      resolve(how);
    };
    const ended = () => finish('ended');
    // Ending pauses it too, just before 'ended'; and a pause left over from the last clip isn't this one's.
    const paused = () => { if (started && !a.ended) finish(stopped ? 'stopped' : 'paused'); };
    a.addEventListener('ended', ended);
    a.addEventListener('pause', paused);
    a.play().then(() => { started = true; }, (e: Error) => {
      if (stopped) { finish('stopped'); return; }
      out.refusal = e?.name || String(e);
      console.warn('The browser wouldn’t play the voice:', e);
      finish('refused');
    });
  });
  out.stop = () => {
    if (stopped) return;
    stopped = true;
    a.pause();
  };
  return out;
}

/** Plays a voice's sample line from a URL (bundled clips, uploaded samples). */
let sampleAudio: HTMLAudioElement | null = null;
export function playSample(url: string) {
  sampleAudio?.pause();
  sampleAudio = new Audio(url);
  void sampleAudio.play().catch(() => {});
  return sampleAudio;
}
export const stopSample = () => { sampleAudio?.pause(); sampleAudio = null; };
