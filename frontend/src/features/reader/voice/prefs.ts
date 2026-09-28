import { useSyncExternalStore } from 'react';
import { readLocal, writeLocal } from '../../../lib/store';
import { BUILT_IN, DEFAULT_VOICE, engineOf, fromListed, voicesOf, type Mode, type VoiceInfo } from './catalog';
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
}

const KEY = 'breader.voice.v2';
export const RATES = [0.8, 1, 1.25, 1.5, 2];

const stored = readLocal<Partial<VoicePrefs>>(KEY, {});
let prefs: VoicePrefs = { mode: stored.mode ?? 'normal', rate: stored.rate ?? 1, voice: { ...DEFAULT_VOICE, ...stored.voice } };
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

/**
 * The voice a mode reads with: the one picked, or the first when that one has gone. Immersive on a
 * device that can't run its voices reads with Normal's pick (catalog.ts, voicesOf).
 */
export function voiceFor(mode: Mode): VoiceInfo {
  const m = voicesOf(mode);
  const key = prefs.voice[m];
  const built = BUILT_IN[m].find((v) => v.key === key);
  if (built) return built;
  const up = listedVoices().find((v) => `user:${v.id}` === key && v.engine === engineOf(m));
  return up ? fromListed(up) : BUILT_IN[m].find((v) => v.key === DEFAULT_VOICE[m])!;
}

/**
 * Whether to ask before a big download: on mobile data, or with data saver on. Browsers that
 * don't say what the connection is (Safari, Firefox) always ask.
 */
export function askFirst() {
  const c = (navigator as Navigator & { connection?: { type?: string; saveData?: boolean } }).connection;
  return !c || !!c.saveData || c.type === 'cellular';
}
