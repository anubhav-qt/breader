import { same, type Box, type Frames } from './frames';

/*
 * A page read a panel at a time: its steps, in the order they're read. A page whose panels can't
 * be told apart is read whole, fitted to the screen.
 */

/** The whole page, as a step. */
export const WHOLE: Box = { x: 0, y: 0, w: 1, h: 1 };

/** A page's steps in the order they're read: its panels, or with none, the page whole. */
export function stepsOf(frames: Frames): Box[] {
  if (frames.panels.length) return frames.panels;
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
