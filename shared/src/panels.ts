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

/** A panel's corners in whole pixels: its box's where the model isn't sure of one, and all four when they don't make a sensible panel. */
function quadOf(points: Array<[number, number, number]>, box: Rect, w: number, h: number): Pt[] {
  const whole = (x: number, y: number): Pt => [Math.trunc(Math.min(Math.max(pyRound(x), 0), w)), Math.trunc(Math.min(Math.max(pyRound(y), 0), h))];
  const square = cornersOf(box).map(([x, y]) => whole(x, y));
  const q = points.map(([x, y, sure], i) => (sure >= 0.5 ? whole(x, y) : square[i]));
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

/** Panels in the order they're read: cut into rows top to bottom, then across right to left. */
export function ordered(found: Found[], w: number, h: number): Found[] {
  const sx = 0.02 * w;
  const sy = 0.02 * h;
  const cut = (items: Found[]): Found[] => {
    if (items.length < 2) return items;
    for (const y of [...new Set(items.map((f) => f.box[3]))].sort((a, b) => a - b)) {
      const above = items.filter((f) => f.box[3] <= y + sy);
      const below = items.filter((f) => f.box[3] > y + sy);
      if (above.length && below.length && below.every((f) => f.box[1] >= y - sy)) return [...cut(above), ...cut(below)];
    }
    for (const x of [...new Set(items.map((f) => f.box[0]))].sort((a, b) => b - a)) {
      const right = items.filter((f) => f.box[0] >= x - sx);
      const left = items.filter((f) => f.box[0] < x - sx);
      if (right.length && left.length && left.every((f) => f.box[2] <= x + sx)) return [...cut(right), ...cut(left)];
    }
    return [...items].sort((a, b) => a.box[1] - b.box[1] || b.box[2] - a.box[2]);
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
  const panels = ordered(outs.length > 1 ? merged(found) : found, w, h);
  return { panels: panels.map((p) => p.quad), sure: panels.map((p) => Math.round(p.sure * 1000) / 1000) };
}
