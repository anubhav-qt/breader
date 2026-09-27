import { useSyncExternalStore } from 'react';
import { readLocal, writeLocal } from '../../../lib/store';
import { BUILT_IN, DEFAULT_VOICE, engineOf, fromListed, type Mode, type VoiceInfo } from './catalog';
import { listedVoices } from './list';

/*
 * How this device reads aloud: Normal or Immersive, the voice picked for each, and how fast. Kept
 * on this device, like the voices' files.
 */

export interface VoicePrefs {
  mode: Mode;
  /** The voice picked for each mode (catalog.ts keys). */
  voice: Record<Mode, string>;
  rate: number;
  /** Just switched to Immersive: the next tap on play opens the voice sheet instead of reading. */
  introduce: boolean;
}

const KEY = 'breader.voice.v2';
export const RATES = [0.8, 1, 1.25, 1.5, 2];

const stored = readLocal<Partial<VoicePrefs>>(KEY, {});
let prefs: VoicePrefs = { mode: 'normal', rate: 1, introduce: false, ...stored, voice: { ...DEFAULT_VOICE, ...stored.voice } };
const subs = new Set<() => void>();

export function setVoicePrefs(patch: Partial<VoicePrefs>) {
  prefs = { ...prefs, ...patch };
  writeLocal(KEY, prefs);
  subs.forEach((s) => s());
}

export const voicePrefs = () => prefs;
export const useVoicePrefs = () => useSyncExternalStore(
  (f) => { subs.add(f); return () => { subs.delete(f); }; },
  () => prefs,
);

/** The voice picked for a mode, or the mode's first voice when that one has gone. */
export function voiceFor(mode: Mode, key = prefs.voice[mode]): VoiceInfo {
  const built = BUILT_IN[mode].find((v) => v.key === key);
  if (built) return built;
  const up = listedVoices().find((v) => `user:${v.id}` === key && v.engine === engineOf(mode));
  return up ? fromListed(up) : BUILT_IN[mode].find((v) => v.key === DEFAULT_VOICE[mode])!;
}

/**
 * Whether to ask before a big download: on mobile data, or with data saver on. Browsers that
 * don't say what the connection is (Safari, Firefox) always ask.
 */
export function askFirst() {
  const c = (navigator as Navigator & { connection?: { type?: string; saveData?: boolean } }).connection;
  return !c || !!c.saveData || c.type === 'cellular';
}
