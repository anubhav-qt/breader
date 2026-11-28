import { useSyncExternalStore } from 'react';
import { engineFiles, voiceWant, weight, type VoiceInfo } from './catalog';
import { onServer } from './prefs';
import { readyOnServer, sayOnServer } from './server';
import { has, type Want } from './store';
import type { Reply, Request } from './tts.worker';

/*
 * The page's side of speech: the engine's worker (tts.worker.ts), or the server's voice
 * (server.ts), what's loading and how far it's got, and playing what comes back.
 *
 * The worker holds about 400 MB while it runs, the model for every voice, and each voice it has
 * loaded (a quarter of a megabyte each). It goes when the book closes or nothing has been said for
 * five minutes. Starting again takes a moment, from the cache.
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
}

let loadState: LoadState = { key: null, loaded: 0, total: 0, error: null };
const loadSubs = new Set<() => void>();
const setLoad = (s: Partial<LoadState>) => {
  loadState = { ...loadState, ...s };
  loadSubs.forEach((f) => f());
};
/** Reading aloud stopped over something other than loading: the voice sheet says what. Null clears it. */
export const failed = (error: string | null) => setLoad({ key: null, error });
/** Reading aloud starts again: what went wrong last time no longer applies. */
export function retry() {
  if (loadState.error && loadState.key === null) setLoad({ error: null });
}
export const useLoadState = () => useSyncExternalStore(
  (f) => { loadSubs.add(f); return () => { loadSubs.delete(f); }; },
  () => loadState,
);

/* Workers */

interface Pending {
  type: Request['type'];
  resolve: (r: Extract<Reply, { ok: true }>) => void;
  reject: (e: Error) => void;
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
      if ('progress' in r) {
        p.onBytes?.(r.progress.name, r.progress.bytes);
        return;
      }
      this.pending.delete(r.id);
      if (r.ok) p.resolve(r);
      else p.reject(new Error(r.error));
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'The voice engine stopped.'));
      this.pending.clear();
    };
  }

  call(req: Request, onBytes?: Pending['onBytes']) {
    const id = this.next++;
    idle();
    return new Promise<Extract<Reply, { ok: true }>>((resolve, reject) => {
      this.pending.set(id, { type: req.type, resolve, reject, onBytes });
      this.worker.postMessage({ ...req, id });
    }).finally(idle);
  }

  /** Downloading or loading a voice. Sentences being made ahead can be let go. */
  get loading() {
    for (const p of this.pending.values()) {
      if (p.type === 'start' || p.type === 'voice') return true;
    }
    return false;
  }

  stop() {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error('Stopped'));
    this.pending.clear();
  }
}

/** The reader's engine. */
let reader: Runner | null = null;

/** Unused this long, the engine goes. */
const IDLE_MS = 5 * 60_000;
let idleTimer = 0;
function idle() {
  if (typeof window === 'undefined') return;
  window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(release, IDLE_MS);
}

/** Lets the engine go, with everything it holds, unless it's still loading a voice. */
export function release() {
  if (!reader) return;
  if (reader.loading) {
    idle();
    return;
  }
  reader.stop();
  reader = null;
}

/** Everything a voice needs that isn't loaded yet: the engine's files the first time, and its own. */
function wantsOf(v: VoiceInfo, started: boolean): Want[] {
  const out: Want[] = [];
  if (!started) out.push(...Object.values(engineFiles()));
  out.push(voiceWant(v));
  return out;
}

/** Everything this voice still has to download, and roughly how many bytes that is. None for the server's. */
export async function missing(v: VoiceInfo) {
  if (onServer()) return { files: [] as Want[], bytes: 0 };
  const out: Want[] = [];
  for (const w of wantsOf(v, false)) {
    if (!(await has(w))) out.push(w);
  }
  return { files: out, bytes: weight(out) };
}

/** What these voices still have to download together, in bytes: a file they share counted once. */
export async function missingAll(vs: VoiceInfo[]) {
  const files = new Map<string, Want>();
  for (const v of vs) {
    for (const w of (await missing(v)).files) files.set(w.name, w);
  }
  return weight([...files.values()]);
}

