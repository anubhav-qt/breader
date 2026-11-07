import { useSyncExternalStore } from 'react';
import { store } from '../../lib/store';
import { madeOf, onMade, partKey, setAt, type Engine } from './audiobooks';

/*
 * Plays an audiobook, a paragraph at a time, through one <audio> element of its own, so a phone
 * keeps it going with the screen locked and its lock screen and a headset's buttons work it: play,
 * pause, and back or on a paragraph. While the book is still being made it plays what's made, and
 * at the edge of that waits for the next paragraph, and carries on when it's there.
 */

export interface PlayerState {
  id: string | null;
  engine: Engine | null;
  at: number;
  playing: boolean;
  /** At the edge of what's made, waiting for the next paragraph. */
  waiting: boolean;
}

let state: PlayerState = { id: null, engine: null, at: 0, playing: false, waiting: false };
let stopWaiting: (() => void) | null = null;
const subs = new Set<() => void>();
const set = (patch: Partial<PlayerState>) => {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
};
/** Now, outside React. */
export const now = () => state;
export const usePlayer = () => useSyncExternalStore(
  (f) => { subs.add(f); return () => { subs.delete(f); }; },
  () => state,
);

let el: HTMLAudioElement | null = null;
let url: string | null = null;
let about = { title: '', author: '', chapter: '' };

function audio() {
  if (el) return el;
  el = new Audio();
  el.preload = 'auto';
  el.addEventListener('ended', () => {
    const { id, engine } = state;
    const m = id && engine ? madeOf(id, engine) : undefined;
    const next = state.at + 1;
    if (!m || !id || !engine || next >= m.total) { set({ playing: false }); return; }
    if (next < m.done) { void go(next, true); return; }
    // Not made yet: it plays once it is.
    set({ playing: false, waiting: true });
    const off = onMade(() => {
      const now = madeOf(id, engine);
      if (!now || now.state === 'failed' || now.state === 'paused' || state.id !== id) { wait(null); return; }
      if (now.done > next) { wait(null); void go(next, true); }
    });
    wait(off);
  });
  el.addEventListener('pause', () => { if (!el!.ended) set({ playing: false }); });
  el.addEventListener('play', () => set({ playing: true }));
  const session = navigator.mediaSession;
  if (session) {
    const on = (a: MediaSessionAction, f: () => void) => { try { session.setActionHandler(a, f); } catch { /* not this one */ } };
    on('play', () => void play());
    on('pause', () => pause());
    on('previoustrack', () => void step(-1));
    on('nexttrack', () => void step(1));
  }
  return el;
}

function wait(off: (() => void) | null) {
  stopWaiting?.();
  stopWaiting = off;
  if (!off) set({ waiting: false });
}

/** Opens an audiobook at the paragraph it was at, without playing it. */
export function open(id: string, engine: Engine, book: { title: string; author: string }) {
  if (state.id !== id || state.engine !== engine) {
    pause();
    set({ id, engine, at: madeOf(id, engine)?.at ?? 0, playing: false, waiting: false });
    if (url) { URL.revokeObjectURL(url); url = null; }
    if (el) el.removeAttribute('src');
  }
  about = { ...about, ...book };
}

/** `from`: where in the paragraph to start, in seconds; below 0, that far before its end. */
async function go(n: number, playing: boolean, from = 0) {
  const { id, engine } = state;
  if (!id || !engine) return;
  const m = madeOf(id, engine);
  if (!m) return;
  wait(null);
  // Only what's made so far.
  const at = Math.max(0, Math.min(m.done - 1, n));
  set({ at });
  setAt(id, engine, at);
  const blob = await store.get<Blob>(partKey(id, engine, at));
  if (state.id !== id || state.engine !== engine || state.at !== at) return;
  const a = audio();
  if (url) URL.revokeObjectURL(url);
  url = blob ? URL.createObjectURL(blob) : null;
  if (!url) { set({ playing: false }); return; }
  a.src = url;
  if (from) {
    await new Promise<void>((done) => {
      if (a.readyState >= 1) { done(); return; }
      a.addEventListener('loadedmetadata', () => done(), { once: true });
      a.addEventListener('error', () => done(), { once: true });
    });
    if (state.id !== id || state.engine !== engine || state.at !== at) return;
    const d = Number.isFinite(a.duration) ? a.duration : 0;
    a.currentTime = Math.max(0, Math.min(Math.max(0, d - 0.05), from < 0 ? d + from : from));
  }
  const chapter = [...m.chapters].reverse().find((c) => c.from <= at);
  about.chapter = chapter?.title ?? '';
  if (navigator.mediaSession && typeof MediaMetadata !== 'undefined') {
    navigator.mediaSession.metadata = new MediaMetadata({ title: about.chapter || about.title, artist: about.author, album: about.title });
  }
  if (playing) await a.play().catch(() => set({ playing: false }));
}

export async function play() {
  const a = audio();
  if (state.waiting) return;
  if (a.src && !a.ended) {
    await a.play().catch(() => set({ playing: false }));
    return;
  }
  // Finished the last one heard: on to the next, if it's made.
  const m = state.id && state.engine ? madeOf(state.id, state.engine) : undefined;
  await go(a.ended && m && state.at + 1 < m.done ? state.at + 1 : state.at, true);
}

export function pause() {
  wait(null);
  el?.pause();
  set({ playing: false });
}

/** Play or pause, as its button does. */
export function toggle() {
  if (state.playing) { pause(); return Promise.resolve(); }
  return play();
}

/** An audiobook is open in it, and not waiting for its next paragraph. */
export const usable = () => !!state.id && !state.waiting;

/** Back or on a paragraph, playing if it was. */
export const step = (by: number) => inTurn(() => go(state.at + by, state.playing || !!(el && !el.paused)));

/**
 * Back or on some seconds, as live reading's arrows do: past the paragraph's start or end, into
 * the one before or after, if it's made. Playing if it was.
 */
export const nudge = (seconds: number) => inTurn(() => nudgeNow(seconds));

/** One after another, so keys pressed quickly each start from where the last left it. */
let turn: Promise<unknown> = Promise.resolve();
function inTurn(f: () => Promise<void>) {
  const next = turn.then(f, f);
  turn = next.catch(() => {});
  return next;
}

async function nudgeNow(seconds: number) {
  const { id, engine } = state;
  const m = id && engine ? madeOf(id, engine) : undefined;
  if (!m || state.waiting) return;
  const playing = state.playing || !!(el && !el.paused);
  const a = el;
  // Nothing loaded yet: from the start of the paragraph it's at.
  if (!a || !a.src) {
    if (seconds > 0) await go(state.at, playing, seconds);
    else if (state.at > 0) await go(state.at - 1, playing, seconds);
    return;
  }
  const d = Number.isFinite(a.duration) ? a.duration : 0;
  const t = (a.ended ? d : a.currentTime) + seconds;
  if (t < 0) {
    if (state.at > 0) await go(state.at - 1, playing, t);
    else a.currentTime = 0;
  } else if (d && t >= d) {
    if (state.at + 1 < m.done) await go(state.at + 1, playing, t - d);
    else a.currentTime = Math.max(0, d - 0.05);
  } else {
    a.currentTime = t;
  }
}

/** To a paragraph, from the bar. */
export const seek = (n: number) => go(n, state.playing);

/** The dialog closed, or the audiobook went: it stops. */
export function close() {
  pause();
  if (url) { URL.revokeObjectURL(url); url = null; }
  if (el) el.removeAttribute('src');
  if (navigator.mediaSession) navigator.mediaSession.metadata = null;
  set({ id: null, engine: null, at: 0, playing: false, waiting: false });
}
