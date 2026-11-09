import { useSyncExternalStore } from 'react';
import { devicePace, measure, processorScore } from '../audiobook/speed';

/*
 * What this device can do itself, checked as a book opens, while it loads: read aloud with
 * Normal's voices (Piper, on the processor), and find a manga's panels with the panel model.
 * Whatever it can do, it does, and Breader's computer never does it for it. Only what it's too weak
 * for is done there, by itself, with no switch; while Breader's computer can't (full, away, or not
 * open to this account), the device tries anyway.
 *
 * Nothing about the device leaves it: the check runs here (a quarter of a second of sums in a
 * worker, speed.ts, and whether the browser lends a graphics chip), and is kept here.
 */

/** Sound made this many times faster than it's said, on one engine, stays ahead of the voice. */
const LIVE = 1.5;
/** The processor's score (speed.ts) at which the panel model finds a page in a second or two, with no graphics chip. */
const PANELS_SCORE = 0.5;

let gpu: boolean | null = null;
let asked: Promise<boolean> | null = null;
/** The panel model started and stopped here, or couldn't run (not just couldn't be fetched). */
let broke = false;

/**
 * Whether this device can hold the model. Not a phone or tablet with Safari underneath (every browser
 * on an iPhone or iPad is), which lets a tab go at about a gigabyte and a half: the model working
 * through 1024-pixel squares on top of a manga's pictures took it past that on an iPhone 13, and the
 * tab crashed every time the manga opened again. Nor a device that says it has under 4 GB.
 */
export function modelFits(): boolean {
  const ua = navigator.userAgent;
  const apple = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return !apple && !(memory !== undefined && memory < 4);
}

/** Whether the browser lends a graphics chip (WebGPU), where the model takes a tenth of a second a page. */
export const gpuHere = () => (asked ??= (async () => {
  const g = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
  return !!(await g?.requestAdapter().catch(() => null));
})());

let checking: Promise<void> | null = null;
const subs = new Set<() => void>();
let shown = { voice: true, panels: true };
const tell = () => {
  const next = { voice: voiceHere(), panels: panelsHere() };
  if (next.voice === shown.voice && next.panels === shown.panels) return;
  shown = next;
  subs.forEach((f) => f());
};

/** Checks the device, once; later books find it known. Quiet if it can't: the device is then taken as able. */
export function checkDevice(): Promise<void> {
  checking ??= Promise.all([
    measure(),
    gpuHere().then((g) => { gpu = g; }, () => { gpu = false; }),
  ]).then(tell, tell);
  return checking;
}

/**
 * Reads aloud itself: it runs a voice engine at all, has the memory for one (about 300 MB), and
 * makes sound fast enough to stay ahead, as measured making an audiobook here, or else guessed from
 * the processor's score. Until that's known, a phone is guessed able, as most are.
 */
export function voiceHere(): boolean {
  if (typeof WebAssembly !== 'object' || typeof Worker === 'undefined') return false;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (memory !== undefined && memory < 2) return false;
  return devicePace('piper', 'min') >= LIVE;
}

/**
 * Finds panels itself: it can hold the model (panelModel.ts modelFits: never an iPhone or iPad,
 * whose tab crashed with it), the model hasn't broken here, and it has a graphics chip for it or a
 * processor quick enough without one. Until the check's done, it's taken as able.
 */
export function panelsHere(): boolean {
  if (!modelFits() || broke) return false;
  if (gpu !== false) return true;
  return (processorScore() ?? PANELS_SCORE) >= PANELS_SCORE;
}

/** The panel model broke here (panelModel.ts): Breader's computer finds them from now on. */
export function modelBroke() {
  broke = true;
  tell();
}
export const panelModelBroke = () => broke;

if (typeof navigator !== 'undefined') shown = { voice: voiceHere(), panels: panelsHere() };

/** What this device does itself, as it changes. */
export const useAble = () => useSyncExternalStore(
  (f) => { subs.add(f); return () => { subs.delete(f); }; },
  () => shown,
);
