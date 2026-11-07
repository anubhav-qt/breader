import { useSyncExternalStore } from 'react';
import { readLocal, writeLocal } from '../../lib/store';
import { FEATURES } from './list';

/*
 * What the reader has been told, on this device: when they last opened the guide (anything Breader
 * gained since is New in it, and a dot on settings says so), whether tips are on, and the tips
 * already shown, each shown once.
 *
 * Someone new has nothing to catch up on: their first visit counts as having seen it all. Someone
 * who used Breader before the guide came (anything of Breader's already on this device) sees what
 * came since GUIDE_FROM as New.
 */

const KEY = 'breader.guide.v1';
/** The guide's first day: what came after it is New to readers from before it. */
export const GUIDE_FROM = Date.UTC(2026, 10, 2);

interface Kept {
  /** When the guide was last opened. */
  seen: number;
  /** Tips, and the dot for what's new. */
  tips: boolean;
  /** Tips already shown. */
  told: string[];
}

function first(): Kept {
  let before = false;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k !== KEY && k.startsWith('breader.')) { before = true; break; }
    }
  } catch { /* storage blocked: as someone new */ }
  return { seen: before ? GUIDE_FROM : Date.now(), tips: true, told: [] };
}

function load(): Kept {
  const k = readLocal<Partial<Kept> | null>(KEY, null);
  if (!k || typeof k.seen !== 'number') {
    const made = first();
    writeLocal(KEY, made);
    return made;
  }
  return { seen: k.seen, tips: k.tips !== false, told: Array.isArray(k.told) ? k.told.filter((t) => typeof t === 'string') : [] };
}

// Read as the app loads, before anything of its own is kept, so someone new is told apart.
let kept = load();
const subs = new Set<() => void>();
function set(patch: Partial<Kept>) {
  kept = { ...kept, ...patch };
  writeLocal(KEY, kept);
  subs.forEach((f) => f());
}
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

export const useGuideKept = () => useSyncExternalStore(subscribe, () => kept);

/** The guide's features that came since it was last opened. */
export function newSince(seen: number) {
  return FEATURES.filter((f) => f.since !== undefined && f.since > seen);
}

/** How many things are New, for the dot on settings: none while tips are off. */
export function useNews(): number {
  const k = useGuideKept();
  return k.tips ? newSince(k.seen).length : 0;
}

export function markSeen() {
  set({ seen: Date.now() });
}

export function setTips(on: boolean) {
  set({ tips: on });
}

export function markTold(id: string) {
  if (!kept.told.includes(id)) set({ told: [...kept.told, id] });
}

/** Every tip can be shown again. */
export function forgetTold() {
  set({ told: [], tips: true });
}
