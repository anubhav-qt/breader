import { useSyncExternalStore } from 'react';
import type { SpeechReady, SpeechState } from '@breader/shared/protocol';
import { api, ApiError, OfflineError } from '../../../lib/api';
import { readLocal, writeLocal } from '../../../lib/store';
import type { VoiceInfo } from './catalog';

/*
 * The server voice: Breader's own computer reads aloud and sends each sentence's sound, for a device
 * too slow to keep up itself (able.ts, server speech/), with Piper's voices only. It's open to any
 * reader signed in with a confirmed address, so whether this one may use it, and which voices it
 * has, is asked of the server when a book or the voice sheet opens on such a device, and remembered
 * for when it can't be reached.
 *
 * Such a device reads only on the server, never itself mid-book: it couldn't keep up, and hasn't the
 * voice downloaded. Busy, the server is asked again after a moment; away or off, reading stops and
 * says so (narration.ts).
 */

const KEY = 'breader.speech.v1';
let state = readLocal<SpeechState>(KEY, { allowed: false, voices: [] });
const subs = new Set<() => void>();
const tell = () => subs.forEach((f) => f());

/** How long a sentence is asked for again while the server is busy, before reading stops. */
const BUSY_FOR_MS = 60_000;
/** Other failures (a sentence it couldn't make, a dropped answer) are tried this many more times. */
const TRIES = 2;
const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/** Asks again while the server is busy (a second, then two, up to five), or once or twice if a sentence failed. */
async function again<T>(ask: () => Promise<T>): Promise<T> {
  const until = Date.now() + BUSY_FOR_MS;
  let busy = 0;
  let failed = 0;
  for (;;) {
    try {
      return await ask();
    } catch (e) {
      if (e instanceof OfflineError) throw new Error('This device is offline, and Breader’s computer reads aloud for it.');
      const code = e instanceof ApiError ? e.code : '';
      if (code === 'speech_busy' && Date.now() < until) {
        await wait(Math.min(5_000, 1_000 * ++busy));
        continue;
      }
      // Away, off, or not allowed: asking again won't help.
      const final = ['laptop_off', 'speech_off', 'speech_not_allowed', 'speech_voice', 'speech_busy'].includes(code);
      if (final || ++failed > TRIES) throw e;
      await wait(500);
    }
  }
}

export async function refreshSpeech() {
  try {
    const next = await api.laptop.get<SpeechState>('/v1/speech');
    if (next.allowed === state.allowed && next.voices.join() === state.voices.join()) return;
    state = next;
    writeLocal(KEY, state);
    tell();
  } catch {
    // Unreachable: what was known stands.
  }
}

export const speechAllowed = () => state.allowed;
export const useSpeech = () => useSyncExternalStore(
  (f) => { subs.add(f); return () => { subs.delete(f); }; },
  () => state,
);
/** The server reads with this voice. */
export const serverHas = (v: VoiceInfo | undefined) => !!v && state.voices.includes(v.key);

/**
 * Makes a voice ready on the server: the first time, its files download there, and `onBytes` says
 * how far. The server answers within 20 seconds either way, so this asks until it's done.
 */
export async function readyOnServer(v: VoiceInfo, onBytes: (loaded: number, total: number) => void) {
  for (;;) {
    const r = await again(() => api.laptop.post<SpeechReady>('/v1/speech/ready', { voice: v.key }, 30_000));
    onBytes(r.loaded, r.total);
    if (r.ready) return;
  }
}

/** A sentence's sound from the server, as the voices on this device make it. */
export async function sayOnServer(v: VoiceInfo, text: string, speed: number) {
  const res = await again(() => api.laptop.raw('/v1/speech/say', { voice: v.key, text, speed }, 30_000));
  const rate = Number(res.headers.get('x-rate'));
  const samples = Number(res.headers.get('x-samples'));
  return { audio: await decode(await res.arrayBuffer(), rate, samples), rate };
}

/*
 * MP3 back to samples, so it plays, lights words and moves things with the voice exactly as sound
 * made here does. An encoder puts 1,105 samples of nothing in front, which some browsers keep
 * (Chrome) and some take out; whatever is more than the sound's length is cut, from the front first.
 */
const DELAY = 1105;
const contexts = new Map<number, BaseAudioContext>();
type Offline = new (channels: number, length: number, rate: number) => BaseAudioContext;

async function decode(bytes: ArrayBuffer, rate: number, samples: number): Promise<Float32Array> {
  let ctx = contexts.get(rate);
  if (!ctx) {
    const W = window as unknown as { OfflineAudioContext?: Offline; webkitOfflineAudioContext?: Offline };
    const Ctx = W.OfflineAudioContext ?? W.webkitOfflineAudioContext!;
    ctx = new Ctx(1, 1, rate);
    contexts.set(rate, ctx);
  }
  // The callbacks, as older Safari has no promise here.
  const buf = await new Promise<AudioBuffer>((resolve, reject) => { void ctx.decodeAudioData(bytes, resolve, reject)?.catch?.(() => {}); });
  const d = buf.getChannelData(0);
  if (!samples || d.length <= samples) return d;
  const start = Math.min(DELAY, d.length - samples);
  return d.slice(start, start + samples);
}