/** Starts the engine and loads the voice, showing progress while files arrive. */
export function prepare(v: VoiceInfo): Promise<void> {
  if (onServer()) return prepareOnServer(v);
  return prepareHere(v);
}

/** Loads the voice in this device's engine, whatever the server switch says. */
function prepareHere(v: VoiceInfo): Promise<void> {
  reader ??= new Runner();
  const r = reader;
  const ready = r.voices.get(v.key);
  if (ready) return ready;
  const p = (async () => {
    const wants = wantsOf(v, !!r.started);
    const total = wants.reduce((n, w) => n + w.size, 0);
    let loaded = 0;
    setLoad({ key: v.key, loaded: 0, total, error: null });
    const onBytes = (_: string, n: number) => {
      loaded += n;
      setLoad({ loaded: Math.min(loaded, total) });
    };
    try {
      const cached = await Promise.all(wants.map(has));
      if (!cached.every(Boolean)) void navigator.storage?.persist?.().catch(() => {});
      await loadInto(r, v, onBytes);
      setLoad({ key: null, loaded: total });
    } catch (e) {
      r.voices.delete(v.key);
      setLoad({ key: null, error: (e as Error).message });
      // A failed start leaves the worker unusable; the next try gets a fresh one.
      if (reader === r) {
        r.stop();
        reader = null;
      }
      throw e;
    }
  })();
  r.voices.set(v.key, p);
  return p;
}

/** Starts the engine, if it hasn't, and loads the voice into it. */
async function loadInto(r: Runner, v: VoiceInfo, onBytes?: Pending['onBytes']) {
  r.started ??= r.call({ type: 'start', files: engineFiles() }, onBytes).then(() => undefined);
  await r.started;
  await r.call({ type: 'voice', key: v.key, file: voiceWant(v) }, onBytes);
}

/*
 * Audiobooks made on this device (features/audiobook) have engines of their own, apart from the
 * reader's, so reading aloud, or anything else, meanwhile doesn't stop them: one, or several side
 * by side (lanes), each making its own paragraphs. They go when the last book is made.
 */
let forBooks: { key: string; lanes: Runner[] } | null = null;

/**
 * Readies `v` in up to `lanes` engines for an audiobook and says how many are ready. The first
 * downloads what's missing, showing it arrive in `onLoading`; the others then load it from the
 * cache. One that can't start (out of memory, say) is left out, unless it's the first.
 */
export async function bookVoices(v: VoiceInfo, lanes: number, onLoading?: (loaded: number, total: number) => void): Promise<number> {
  if (forBooks && forBooks.key !== v.key) releaseBookVoice();
  const b = (forBooks ??= { key: v.key, lanes: [] });
  if (!b.lanes.length) {
    const r = new Runner();
    const total = wantsOf(v, false).reduce((n, w) => n + w.size, 0);
    let loaded = 0;
    try {
      await loadInto(r, v, (_, n) => {
        loaded += n;
        onLoading?.(Math.min(loaded, total), total);
      });
    } catch (e) {
      r.stop();
      if (forBooks === b) forBooks = null;
      throw e;
    }
    if (forBooks !== b) {
      r.stop();
      throw new Error('Stopped');
    }
    b.lanes.push(r);
  }
  const more = Array.from({ length: Math.max(0, lanes - b.lanes.length) }, () => new Runner());
  const ok = await Promise.all(more.map((r) => loadInto(r, v).then(() => true, () => { r.stop(); return false; })));
  for (let i = 0; i < more.length; i++) {
    if (ok[i] && forBooks === b) b.lanes.push(more[i]);
    else if (ok[i]) more[i].stop();
  }
  if (forBooks !== b) throw new Error('Stopped');
  // Fewer wanted than are running: the rest go.
  for (const r of b.lanes.splice(Math.max(1, lanes))) r.stop();
  return b.lanes.length;
}

