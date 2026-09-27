import { useSyncExternalStore } from 'react';
import { api } from '../../../lib/api';
import { engineFiles, filesOf, weight, type Engine, type VoiceInfo } from './catalog';
import { has, type Want } from './store';
import type { Reply, Request } from './tts.worker';

/*
 * The page's side of speech: a worker per engine (tts.worker.ts), what's loading and how far it's
 * got, and playing what comes back through Web Audio.
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
    } catch (e) {
      r.voices.delete(v.key);
      const err = e as Error & { gpu?: boolean };
      setLoad({ key: null, error: err.message, gpu: !!err.gpu });
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

/* Playing */

let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;

/**
 * Call from the tap that starts reading aloud: browsers only let sound start from one. iPhones
 * also mute Web Audio with the silent switch unless the page says it's playing media.
 */
export function unlock() {
  const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
  if (session) session.type = 'playback';
  ctx ??= new AudioContext();
  if (ctx.state !== 'running') void ctx.resume();
}

/** How loud the voice is right now, 0 to 1, for things that move with it. */
let levelBuf: Float32Array<ArrayBuffer> | null = null;
export function level() {
  if (!analyser) return 0;
  const buf = (levelBuf ??= new Float32Array(analyser.fftSize));
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (const x of buf) sum += x * x;
  return Math.min(1, Math.sqrt(sum / buf.length) * 4);
}

export interface Playing {
  /** Settles when the clip ends (true) or is stopped (false). */
  done: Promise<boolean>;
  stop: () => void;
}

/** Plays a clip, telling `onTime` how far through it is (0 to 1) as it goes. */
export function play(clip: Clip, onTime: (f: number) => void): Playing {
  unlock();
  const ac = ctx!;
  if (!analyser) {
    analyser = ac.createAnalyser();
    analyser.fftSize = 512;
    analyser.connect(ac.destination);
  }
  const buf = ac.createBuffer(1, clip.audio.length, clip.rate);
  buf.copyToChannel(clip.audio as Float32Array<ArrayBuffer>, 0);
  const src = ac.createBufferSource();
  src.buffer = buf;
  src.connect(analyser);
  const startAt = ac.currentTime + 0.02;
  let stopped = false;
  let raf = 0;
  const tick = () => {
    onTime(Math.max(0, Math.min(1, (ac.currentTime - startAt) / buf.duration)));
    raf = requestAnimationFrame(tick);
  };
  const done = new Promise<boolean>((resolve) => {
    src.onended = () => {
      cancelAnimationFrame(raf);
      src.disconnect();
      resolve(!stopped);
    };
  });
  src.start(startAt);
  raf = requestAnimationFrame(tick);
  return {
    done,
    stop: () => {
      if (stopped) return;
      stopped = true;
      try { src.stop(); } catch { /* not started */ }
    },
  };
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
