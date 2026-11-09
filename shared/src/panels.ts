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
/**
 * How sure the model has to be of a panel to keep it, the same as guess.py's. A panel skipped is
 * worse than a box extra: at 0.4, not half, round 20 left 16 panels on its held-back pages with
 * nothing over them, not 21, for 38 extra boxes, not 31.
 */
export const SURE = 0.4;
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

/**
 * How a window of the picture goes to the model, as Ultralytics' letterbox puts it: scaled to `w`
 * by `h`, and put at `left`, `top` in the model's input, `wide` by `tall`; and how the model's pixels
 * go back on the window, less `padX`, `padY`, over `r`, as its scale_boxes does.
 */
export interface Fit {
  wide: number;
  tall: number;
  w: number;
  h: number;
  left: number;
  top: number;
  r: number;
  padX: number;
  padY: number;
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

/** A model whose input's sides are a multiple of this takes a window in the least rectangle round it. */
const STRIDE = 32;

/**
 * Where a window w by h goes in the model's input, as the guesser's (guess.py) predict puts it:
 * scaled so its longer side is SIZE, then, for a model that takes any size (`rect`), padded to the
 * next multiple of STRIDE, and for one that takes only the square, padded to it. The grey is shared
 * either side, the odd pixel after.
 */
export function fitOf(w: number, h: number, rect: boolean): Fit {
  const s = Math.min(SIZE / h, SIZE / w);
  const nw = pyRound(w * s);
  const nh = pyRound(h * s);
  const dw = rect ? (SIZE - nw) % STRIDE : SIZE - nw;
  const dh = rect ? (SIZE - nh) % STRIDE : SIZE - nh;
  const wide = nw + dw;
  const tall = nh + dh;
  const r = Math.min(tall / h, wide / w);
  return {
    wide,
    tall,
    w: nw,
    h: nh,
    left: pyRound(dw / 2 - 0.1),
    top: pyRound(dh / 2 - 0.1),
    r,
    padX: pyRound((wide - pyRound(w * r)) / 2 - 0.1),
    padY: pyRound((tall - pyRound(h * r)) / 2 - 0.1),
  };
}

/** How a model takes its pictures: any size (`rect`) or only the square, and how many at once. */
export interface Takes {
  rect: boolean;
  batch: number;
}

/**
 * How many of a strip's windows go to the model at once, where it takes more than one: two, each
 * half the square, hold what one square page does, so a device that reads a page reads them, in
 * one run, not two.
 */
const BATCH = 2;

/**
 * How a model takes its pictures, by its input's shape: a side named, not numbered, is any size.
 * Unknown, it's the square, one at a time, as every round before 21 was.
 */
export function takesOf(shape: ReadonlyArray<number | string> | undefined): Takes {
  const any = (d: number | string | undefined) => typeof d !== 'number' || d < 0;
  if (!shape || shape.length !== 4) return { rect: false, batch: 1 };
  return { rect: any(shape[2]) || any(shape[3]), batch: any(shape[0]) ? BATCH : 1 };
}

const area = (b: Rect) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const overlap = (a: Rect, b: Rect) => area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
function iou(a: Rect, b: Rect) {
  const both = overlap(a, b);
  return both / ((area(a) + area(b) - both) || 1);
}

/**
 * A panel's corners: all four where the model puts them, in whole pixels on the page, never squared
 * off or moved. The same as the guesser's (ai/panels/model/guess.py).
 */
export function quadOf(points: Array<[number, number, number]>, w: number, h: number): Pt[] {
  return points.map(([x, y]): Pt => [Math.trunc(Math.min(Math.max(pyRound(x), 0), w)), Math.trunc(Math.min(Math.max(pyRound(y), 0), h))]);
}

/**
 * One window's panels from the model's answer, `out` as it comes ([1, 16 + classes, n]: box, how sure of each class, and
 * four corners each with how sure), in the page's pixels.
 */
export function panelsIn(out: Float32Array, n: number, fit: Fit, span: [number, number], last: boolean, first: boolean, w: number, h: number): Found[] {
  const [top, bottom] = span;
  // Each guess is its box, how sure of each class, and four corners: 16 numbers and one per class.
  // A model has one class, a panel; round 8 alone had two kinds of panel, read as one.
  const classes = Math.round(out.length / n) - 16;
  const raw: Array<{ box: Rect; sure: number; i: number }> = [];
  for (let i = 0; i < n; i++) {
    let sure = out[4 * n + i];
    for (let c = 1; c < classes; c++) sure = Math.max(sure, out[(4 + c) * n + i]);
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
  const x = (v: number) => Math.min(Math.max((v - fit.padX) / fit.r, 0), w);
  const y = (v: number) => Math.min(Math.max((v - fit.padY) / fit.r, 0), tall) + top;
  const at = 4 + classes;
  return kept.map(({ box: b, sure, i }) => {
    const box: Rect = [x(b[0]), y(b[1]), x(b[2]), y(b[3])];
    const points: Array<[number, number, number]> = [0, 1, 2, 3].map((k) => [x(out[(at + 3 * k) * n + i]), y(out[(at + 1 + 3 * k) * n + i]), out[(at + 2 + 3 * k) * n + i]]);
    const cut = (!first && box[1] <= top + NEAR) || (!last && box[3] >= bottom - NEAR);
    return { box, quad: quadOf(points, w, h), sure, cut };
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
      // The upper piece's top corners and the lower one's bottom corners, as the model put them.
      j.quad = [j.quad[0], j.quad[1], f.quad[2], f.quad[3]];
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

/** Each 0 to 255 as the model has it, 0 to 1. */
const UNIT = Float32Array.from({ length: 256 }, (_, i) => i / 255);

/** OpenCV's bilinear weights are whole numbers out of this (INTER_RESIZE_COEF_BITS, 11). */
const ONE = 2048;

/**
 * OpenCV's bilinear weights for a side scaled from `src` pixels to `dst`: each pixel's two it's
 * made from, and how much of each, out of ONE, worked out in 32-bit floats as OpenCV does. Across
 * (`edge`), a pixel past the edge takes the edge's; down, only the row is kept on the picture, its
 * weights as they are.
 */
function weightsOf(dst: number, src: number, edge: boolean) {
  const scale = 1 / (dst / src);
  const i0 = new Int32Array(dst);
  const i1 = new Int32Array(dst);
  const w0 = new Int32Array(dst);
  const w1 = new Int32Array(dst);
  for (let d = 0; d < dst; d++) {
    let f = Math.fround((d + 0.5) * scale - 0.5);
    let s = Math.floor(f);
    // Exact in 32 bits as it is.
    f -= s;
    if (edge && s < 0) [f, s] = [0, 0];
    if (edge && s >= src - 1) [f, s] = [0, src - 1];
    i0[d] = Math.min(Math.max(s, 0), src - 1);
    i1[d] = Math.min(Math.max(s + 1, 0), src - 1);
    w0[d] = pyRound(Math.fround(1 - f) * ONE);
    w1[d] = pyRound(f * ONE);
  }
  return { i0, i1, w0, w1 };
}

/**
 * A window scaled into the model's input exactly as the guesser's OpenCV does it (cv2.resize,
 * INTER_LINEAR, on 8-bit pixels), to the last shade: its whole-number weights and its rounding
 * (which make its half size, averaging each four, the same). Even a shade off here and there moves corners the
 * model's unsure of by tens of pixels. `px` is the picture's pixels, `channels` to each (3 from the
 * laptop's decoder, 4 from a canvas), red first; `into` is where it goes, 3 planes of fit.wide by fit.tall.
 */
export function squareOf(px: ArrayLike<number>, w: number, channels: number, [top, bottom]: [number, number], fit: Fit, into = new Float32Array(3 * fit.wide * fit.tall)): Float32Array {
  const { wide, tall } = fit;
  const plane = wide * tall;
  const grey = PAD / 255;
  // Only the grey round the picture is filled: the picture covers the rest.
  for (let c = 0; c < 3; c++) {
    const o = c * plane;
    into.fill(grey, o, o + fit.top * wide);
    into.fill(grey, o + (fit.top + fit.h) * wide, o + plane);
    for (let y = fit.top; y < fit.top + fit.h; y++) {
      into.fill(grey, o + y * wide, o + y * wide + fit.left);
      into.fill(grey, o + y * wide + fit.left + fit.w, o + (y + 1) * wide);
    }
  }
  const h = bottom - top;
  const nw = fit.w;
  const put = (x: number, y: number, c: number, v: number) => {
    into[c * plane + (y + fit.top) * wide + fit.left + x] = UNIT[v];
  };
  const pixel = (x: number, y: number, c: number) => px[((top + y) * w + x) * channels + c];
  if (nw === w && fit.h === h) {
    // Its own size: as it is (Ultralytics doesn't resize it).
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) put(x, y, c, pixel(x, y, c));
    return into;
  }
  const xs = weightsOf(nw, w, true);
  const ys = weightsOf(fit.h, h, false);
  const xa = xs.i0.map((i) => i * channels);
  const xb = xs.i1.map((i) => i * channels);
  // A row of the picture scaled across, as whole numbers (OpenCV's first pass): the last two kept.
  const n = nw * 3;
  const rows = [new Int32Array(n), new Int32Array(n)];
  const held = [-1, -1];
  const rowOf = (sy: number, keep: number) => {
    if (held[0] === sy) return rows[0];
    if (held[1] === sy) return rows[1];
    const k = held[0] === keep ? 1 : 0;
    const out = rows[k];
    const base = (top + sy) * w * channels;
    for (let x = 0; x < nw; x++) {
      const a = base + xa[x];
      const b = base + xb[x];
      const w0 = xs.w0[x];
      const w1 = xs.w1[x];
      for (let c = 0; c < 3; c++) out[x * 3 + c] = px[a + c] * w0 + px[b + c] * w1;
    }
    held[k] = sy;
    return out;
  };
  for (let y = 0; y < fit.h; y++) {
    const s0 = ys.i0[y];
    const s1 = ys.i1[y];
    const r0 = rowOf(s0, s1);
    const r1 = rowOf(s1, s0);
    const b0 = ys.w0[y];
    const b1 = ys.w1[y];
    const to = (y + fit.top) * wide + fit.left;
    for (let c = 0; c < 3; c++) {
      const o = c * plane + to;
      for (let x = 0; x < nw; x++) {
        // OpenCV's second pass, as its vector code does it: each a sixteenth, times its weight's
        // top half, then a quarter, rounded.
        const v = (((r0[x * 3 + c] >> 4) * b0) >> 16) + (((r1[x * 3 + c] >> 4) * b1) >> 16);
        into[o + x] = UNIT[Math.min(Math.max((v + 2) >> 2, 0), 255)];
      }
    }
  }
  return into;
}

/** A page's panels from the model's answer for each of its windows, `outs[k]` as it comes ([1, 16 + classes, n]). */
export function pagePanels(outs: Array<{ out: Float32Array; n: number; fit: Fit; span: [number, number] }>, w: number, h: number): { panels: Pt[][]; sure: number[] } {
  const found: Found[] = [];
  for (const [k, o] of outs.entries()) found.push(...panelsIn(o.out, o.n, o.fit, o.span, k === outs.length - 1, k === 0, w, h));
  const panels = ordered(outs.length > 1 ? merged(found) : found);
  return { panels: panels.map((p) => p.quad), sure: panels.map((p) => Math.round(p.sure * 1000) / 1000) };
}

/**
 * The model on `k` windows at once, each 3 planes of fit.wide by fit.tall one after another: its
 * answer for each in turn ([k, 16 + classes, n]), and n.
 */
export type RunModel = (input: Float32Array, k: number, fit: Fit) => Promise<{ out: Float32Array; n: number }>;

/**
 * A page's panels, found the way the guesser (guess.py) finds them: each window fitted as its
 * predict does, run, and the panels read back, joined up and put in order. `px` is the page's
 * pixels, `channels` to each, red first; `takes` how the model takes them (takesOf).
 */
export async function findPanels(px: ArrayLike<number>, w: number, h: number, channels: number, takes: Takes, run: RunModel): Promise<{ panels: Pt[][]; sure: number[] }> {
  const spans = windows(w, h);
  // A strip's windows are all one size.
  const fit = fitOf(w, spans[0][1] - spans[0][0], takes.rect);
  const one = 3 * fit.wide * fit.tall;
  const outs: Array<{ out: Float32Array; n: number; fit: Fit; span: [number, number] }> = [];
  for (let i = 0; i < spans.length; i += takes.batch) {
    const some = spans.slice(i, i + takes.batch);
    const input = new Float32Array(one * some.length);
    some.forEach((span, k) => squareOf(px, w, channels, span, fit, input.subarray(k * one, (k + 1) * one)));
    const { out, n } = await run(input, some.length, fit);
    const each = out.length / some.length;
    some.forEach((span, k) => outs.push({ out: out.subarray(k * each, (k + 1) * each), n, fit, span }));
  }
  return pagePanels(outs, w, h);
}
