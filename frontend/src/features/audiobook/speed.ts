import { useSyncExternalStore } from 'react';
import type { AudiobookEngine } from '@breader/shared/audiobook';
import { readLocal, writeLocal } from '../../lib/store';
import { handheld } from '../../lib/handheld';

/*
 * How fast this device makes an audiobook, and how much of it to use.
 *
 *   Maximum  several voice engines at once, each making its own paragraph. Piper runs on the
 *            processor, so it gets about one engine for every two of its threads, and grows almost
 *            evenly with them: 7.6, 14.5, 25 and 40 times faster than listening with 1, 2, 4 and 6
 *            on an 8-core Ryzen 7 9800X3D. Kokoro runs on the graphics chip, which is the limit: 5.1,
 *            5.6 and 6.3 times with 1, 2 and 3, so it gets two, and no more of the chip's memory.
 *   Minimal  one engine, a sentence at a time, leaving the rest of the device to everything else.
 *
 * More threads in one engine would need a cross-origin isolated page, which breaks covers and
 * logins; several engines get the same out of the processor without it. Kokoro isn't run on
 * several sentences at once: this model pads the shorter ones, which changes how they sound.
 *
 * How long it'll take is guessed from a short check of the processor, done once, when the
 * download dialog first opens; once a book has been made here, from how fast that went.
 */

type Engine = AudiobookEngine;
export type Mode = 'max' | 'min';

interface Kept {
  mode: Mode;
  /** The processor's check, in billions of multiply-adds a second. */
  score?: number;
  /** Minutes of sound made in a minute, as measured making a book here, by engine and mode. */
  pace: Partial<Record<`${Engine}:${Mode}`, number>>;
}

const KEY = 'breader.audiobook-speed.v1';
let kept = readLocal<Kept>(KEY, { mode: 'max', pace: {} });
const subs = new Set<() => void>();
function save(patch: Partial<Kept>) {
  kept = { ...kept, ...patch };
  writeLocal(KEY, kept);
  subs.forEach((f) => f());
}
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

export const useSpeed = () => useSyncExternalStore(subscribe, () => kept);
export const modeNow = () => kept.mode;
export const setMode = (mode: Mode) => save({ mode });
/** The processor's check, once it's been done here (measure). */
export const processorScore = () => kept.score;

/** What the device has to give: threads, memory in GB, and whether it's a phone or tablet. */
export interface Device { cores: number; memory: number; handheld: boolean }

export function device(): Device {
  const hand = handheld();
  const nav = navigator as Navigator & { deviceMemory?: number };
  return { cores: nav.hardwareConcurrency || 2, memory: nav.deviceMemory ?? (hand ? 4 : 8), handheld: hand };
}

/**
 * Engines to run at once. A Piper engine holds about 300 MB, so there's one for every 1.5 GB;
 * a phone gets three at most, to stay cool and keep its other apps.
 */
export function lanesFor(engine: Engine, mode: Mode, d: Device = device()) {
  if (mode === 'min') return 1;
  if (engine === 'kokoro') return d.handheld ? 1 : 2;
  const byCores = Math.round(d.cores * 0.4);
  const byMemory = Math.floor(d.memory / 1.5);
  return Math.max(1, Math.min(byCores, byMemory, d.handheld ? 3 : 6));
}

/** One Piper engine's minutes of sound a minute, for each point of the processor's score. */
const PIPER_PER_POINT = 6;
/** Engines after the first add a little less each: 2 make 1.9 times as much, 6 make 5.3. */
const SPREAD = 0.88;
/** Kokoro on a computer's graphics chip, with one engine and two, until one is measured here. */
const KOKORO: Record<Mode, number> = { min: 5, max: 5.6 };

/** Minutes of sound this device makes in a minute: measured if a book was made here, else guessed. */
export function devicePace(engine: Engine, mode: Mode, k: Kept = kept, d: Device = device()) {
  const measured = k.pace[`${engine}:${mode}`];
  if (measured) return measured;
  if (engine === 'kokoro') return KOKORO[mode];
  const one = (k.score ?? (d.handheld ? 0.4 : 1)) * PIPER_PER_POINT;
  const n = lanesFor(engine, mode, d);
  return one * (n === 1 ? 1 : n * SPREAD);
}

/** Keeps how fast a book is being made here, for the next guess. */
export function learn(engine: Engine, mode: Mode, pace: number) {
  if (!Number.isFinite(pace) || pace <= 0) return;
  save({ pace: { ...kept.pace, [`${engine}:${mode}`]: Math.round(pace * 100) / 100 } });
}

let checking: Promise<void> | null = null;

/** Checks the processor, once on this device; whatever happens, the guess stands without it. */
export function measure() {
  if (kept.score || checking || typeof Worker === 'undefined') return checking ?? Promise.resolve();
  checking = new Promise<void>((resolve) => {
    const w = new Worker(new URL('./speed.worker.ts', import.meta.url), { type: 'module' });
    const done = (score?: number) => {
      w.terminate();
      if (score && Number.isFinite(score)) save({ score: Math.round(score * 1000) / 1000 });
      resolve();
    };
    const timer = setTimeout(() => done(), 5000);
    w.onmessage = (e: MessageEvent<{ score: number }>) => { clearTimeout(timer); done(e.data.score); };
    w.onerror = () => { clearTimeout(timer); done(); };
    w.postMessage(0);
  }).finally(() => { checking = null; });
  return checking;
}

/**
 * Times a book being made here, from its first paragraph made, and keeps its pace for the next
 * guess once there's half a minute of sound to judge by, every few seconds after. Told the
 * seconds of sound each paragraph made.
 */
export function timer(engine: Engine, mode: Mode, now: () => number = () => performance.now()) {
  let start: number | null = null;
  let kept = -Infinity;
  let sound = 0;
  return (seconds: number) => {
    const t = now();
    if (start === null) { start = t; return; }
    sound += seconds;
    if (sound < 30 || t - kept < 5000) return;
    kept = t;
    learn(engine, mode, sound / ((t - start) / 1000));
  };
}
