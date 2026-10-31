/*
 * The panel model's answers made into a page's panels, the same way the labeller's guesser does
 * (ai/panels/model/guess.py), so a page reads alike on the laptop (server panels/), on a reader's
 * device (the app's panelModel.ts) and in the labeller: what it's sure of, each panel once, its
 * four corners where they make sense, in the order the page is read. And a picture made into what
 * the model sees, the same way in both.
 */

/** The side of the square the model sees a picture in, in pixels (ai/panels/model/pages.py). */
export const SIZE = 1024;
/** A picture this many times taller than it's wide is a strip, looked at a window at a time. */
const TALLEST = 2;
/** How sure the model has to be of a panel to keep it. */
const SURE = 0.3;
/** Two guesses at one panel overlap at least this much, and the less sure goes (Ultralytics' NMS). */
const SAME = 0.7;
/** A panel this close to a window's cut, in pixels, may be cut by it. */
const NEAR = 4;
/** The grey the model's square is padded with around a picture. */
export const PAD = 114;

type Pt = [number, number];
/** x0, y0, x1, y1 in pixels. */
type Rect = [number, number, number, number];

export interface Found {
  box: Rect;
  quad: Pt[];
  sure: number;
  cut: boolean;
}

/** How a window of the picture sits in the model's square: scaled by `r`, then moved by `left`, `top`. */
export interface Fit {
  r: number;
  w: number;
  h: number;
  left: number;
  top: number;
}

/** The rows of a picture the model looks at, as [top, bottom]: all of it, or a strip's windows, overlapping by half. */
export function windows(width: number, height: number): Array<[number, number]> {
  if (height <= width * TALLEST) return [[0, height]];
  const tall = width * TALLEST;
  const out: Array<[number, number]> = [];
  for (let t = 0; t < height - tall; t += Math.floor(tall / 2)) out.push([t, t + tall]);
  out.push([height - tall, height]);
  return out;
}

