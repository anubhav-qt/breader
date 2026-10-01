import { useSyncExternalStore } from 'react';
import type { Sentence } from './narration';

/*
 * Immersive stops at each picture. The page turns to it, at full brightness, and the voice or the
 * light waits on it while a ring in its corner counts down (FlowView): 5 s at 320 words a minute,
 * longer at slower paces. A tap goes on sooner, and a finger held down keeps the picture there
 * until it lets go (Reader.tsx). Nobody looks at a hidden page, so that goes on at once.
 */

export interface Look {
  section: number;
  /** Which of the chapter's pictures (Sentence.pic). */
  pic: number;
  /** A finger is down: the time left waits. */
  held: boolean;
}

let shown: Look | null = null;
let total = 1;
let left = 0;
let since = 0;
let timer = 0;
let finish: (() => void) | null = null;
const subs = new Set<() => void>();
const tell = () => subs.forEach((f) => f());

/** How long a picture is looked at, at a pace in words a minute. */
export const lookFor = (wpm: number) => Math.round(Math.min(8000, Math.max(3500, 5000 * Math.sqrt(320 / Math.max(60, wpm)))));

const count = () => {
  window.clearTimeout(timer);
  since = performance.now();
  timer = window.setTimeout(stopLook, left);
};

/** Lets go of the picture: its time ran out, a tap went on, or the voice or the light stopped. */
export function stopLook() {
  window.clearTimeout(timer);
  const f = finish;
  finish = null;
  if (shown) {
    shown = null;
    tell();
  }
  f?.();
}

/** Waits on a picture for `ms`. `end` lets go of it early, if it's still the one shown. */
export function lookAt(s: Sentence, ms: number) {
  stopLook();
  const mine: Look = { section: s.section, pic: s.pic ?? 0, held: false };
  shown = mine;
  total = left = ms;
  const done = new Promise<void>((r) => { finish = r; });
  count();
  tell();
  return { done, end: () => { if (shown?.section === mine.section && shown.pic === mine.pic) stopLook(); } };
}

/** A finger down keeps the picture; lifted, the time runs again, with at least a moment left. */
export function keepLooking(on: boolean) {
  if (!shown || shown.held === on) return;
  if (on) {
    window.clearTimeout(timer);
    left = Math.max(0, left - (performance.now() - since));
  } else {
    left = Math.max(left, 1500);
    count();
  }
  shown = { ...shown, held: on };
  tell();
}

/** How much of its time is left, from 1 to 0, for the ring. */
export function lookLeft() {
  if (!shown) return 0;
  const l = shown.held ? left : left - (performance.now() - since);
  return Math.max(0, Math.min(1, l / total));
}

export const looking = () => shown;

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => { subs.delete(f); };
};
export const useLook = () => useSyncExternalStore(subscribe, looking);

if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (document.hidden) stopLook(); });
