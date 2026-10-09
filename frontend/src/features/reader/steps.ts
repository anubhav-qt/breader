import { same, type Box, type Frames } from './frames';

/*
 * A page read a panel at a time: its steps, in the order they're read. A page whose panels can't
 * be told apart is read as a whole, or in quarters, as the fallback picked says.
 */

/**
 * A page held where no panel can be told apart: brought closer around the finger, to look about
 * (as before panels could be stepped through), fitted to the screen whole, or read in quarters.
 */
export type Fallback = 'closer' | 'whole' | 'quarters';

export const FALLBACKS: Array<{ v: Fallback; label: string }> = [
  { v: 'closer', label: 'closer' },
  { v: 'whole', label: 'whole' },
  { v: 'quarters', label: 'quarters' },
];

/** Until one is picked for good, development builds try each (the preview bar's ?held=). */
export const FALLBACK: Fallback = 'closer';

export function fallbackOf(): Fallback {
  if (!import.meta.env.DEV) return FALLBACK;
  const v = new URLSearchParams(window.location.search).get('held');
  const picked = FALLBACKS.find((f) => f.v === v);
  if (picked) return picked.v;
  return FALLBACK;
}

/** The whole page, as a step. */
export const WHOLE: Box = { x: 0, y: 0, w: 1, h: 1 };

/** The page's quarters, in the order they're read: the top two first, right to left or left to right. */
function quartersOf(rtl: boolean): Box[] {
  const right = [{ x: 0.5, y: 0, w: 0.5, h: 0.5 }, { x: 0, y: 0, w: 0.5, h: 0.5 }, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, { x: 0, y: 0.5, w: 0.5, h: 0.5 }];
  if (rtl) return right;
  return [right[1], right[0], right[3], right[2]];
}

/** A page's steps in the order they're read: its panels, or with none, the page whole or in quarters. */
export function stepsOf(frames: Frames, rtl: boolean, fallback: Fallback): Box[] {
  const panels = rtl ? frames.rtl : frames.ltr;
  if (panels.length) return panels;
  if (fallback === 'quarters') return quartersOf(rtl);
  return [WHOLE];
}

/** Which steps a part of the page shows: the panel it is, or the panels in it, a group's. */
export function shownOf(steps: Box[], box: Box): { from: number; to: number } | null {
  const k = steps.findIndex((s) => same(s, box));
  if (k >= 0) return { from: k, to: k };
  const slack = 0.005;
  let from = -1;
  let to = -1;
  steps.forEach((s, i) => {
    const inside = s.x >= box.x - slack && s.y >= box.y - slack && s.x + s.w <= box.x + box.w + slack && s.y + s.h <= box.y + box.h + slack;
    if (!inside) return;
    if (from < 0) from = i;
    to = i;
  });
  if (from < 0) return null;
  return { from, to };
}

/** The step a point on the page is in, or the nearest. */
export function stepAt(steps: Box[], x: number, y: number): number {
  let best = 0;
  let near = Infinity;
  steps.forEach((s, i) => {
    const d = Math.hypot(Math.max(s.x - x, 0, x - s.x - s.w), Math.max(s.y - y, 0, y - s.y - s.h));
    if (d < near) {
      near = d;
      best = i;
    }
  });
  return best;
}
