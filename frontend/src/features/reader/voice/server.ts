import { useSyncExternalStore } from 'react';
import type { SpeechReady, SpeechState } from '@breader/shared/protocol';
import { api } from '../../../lib/api';
import { readLocal, writeLocal } from '../../../lib/store';
import type { VoiceInfo } from './catalog';

/*
 * The server voice: Breader's own computer reads aloud and sends each sentence's sound, for a phone
 * that can't run a voice itself (server speech/). It's open to a few accounts for now, so whether
 * this one may use it, and which voices it has, is asked of the server when a book or the voice
 * sheet opens, and remembered for when it can't be reached. Reading with it is a choice in the
 * voice sheet (prefs.ts `server`).
 */

const KEY = 'breader.speech.v1';
let state = readLocal<SpeechState>(KEY, { allowed: false, voices: [] });
const subs = new Set<() => void>();

export async function refreshSpeech() {
  try {
    const next = await api.laptop.get<SpeechState>('/v1/speech');
    if (next.allowed === state.allowed && next.voices.join() === state.voices.join()) return;
    state = next;
    writeLocal(KEY, state);
    subs.forEach((f) => f());
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
    const r = await api.laptop.post<SpeechReady>('/v1/speech/ready', { voice: v.key }, 30_000);
    onBytes(r.loaded, r.total);
    if (r.ready) return;
  }
}

/** A sentence's sound from the server, as the voices on this device make it. */
export async function sayOnServer(v: VoiceInfo, text: string, speed: number) {
  const res = await api.laptop.raw('/v1/speech/say', { voice: v.key, text, speed }, 30_000);
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