/** Python's round: halves to even, as the guesser rounds. */
function pyRound(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Where a window w by h goes in the model's square, as Ultralytics' letterbox puts it. */
export function fitOf(w: number, h: number): Fit {
  const r = Math.min(SIZE / h, SIZE / w);
  const nw = pyRound(w * r);
  const nh = pyRound(h * r);
  const dw = (SIZE - nw) / 2;
  const dh = (SIZE - nh) / 2;
  return { r, w: nw, h: nh, left: pyRound(dw - 0.1), top: pyRound(dh - 0.1) };
}

const area = (b: Rect) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const overlap = (a: Rect, b: Rect) => area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
function iou(a: Rect, b: Rect) {
  const both = overlap(a, b);
  return both / ((area(a) + area(b) - both) || 1);
}
const cornersOf = (b: Rect): Pt[] => [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];

/** Whether four corners make a panel: they turn the same way all round. */
function sensible(q: Pt[]) {
  const turns = q.map((a, i) => {
    const b = q[(i + 1) % 4];
    const c = q[(i + 2) % 4];
    return (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
  });
  return turns.every((t) => t > 0) || turns.every((t) => t < 0);
}

const shoelace = (q: Pt[]) => Math.abs(q.reduce((s, a, i) => s + a[0] * q[(i + 1) % 4][1] - q[(i + 1) % 4][0] * a[1], 0)) / 2;

/** How sure the model has to be of a corner to take it wherever it puts it. */
const CORNER = 0.5;
/**
 * A corner it's less sure of is taken this close to its panel's box, as a share of the box's shorter
 * side: a corner on the page's edge is always one, as it learned those as out of sight (training
 * crops pages), though it puts them where they are.
 */
const ON_BOX = 0.1;

/**
 * A panel's corners in whole pixels: where the model puts them, but its box's for one it's unsure
 * of away from the box, all four when it's sure of none, and when they don't make a sensible panel.
 */
function quadOf(points: Array<[number, number, number]>, box: Rect, w: number, h: number): Pt[] {
  const whole = (x: number, y: number): Pt => [Math.trunc(Math.min(Math.max(pyRound(x), 0), w)), Math.trunc(Math.min(Math.max(pyRound(y), 0), h))];
  const square = cornersOf(box).map(([x, y]) => whole(x, y));
  if (points.every(([, , sure]) => sure < CORNER)) return square;
  const near = ON_BOX * Math.min(box[2] - box[0], box[3] - box[1]);
  const onBox = (x: number, y: number) => Math.min(Math.abs(x - box[0]), Math.abs(x - box[2]), Math.abs(y - box[1]), Math.abs(y - box[3])) <= near;
  const q = points.map(([x, y, sure], i) => (sure >= CORNER || onBox(x, y) ? whole(x, y) : square[i]));
  if (!sensible(q) || shoelace(q) < 0.6 * area(box)) return square;
  return q;
}

/**
 * One window's panels from the model's answer, `out` as it comes ([1, 17, n]: box, how sure, and
 * four corners each with how sure), in the page's pixels.
 */
export function panelsIn(out: Float32Array, n: number, fit: Fit, span: [number, number], last: boolean, first: boolean, w: number, h: number): Found[] {
  const [top, bottom] = span;
  const raw: Array<{ box: Rect; sure: number; i: number }> = [];
  for (let i = 0; i < n; i++) {
    const sure = out[4 * n + i];
    if (sure <= SURE) continue;
    const cx = out[i];
    const cy = out[n + i];
    const bw = out[2 * n + i];
    const bh = out[3 * n + i];
    raw.push({ box: [cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2], sure, i });
  }
  raw.sort((a, b) => b.sure - a.sure);
  const kept: typeof raw = [];
  for (const f of raw) {
    if (kept.length >= 300) break;
    if (kept.every((k) => iou(f.box, k.box) <= SAME)) kept.push(f);
  }
  const tall = bottom - top;
  const x = (v: number) => Math.min(Math.max((v - fit.left) / fit.r, 0), w);
  const y = (v: number) => Math.min(Math.max((v - fit.top) / fit.r, 0), tall) + top;
  return kept.map(({ box: b, sure, i }) => {
    const box: Rect = [x(b[0]), y(b[1]), x(b[2]), y(b[3])];
    const points: Array<[number, number, number]> = [0, 1, 2, 3].map((k) => [x(out[(5 + 3 * k) * n + i]), y(out[(6 + 3 * k) * n + i]), out[(7 + 3 * k) * n + i]]);
    const cut = (!first && box[1] <= top + NEAR) || (!last && box[3] >= bottom - NEAR);
    return { box, quad: quadOf(points, box, w, h), sure, cut };
  });
}

/** A strip's panels from its windows, each once: whole ones first, then pieces a cut left, joined up. */
export function merged(found: Found[]): Found[] {
  const kept: Found[] = [];
  for (const f of found.filter((f) => !f.cut).sort((a, b) => b.sure - a.sure)) {
    if (kept.every((k) => iou(f.box, k.box) < 0.5)) kept.push(f);
  }
  const pieces = found.filter((f) => f.cut && !kept.some((k) => overlap(f.box, k.box) >= 0.7 * area(f.box)));
  const joined: Found[] = [];
  for (const f of pieces.sort((a, b) => a.box[1] - b.box[1])) {
    const a = f.box;
    const j = joined.find(({ box: b }) => {
      const across = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
      return across >= 0.5 * Math.min(a[2] - a[0], b[2] - b[0]) && Math.min(a[3], b[3]) > Math.max(a[1], b[1]);
    });
    if (j) {
      const b = j.box;
      j.box = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
      j.quad = cornersOf(j.box);
      j.sure = Math.max(j.sure, f.sure);
    } else {
      joined.push({ ...f });
    }
  }
  return [...kept, ...joined];
}

/**
 * How far a panel may reach past the gutter into the next row or column, as a share of the smaller
 * one's height (or width): the model's corners are a few pixels off, more so on bigger panels.
 */
const SLACK = 0.1;
/** The steepest a gutter between rows or columns is looked for, in degrees either way of straight. */
const STEEPEST = 20;
/** Two panels side by side, their heights overlapping by this share of the shorter's, are one row; stacked, widths, one column. */
const BESIDE = 0.5;

/** How far along (ux, uy) a panel's corners reach, least and most. */
function spanOf(q: Pt[], ux: number, uy: number): [number, number] {
  const v = q.map(([x, y]) => x * ux + y * uy);
  return [Math.min(...v), Math.max(...v)];
}
const mid = (s: [number, number]) => (s[0] + s[1]) / 2;
const besideOf = (a: [number, number], b: [number, number]) => Math.min(a[1], b[1]) - Math.max(a[0], b[0]) > BESIDE * Math.min(a[1] - a[0], b[1] - b[0]);
/** Straight first, then a degree more either way at a time. */
const ANGLES = [0, ...Array.from({ length: STEEPEST }, (_, i) => [i + 1, -(i + 1)]).flat()];

/**
 * The panels the page is read in: cut into rows top to bottom, and across them right to left, by
 * their corners, so a gutter can slant. What can't be cut is read a panel at a time, each beside
 * another after the one to its right, and each below another after it (before).
 */
export function ordered(found: Found[]): Found[] {
  /**
   * The first row of `items` (or right column, `across`) and the rest, split by a gutter as
   * straight as there is: every panel of the first ends before every one of the rest begins, give
   * or take SLACK. Two on either side of the gutter, neither across it from the other, mustn't sit
   * beside each other (or one above the other, `across`): that's a gutter through a row (or a column).
   */
  const split = (items: Found[], across: boolean): [Found[], Found[]] | null => {
    const side = items.map((f) => (across ? spanOf(f.quad, 1, 0) : spanOf(f.quad, 0, 1)));
    for (const deg of ANGLES) {
      const t = (deg * Math.PI) / 180;
      const [c, n] = [Math.cos(t), Math.sin(t)];
      // How far down the page square to a row's gutter (or right, square to a column's), and how far along it.
      const s = items.map((f) => (across ? spanOf(f.quad, c, n) : spanOf(f.quad, -n, c)));
      const along = items.map((f) => (across ? spanOf(f.quad, -n, c) : spanOf(f.quad, c, n)));
      const order = items.map((_, i) => i).sort((i, j) => (across ? mid(s[j]) - mid(s[i]) : mid(s[i]) - mid(s[j])));
      for (let k = 1; k < order.length; k++) {
        const first = order.slice(0, k);
        const rest = order.slice(k);
        const apart = first.every((i) =>
          rest.every((j) => {
            const reach = across ? s[j][1] - s[i][0] : s[i][1] - s[j][0];
            const facing = Math.min(along[i][1], along[j][1]) > Math.max(along[i][0], along[j][0]);
            return reach <= SLACK * Math.min(s[i][1] - s[i][0], s[j][1] - s[j][0]) && (facing || !besideOf(side[i], side[j]));
          }),
        );
        if (apart) return [first.map((i) => items[i]), rest.map((i) => items[i])];
      }
    }
    return null;
  };
  const cut = (items: Found[]): Found[] => {
    if (items.length < 2) return items;
    const parts = split(items, false) ?? split(items, true);
    if (parts) return [...cut(parts[0]), ...cut(parts[1])];
    const ys = items.map((f) => spanOf(f.quad, 0, 1));
    const xs = items.map((f) => spanOf(f.quad, 1, 0));
    const at = items.map((f) => [f.quad.reduce((t, c) => t + c[0], 0) / f.quad.length, f.quad.reduce((t, c) => t + c[1], 0) / f.quad.length]);
    /** Of two beside each other the right one is read first, of two stacked the upper, and otherwise whichever way they're further apart says. */
    const before = (a: number, b: number) => {
      const beside = besideOf(ys[a], ys[b]);
      const stacked = besideOf(xs[a], xs[b]);
      const across = beside === stacked ? Math.abs(at[a][0] - at[b][0]) > Math.abs(at[a][1] - at[b][1]) : beside;
      return across ? at[a][0] > at[b][0] : at[a][1] < at[b][1];
    };
    // Each once none left is read before it; of those that go round, the topmost.
    const left = items.map((_, i) => i).sort((i, j) => at[i][1] - at[j][1]);
    const out: Found[] = [];
    while (left.length) {
      const k = left.findIndex((a) => !left.some((b) => b !== a && before(b, a)));
      out.push(items[left.splice(Math.max(k, 0), 1)[0]]);
    }
    return out;
  };
  return cut(found);
}

/**
 * A window scaled into the model's square the way OpenCV's bilinear resize does it, as the model
 * was trained and checked on: each pixel from the four nearest, with no smoothing first. Another
 * resize moves the corners the model's less sure of by tens of pixels. `px` is the picture's pixels,
 * `channels` to each (3 from the laptop's decoder, 4 from a canvas), red first.
 */
export function squareOf(px: ArrayLike<number>, w: number, channels: number, [top, bottom]: [number, number], fit: Fit): Float32Array {
  const plane = SIZE * SIZE;
  const input = new Float32Array(3 * plane).fill(PAD / 255);
  const sx = w / fit.w;
  const sy = (bottom - top) / fit.h;
  const last = bottom - top - 1;
  for (let y = 0; y < fit.h; y++) {
    const fy = Math.min(Math.max((y + 0.5) * sy - 0.5, 0), last);
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, last);
    const ay = fy - y0;
    const r0 = (top + y0) * w * channels;
    const r1 = (top + y1) * w * channels;
    const to = (y + fit.top) * SIZE + fit.left;
    for (let x = 0; x < fit.w; x++) {
      const fx = Math.min(Math.max((x + 0.5) * sx - 0.5, 0), w - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(x0 + 1, w - 1) * channels;
      const ax = fx - x0;
      const a = x0 * channels;
      for (let c = 0; c < 3; c++) {
        const v0 = px[r0 + a + c] * (1 - ax) + px[r0 + x1 + c] * ax;
        const v1 = px[r1 + a + c] * (1 - ax) + px[r1 + x1 + c] * ax;
        input[c * plane + to + x] = Math.round(v0 * (1 - ay) + v1 * ay) / 255;
      }
    }
  }
  return input;
}

/** A page's panels from the model's answer for each of its windows, `outs[k]` as it comes ([1, 17, n]). */
export function pagePanels(outs: Array<{ out: Float32Array; n: number; fit: Fit; span: [number, number] }>, w: number, h: number): { panels: Pt[][]; sure: number[] } {
  const found: Found[] = [];
  for (const [k, o] of outs.entries()) found.push(...panelsIn(o.out, o.n, o.fit, o.span, k === outs.length - 1, k === 0, w, h));
  const panels = ordered(outs.length > 1 ? merged(found) : found);
  return { panels: panels.map((p) => p.quad), sure: panels.map((p) => Math.round(p.sure * 1000) / 1000) };
}
