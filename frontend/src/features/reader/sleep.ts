import { useCallback, useEffect, useRef, useState } from 'react';
import { readLocal, writeLocal } from '../../lib/store';
import type { Sentence } from './narration';

/*
 * Did you sleep? A voice reads on by itself, so a reader who drifts off wakes chapters later. While
 * it reads and nobody touches anything (the page, a key, a headset's button, the lock screen), a
 * checkpoint is kept every five minutes: the time, and the sentence it had got to. The next touch,
 * or the page coming back into sight, asks whether they slept, with the checkpoints to go back to.
 * An hour untouched, the voice fades out over its last few sentences and stops there.
 *
 * Kept on the device too, so a browser that closed the tab overnight still asks in the morning.
 */

export interface Checkpoint {
  at: number;
  s: Sentence;
}

/** What's asked about: the last touch, the checkpoints since, and where the voice stopped by itself. */
export interface Asleep {
  touch: number;
  /** The sentence being read at the last touch, or the first one after it. */
  touched: Sentence | null;
  points: Checkpoint[];
  stopped: Checkpoint | null;
}

/** Given to the voice (narration.ts): asked before each sentence, and told of presses from outside. */
export interface SleepWatch {
  /** How loud to say this sentence, 0 to 1. 0: it slept, stop here. */
  before: (s: Sentence) => number;
  touched: () => void;
}

const EVERY_MS = 5 * 60_000;
const FADE_AT_MS = 60 * 60_000;
/** The fade: about this long, a sentence at a time. Phones that won't turn a voice down just stop. */
const FADE_MS = 20_000;
/** Checkpoints left from longer ago than this aren't asked about. */
const STALE_MS = 24 * 3600_000;
const KEY = 'breader.sleep.v1';

type Stored = Asleep & { book: string };

export function useSleepWatch(book: string, active: boolean, current: () => Sentence | null) {
  const state = useRef<Asleep>({ touch: Date.now(), touched: null, points: [], stopped: null });
  const [asked, setAsked] = useState<Asleep | null>(null);
  const currentRef = useRef(current);
  currentRef.current = current;

  const keep = () => writeLocal(KEY, { ...state.current, book } satisfies Stored);

  /** A touch: if it slept since the last one, ask; either way, count from now. */
  const touched = useCallback(() => {
    const st = state.current;
    if (st.points.length || st.stopped) {
      setAsked({ ...st, points: [...st.points] });
      writeLocal(KEY, null);
    }
    state.current = { touch: Date.now(), touched: currentRef.current(), points: [], stopped: null };
  }, []);

  const before = useCallback((s: Sentence) => {
    const st = state.current;
    const now = Date.now();
    const since = now - st.touch;
    // A touch that started the voice had no sentence yet: the first one after it stands for it.
    st.touched ??= s;
    if (now >= st.touch + EVERY_MS * (st.points.length + 1)) {
      st.points.push({ at: now, s });
      keep();
    }
    if (since >= FADE_AT_MS + FADE_MS) {
      st.stopped = { at: now, s };
      keep();
      return 0;
    }
    return since >= FADE_AT_MS ? Math.max(0.15, 1 - (since - FADE_AT_MS) / FADE_MS) : 1;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book]);

  // Checkpoints from a tab the browser closed, asked about as the book opens again.
  useEffect(() => {
    const kept = readLocal<Stored | null>(KEY, null);
    if (!kept || kept.book !== book || Date.now() - kept.touch > STALE_MS) return;
    writeLocal(KEY, null);
    if (kept.points.length || kept.stopped) setAsked(kept);
  }, [book]);

  // Touches, and the page coming back into sight.
  useEffect(() => {
    if (!active) return;
    const opts = { passive: true, capture: true } as const;
    const kinds = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    for (const k of kinds) window.addEventListener(k, touched, opts);
    const seen = () => { if (document.visibilityState === 'visible') touched(); };
    document.addEventListener('visibilitychange', seen);
    return () => {
      for (const k of kinds) window.removeEventListener(k, touched, opts);
      document.removeEventListener('visibilitychange', seen);
    };
  }, [active, touched]);

  const watch = useRef<SleepWatch>({ before, touched });
  watch.current = { before, touched };
  const done = useCallback(() => setAsked(null), []);
  return { watch, asked, done };
}
