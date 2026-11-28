import { useSyncExternalStore } from 'react';
import { phononFor } from '@breader/shared/voices';
import { readLocal, writeLocal } from '../../../lib/store';
import { handheld } from '../../../lib/handheld';
import { DEFAULT_VOICE, voiceByKey, type Mode, type VoiceInfo } from './catalog';
import { serverHas, speechAllowed } from './server';
import { voiceHere } from '../able';
import type { Two } from './two';

/*
 * How this device reads aloud: Normal or Immersive, the voice picked (the same in both), and how
 * fast. Kept on this device, like the voices' files. Immersive has one pace, in words a minute, for
 * the light (pacing.ts) and the voice alike.
 *
 * Where it reads: a phone or tablet has a switch, Read on server, on to start with. Anything else
 * reads on this device when it can keep up, else on Breader's computer (able.ts).
 */

export interface VoicePrefs {
  mode: Mode;
  /** The voice picked (catalog.ts keys). */
  voice: string;
  /** Normal's voice speed. */
  rate: number;
  /** Immersive's words a minute, for the light and the voice. */
  pace: number;
  /** A pace was kept from the page, where it's asked the first time; after that it's set in the sheet. */
  paceKept: boolean;
  /** 1 voice, or 2 (a woman's and a man's) for books an AI has marked, in each mode. */
  count: Record<Mode, 1 | 2>;
  /** 2 voices: her voice and his. */
  pair: Record<Two, string>;
  /** 2 voices: who reads narration that isn't anyone's point of view. */
  noPov: Two;
  /** How loud the voice is, 0 to 1, and whether it's muted (the keys' up, down and M). */
  volume: number;
  muted: boolean;
  /** Background music (music.ts), on books that have it, while it reads aloud or lights up. */
  music: boolean;
  /** How loud the music is, 0 to 1, apart from the voice. */
  musicVolume: number;
  /** A phone or tablet reads on Breader's computer (when it's open to this account). */
  server: boolean;
}

const KEY = 'breader.voice.v4';
/** From when each mode had its voices, of Piper and Kokoro (ADR 0005). */
const OLD = 'breader.voice.v3';
export const RATES = [0.8, 1, 1.25, 1.5, 2];
/** Words a minute. A little under most people's silent reading, to start with. */
export const PACE = { min: 80, max: 600, step: 20, start: 200 };
/** About how many words a minute a voice says at 1×. */
const SPOKEN = 170;
/** Background music's loudness, in tenths. Well under the voice, to start with. */
export const MUSIC_VOLUME = { min: 0, max: 1, step: 0.1, start: 0.1 };

/** About how many words a minute the voice says, for the keys' seconds. */
export const spokenWpm = (p: VoicePrefs) => rateOf(p) * SPOKEN;

/** How fast a voice reads: Normal at its speed, Immersive at its pace, as near as a voice goes (RATES). */
export function rateOf(p: VoicePrefs) {
  if (p.mode !== 'immersive') return p.rate;
  return Math.min(RATES[RATES.length - 1], Math.max(RATES[0], p.pace / SPOKEN));
}

export { handheld };

/** 2 voices' first pair. */
const DEFAULT_PAIR: Record<Two, string> = { F: 'phonon:everly', M: 'phonon:miles' };

type Old = Omit<Partial<VoicePrefs>, 'voice' | 'pair'> & {
  voice?: Partial<Record<Mode, string>>;
  pair?: Partial<Record<Mode, Partial<Record<Two, string>>>>;
};

/** Picks from before ADR 0005 become the nearest Phonon voice: the mode in use's, else Normal's. */
function fromOld(old: Old): Partial<VoicePrefs> {
  const mode = old.mode ?? 'normal';
  const { voice: oldVoice, pair: oldPair, ...rest } = old;
  const out: Partial<VoicePrefs> = rest;
  const voice = phononFor(oldVoice?.[mode] || oldVoice?.normal || '');
  if (voice) out.voice = voice;
  const pair = { ...oldPair?.normal, ...oldPair?.[mode] };
  const F = phononFor(pair.F || '');
  const M = phononFor(pair.M || '');
  if (F && M) out.pair = { F, M };
  return out;
}

