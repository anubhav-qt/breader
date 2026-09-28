import { useSyncExternalStore } from 'react';
import { readLocal, writeLocal } from '../../../lib/store';
import { BUILT_IN, DEFAULT_VOICE, fromListed, hasGpu, type Engine, type Mode, type VoiceInfo } from './catalog';
import { listedVoices } from './list';

/*
 * How this device reads aloud: Normal or Immersive, the voice picked for each, and how fast. Kept
 * on this device, like the voices' files. Immersive without a voice lights the words at a pace of
 * its own (pacing.ts).
 *
 * Normal reads with Normal's voices. Immersive reads with any: Normal's, or the heavy ones, which
 * only a computer runs well. On a phone they can hang the whole browser, so phones start Immersive
 * on their Normal voice.
 */

export interface VoicePrefs {
  mode: Mode;
  /** The voice picked for each mode (catalog.ts keys). Immersive's can be any voice. */
  voice: Record<Mode, string>;
  rate: number;
  /** Immersive without a voice: words a minute. */
  pace: number;
  /** A pace was kept from the page, where it's asked the first time; after that it's set in the sheet. */
  paceKept: boolean;
}

const KEY = 'breader.voice.v3';
/** From when Immersive had only the heavy voices. */
const OLD = 'breader.voice.v2';
/** The heavy voice starting up. Still there when the page loads again, it hung the browser. */
const STARTING = 'breader.voice.starting';
export const RATES = [0.8, 1, 1.25, 1.5, 2];
/** Words a minute. A little under most people's silent reading, to start with. */
export const PACE = { min: 80, max: 600, step: 20, start: 200 };

/** Phones and tablets, where the heavy voices can hang the browser. */
export const handheld = () => typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches;

function fromOld(old: Partial<VoicePrefs>): Partial<VoicePrefs> {
  if (!handheld() || !old.voice) return old;
  // Its Immersive voice could only be a heavy one then; a phone forgets it.
  const voice: Partial<Record<Mode, string>> = { ...old.voice };
  delete voice.immersive;
  return { ...old, voice: voice as Record<Mode, string> };
}

/** The heavy voice that hung the browser last time, if one did. */
export const hung = readLocal<string | null>(STARTING, null);
if (hung) writeLocal(STARTING, null);

const stored = readLocal<Partial<VoicePrefs> | null>(KEY, null) ?? fromOld(readLocal<Partial<VoicePrefs>>(OLD, {}));
const normal = stored.voice?.normal ?? DEFAULT_VOICE.normal;
const voice = { normal, immersive: handheld() ? normal : DEFAULT_VOICE.immersive, ...stored.voice };
let prefs: VoicePrefs = { mode: stored.mode ?? 'normal', rate: stored.rate ?? 1, pace: stored.pace ?? PACE.start, paceKept: stored.paceKept ?? false, voice };
if (hung && voice.immersive === hung) {
  voice.immersive = normal;
  writeLocal(KEY, prefs);
}
const subs = new Set<() => void>();

export function setVoicePrefs(patch: Partial<VoicePrefs>) {
  prefs = { ...prefs, ...patch };
  writeLocal(KEY, prefs);
  subs.forEach((s) => s());
}

export const voicePrefs = () => prefs;

/** A step slower or faster. */
export const stepPace = (dir: 1 | -1) => setVoicePrefs({ pace: Math.max(PACE.min, Math.min(PACE.max, prefs.pace + dir * PACE.step)) });
export const useVoicePrefs = () => useSyncExternalStore(
  (f) => { subs.add(f); return () => { subs.delete(f); }; },
  () => prefs,
);

/** A voice by its key, of these engines, if it's still there. */
function find(key: string, engines: Engine[]): VoiceInfo | undefined {
  const built = [...BUILT_IN.normal, ...BUILT_IN.immersive].find((v) => v.key === key);
  if (built) return engines.includes(built.engine) ? built : undefined;
  const up = listedVoices().find((v) => `user:${v.id}` === key && engines.includes(v.engine));
  return up && fromListed(up);
}

/**
 * The voice a mode reads with: the one picked, or the default when that one has gone. A heavy
 * voice where the graphics chip can't run it reads with Normal's pick instead.
 */
export function voiceFor(mode: Mode): VoiceInfo {
  const normal = find(prefs.voice.normal, ['piper']) ?? find(DEFAULT_VOICE.normal, ['piper'])!;
  if (mode === 'normal') return normal;
  const v = find(prefs.voice.immersive, ['piper', 'kokoro']) ?? (handheld() ? normal : find(DEFAULT_VOICE.immersive, ['kokoro'])!);
  return v.engine === 'kokoro' && !hasGpu() ? normal : v;
}

/*
 * Starting a heavy voice leaves a note, taken away once it's running, when it fails, or when the
 * page is closed. A note still there when the page next loads means it hung the browser, and it
 * isn't started by itself again (`hung`).
 */
let starting = false;
export function startingHeavy(key: string | null) {
  starting = !!key;
  writeLocal(STARTING, key);
}
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => { if (starting) writeLocal(STARTING, null); });

/**
 * Whether to ask before a big download: on mobile data, or with data saver on. Browsers that
 * don't say what the connection is (Safari, Firefox) always ask.
 */
export function askFirst() {
  const c = (navigator as Navigator & { connection?: { type?: string; saveData?: boolean } }).connection;
  return !c || !!c.saveData || c.type === 'cellular';
}