/** A sentence's sound for an audiobook, made in lane `lane` of those bookVoices readied. */
export async function synthForBook(v: VoiceInfo, text: string, lane = 0): Promise<Clip> {
  const r = forBooks?.key === v.key ? forBooks.lanes[lane] : undefined;
  if (!r) throw new Error('Stopped');
  const res = await r.call({ type: 'say', key: v.key, text });
  return { audio: res.audio!, rate: res.rate! };
}

/** No audiobook is being made here: its engines go, with what they hold. */
export function releaseBookVoice() {
  for (const r of forBooks?.lanes ?? []) r.stop();
  forBooks = null;
}

/** Voices the server has made ready, or is making ready. */
const onServerReady = new Map<string, Promise<void>>();

/** Readies a voice on the server, showing its files arriving there the first time. */
function prepareOnServer(v: VoiceInfo): Promise<void> {
  const ready = onServerReady.get(v.key);
  if (ready) return ready;
  const p = (async () => {
    // A guess at what the server fetches the first time, until it says.
    setLoad({ key: v.key, loaded: 0, total: voiceWant(v).size, error: null });
    try {
      await readyOnServer(v, (loaded, total) => setLoad({ loaded, total }));
      setLoad({ key: null });
    } catch (e) {
      onServerReady.delete(v.key);
      setLoad({ key: null, error: (e as Error).message });
      throw e;
    }
  })();
  onServerReady.set(v.key, p);
  return p;
}