const stored = readLocal<Partial<VoicePrefs> | null>(KEY, null) ?? fromOld(readLocal<Old>(OLD, {}));
let prefs: VoicePrefs = {
  mode: stored.mode ?? 'normal',
  voice: stored.voice ?? DEFAULT_VOICE,
  rate: stored.rate ?? 1,
  pace: stored.pace ?? PACE.start,
  paceKept: stored.paceKept ?? false,
  count: { normal: 1, immersive: 1, ...stored.count },
  pair: { ...DEFAULT_PAIR, ...stored.pair },
  noPov: stored.noPov ?? 'F',
  volume: stored.volume ?? 1,
  muted: stored.muted ?? false,
  music: stored.music ?? true,
  musicVolume: stored.musicVolume ?? MUSIC_VOLUME.start,
  server: stored.server ?? true,
};
writeLocal(KEY, prefs);
const subs = new Set<() => void>();

export function setVoicePrefs(patch: Partial<VoicePrefs>) {
  prefs = { ...prefs, ...patch };
  writeLocal(KEY, prefs);
  subs.forEach((s) => s());
}

export const voicePrefs = () => prefs;

/** A step slower or faster. */
export const stepPace = (dir: 1 | -1) => setVoicePrefs({ pace: Math.max(PACE.min, Math.min(PACE.max, prefs.pace + dir * PACE.step)) });
/** Background music a step quieter or louder. */
export function stepMusic(dir: 1 | -1) {
  const next = prefs.musicVolume + dir * MUSIC_VOLUME.step;
  const kept = Math.max(MUSIC_VOLUME.min, Math.min(MUSIC_VOLUME.max, next));
  setVoicePrefs({ musicVolume: Math.round(kept * 100) / 100 });
}
/** Normal's next speed down or up. */
export function stepRate(dir: 1 | -1) {
  let i = RATES.indexOf(prefs.rate);
  if (i < 0) i = RATES.indexOf(1);
  const next = Math.max(0, Math.min(RATES.length - 1, i + dir));
  setVoicePrefs({ rate: RATES[next] });
}
export const useVoicePrefs = () => useSyncExternalStore(
  (f) => { subs.add(f); return () => { subs.delete(f); }; },
  () => prefs,
);

/**
 * Reading with the server's voices, where the server voice is open to this account (`allowed`). A
 * phone or tablet reads there while its switch is on. Anything else, only when it's too slow to keep
 * up itself (able.ts). Otherwise this device reads, even a slow one, as best it can.
 */
export function readsOnServer(allowed: boolean, here = voiceHere(), phone = handheld()): boolean {
  if (!allowed) return false;
  if (phone) return prefs.server;
  return !here;
}

/** Whether to ask the server if its voice is open to this account: a phone may use it, and so may a slow device. */
export const mayReadOnServer = () => handheld() || !voiceHere();

export const onServer = () => readsOnServer(speechAllowed());

/** The voice it reads with: the one picked, or the first when that one has gone or the server lacks it. */
export function voiceFor(): VoiceInfo {
  const picked = voiceByKey(prefs.voice);
  if (picked && (!onServer() || serverHas(picked))) return picked;
  return voiceByKey(DEFAULT_VOICE)!;
}

/** The voice an audiobook is made with: the one picked, as this device makes them. */
export const audiobookVoice = (): VoiceInfo => voiceByKey(prefs.voice) ?? voiceByKey(DEFAULT_VOICE)!;

/** A voice can read one side of 2 voices if it's a woman's or a man's. */
export const sideOf = (v: VoiceInfo): Two => v.gender;

/**
 * The voices 2 voices reads with: the pair picked, or the first pair where one has gone, isn't
 * that side's any more, or the server lacks it.
 */
export function pairFor(): Record<Two, VoiceInfo> {
  const pick = (g: Two) => {
    const v = voiceByKey(prefs.pair[g]);
    if (v && sideOf(v) === g && (!onServer() || serverHas(v))) return v;
    return voiceByKey(DEFAULT_PAIR[g])!;
  };
  return { F: pick('F'), M: pick('M') };
}

/** Picks a woman's or a man's voice for her side or his. */
export function pickSide(v: VoiceInfo) {
  setVoicePrefs({ pair: { ...prefs.pair, [sideOf(v)]: v.key } });
}

/**
 * Whether to ask before a big download: on mobile data, or with data saver on. Browsers that
 * don't say what the connection is (Safari, Firefox) always ask.
 */
export function askFirst() {
  const c = (navigator as Navigator & { connection?: { type?: string; saveData?: boolean } }).connection;
  return !c || !!c.saveData || c.type === 'cellular';
}