/** A sentence's sound, at the voice's own pace: play() makes it faster or slower. */
export async function synth(v: VoiceInfo, text: string): Promise<Clip> {
  if (onServer()) return sayOnServer(v, text);
  await prepareHere(v);
  // Not a new engine: this one was let go while the voice was being readied.
  const r = reader;
  if (!r) throw new Error('Stopped');
  const res = await r.call({ type: 'say', key: v.key, text });
  return { audio: res.audio!, rate: res.rate! };
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

/**
 * 16-bit mono WAV, after `lead` samples of the faintest sound 16 bits can make (one step either
 * way, far below hearing): not silence, which some speakers and headphones turn themselves down for.
 */
export function wav(samples: Float32Array, rate: number, lead = 0): Blob {
  const n = lead + samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const text = (at: number, str: string) => { for (let i = 0; i < str.length; i++) v.setUint8(at + i, str.charCodeAt(i)); };
  text(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
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
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < lead; i++) v.setInt16(44 + i * 2, Math.random() < 0.5 ? -1 : 1, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + (lead + i) * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return new Blob([buf], { type: 'audio/wav' });
}

/*
 * A new sound can take a moment to be heard: a phone or Safari starting it, a speaker coming back
 * up after the gap between two sentences. Chrome hands its speaker every sample, so it happens
 * after the browser, and whatever didn't make it was the sentence's first sound. The voices leave
 * quiet in front of it, but never the same, and played faster that quiet gets shorter (the old
 * voices lost their first sound at 210 ms). So at every speed, in every voice, a sentence starts
 * exactly this long before its first sound, as heard: quiet added in front when it has less, taken
 * off when it has more.
 */
const LEAD = 0.35;

/**
 * What's added in front comes off the quiet after the sentence's last sound, down to this much, so
 * the pause between two sentences, and the pace with it, stays the voice's own.
 */
const AFTER = 0.06;

/**
 * A sentence's sound as it's played at `speed`, LEAD before its first sound as heard, and where the
 * clip's own first sample falls in it (`shift`, in samples: less than nothing when quiet came off
 * the front).
 */
export function framed(clip: Clip, speed = 1) {
  const { audio: x, rate } = clip;
  const want = Math.round(LEAD * speed * rate);
  let own = 0;
  while (own < x.length && Math.abs(x[own]) < 0.01) own++;
  let after = 0;
  while (after < x.length - own && Math.abs(x[x.length - 1 - after]) < 0.01) after++;
  const lead = Math.max(0, want - own);
  const from = Math.max(0, own - want);
  const to = x.length - Math.min(lead, Math.max(0, after - Math.round(AFTER * speed * rate)));
  return { blob: wav(x.subarray(from, to), rate, lead), shift: lead - from };
}

let silence: string | null = null;

/**
 * Call from the tap that starts reading aloud: browsers only let sound start from one, and a media
 * element that has played once may play again later without one.
 */
export function unlock() {
  const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
  if (session) session.type = 'playback';
  hold(true);
  const a = audio();
  if (!a.paused) return;
  silence ??= URL.createObjectURL(wav(new Float32Array(2400), 24_000));
  a.src = silence;
  void a.play().catch(() => {});
}

/*
 * Chrome and Firefox give the media keys, a headset's button and their own media controls only to
 * a page playing something longer than a few seconds (five, in Chrome), and many sentences are
 * shorter. So while it reads, a second element loops a few seconds of silence to keep hold of them.
 * Near silence (wav's lead), so the speakers never hear nothing between two sentences either.
 * Safari gives them to the voice as it is, and an iPhone might let the silence cut the voice off,
 * so it's left out there (every browser on an iPhone is Safari underneath).
 */
const safari = typeof navigator !== 'undefined' && (
  'audioSession' in navigator || /iP(hone|ad|od)/.test(navigator.userAgent) || (/Safari\//.test(navigator.userAgent) && !/Chrome|Chromium|Edg|OPR|Firefox/.test(navigator.userAgent))
);
let carrier: HTMLAudioElement | null = null;
let quiet: string | null = null;

/** Keeps hold of the media keys while it reads (true), or lets the silence rest, still holding them, while paused. */
export function hold(on: boolean) {
  if (safari) return;
  if (!on) { carrier?.pause(); return; }
  if (!carrier) {
    quiet ??= URL.createObjectURL(wav(new Float32Array(0), 8000, 8000 * 6));
    carrier = new Audio(quiet);
    carrier.loop = true;
  }
  if (carrier.paused) void carrier.play().catch(() => {});
}

/** The book closed: the media keys go back to whatever else is playing. */
export function letGoKeys() {
  if (!carrier) return;
  carrier.pause();
  carrier.removeAttribute('src');
  carrier.load();
  carrier = null;
}

let current: { clip: Clip; a: HTMLAudioElement; shift: number; fade: number } | null = null;

/** The reader's own loudness for the voice, apart from a fade: it changes the sentence being said too. */
let loudness = { volume: 1, muted: false };
export function setLoudness(volume: number, muted: boolean) {
  loudness = { volume, muted };
  const p = current;
  if (!p) return;
  p.a.volume = p.fade * volume;
  p.a.muted = muted;
}

/** How loud the voice is right now, 0 to 1, for things that move with it. */
export function level() {
  const p = current;
  if (!p || p.a.paused) return 0;
  const { audio: x, rate } = p.clip;
  const mid = Math.floor(p.a.currentTime * rate) - p.shift;
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

/**
 * Plays a sentence's sound at `speed` (1 is the voice's own pace), its pitch kept. `volume` below 1
 * is a fade (ignored by iPhones, which keep their own).
 */
export function play(clip: Clip, volume = 1, speed = 1): Playing {
  const a = audio();
  const { blob, shift } = framed(clip, speed);
  const url = URL.createObjectURL(blob);
  const length = clip.audio.length / clip.rate;
  let stopped = false;
  let started = false;
  a.src = url;
  // A new source starts at the default rate, so both are set.
  a.preservesPitch = true;
  a.defaultPlaybackRate = speed;
  a.playbackRate = speed;
  a.volume = volume * loudness.volume;
  a.muted = loudness.muted;
  current = { clip, a, shift, fade: volume };
  const out: Playing = { done: null!, refusal: null, time: () => Math.max(0, Math.min(1, (a.currentTime - shift / clip.rate) / length)), stop: () => {} };
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

/** Plays a voice's sample line from a URL (a bundled clip). */
let sampleAudio: HTMLAudioElement | null = null;
export function playSample(url: string) {
  sampleAudio?.pause();
  sampleAudio = new Audio(url);
  void sampleAudio.play().catch(() => {});
  return sampleAudio;
}
export const stopSample = () => { sampleAudio?.pause(); sampleAudio = null; };
