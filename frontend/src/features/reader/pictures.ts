import type { PDFPageProxy, PageViewport } from 'pdfjs-dist';

/*
 * Dark themes invert a PDF page so its paper goes dark and its text light, which turns photos into
 * negatives. This finds where the page draws its pictures, so a second canvas above the page can
 * show them as they are.
 *
 * Pictures that are mostly white and grey stay inverted: that's a scanned page or a line drawing,
 * which should go dark with the rest.
 */

type M = number[];
type Box = [number, number, number, number];

const OPS = {
  save: 10, restore: 11, transform: 12, clip: 29, eoClip: 30,
  formBegin: 74, formEnd: 75, groupBegin: 76, groupEnd: 77, annotBegin: 80, annotEnd: 81,
  image: 85, inlineImage: 86, imageRepeat: 88, path: 91,
};

const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];

/** The on-canvas box around a rectangle in the space `m` maps from. */
function boxOf(m: M, x0: number, y0: number, x1: number, y1: number): Box {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
    xs.push(m[0] * x + m[2] * y + m[4]);
    ys.push(m[1] * x + m[3] * y + m[5]);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

const meet = (a: Box, b: Box): Box => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];

/** Where the page's pictures land on a canvas drawn at `vp`, cut to what their clips show. */
export async function findPictures(page: PDFPageProxy, vp: PageViewport): Promise<Box[]> {
  const { fnArray, argsArray } = await page.getOperatorList();
  const whole: Box = [0, 0, vp.width, vp.height];
  let state = { m: vp.transform as M, clip: whole };
  const stack: Array<typeof state> = [];
  let path: Box | null = null;
  let annotations = 0;
  const out: Box[] = [];
  const add = (m: M) => {
    const b = meet(boxOf(m, 0, 0, 1, 1), state.clip);
    if (b[2] - b[0] >= 8 && b[3] - b[1] >= 8) out.push(b);
  };
  for (let i = 0; i < fnArray.length; i++) {
    const a = argsArray[i] as unknown[];
    switch (fnArray[i]) {
      case OPS.save:
      case OPS.groupBegin:
        stack.push(state);
        state = { ...state };
        if (fnArray[i] === OPS.groupBegin) {
          const g = a[0] as { matrix?: M };
          if (g.matrix) state.m = mul(state.m, g.matrix);
        }
        break;
      case OPS.restore:
      case OPS.groupEnd:
      case OPS.formEnd:
        state = stack.pop() ?? state;
        break;
      case OPS.transform:
        state.m = mul(state.m, a as M);
        break;
      case OPS.formBegin: {
        stack.push(state);
        state = { ...state };
        const [matrix, bbox] = a as [M | null, number[] | null];
        if (matrix) state.m = mul(state.m, matrix);
        if (bbox) state.clip = meet(state.clip, boxOf(state.m, bbox[0], bbox[1], bbox[2], bbox[3]));
        break;
      }
      case OPS.path: {
        const mm = a[2] as number[] | undefined;
        path = mm && mm.length >= 4 && Number.isFinite(mm[0]) ? boxOf(state.m, mm[0], mm[1], mm[2], mm[3]) : null;
        break;
      }
      case OPS.clip:
      case OPS.eoClip:
        if (path) state.clip = meet(state.clip, path);
        break;
      // Stamps and other annotations are left to go dark with the page.
      case OPS.annotBegin: annotations++; break;
      case OPS.annotEnd: annotations--; break;
      case OPS.image:
      case OPS.inlineImage:
        if (!annotations) add(state.m);
        break;
      case OPS.imageRepeat: {
        if (annotations) break;
        const [, sx, sy, at] = a as [unknown, number, number, number[]];
        for (let j = 0; j + 1 < at.length; j += 2) add(mul(state.m, [sx, 0, 0, sy, at[j], at[j + 1]]));
        break;
      }
    }
  }
  return out;
}

let probe: CanvasRenderingContext2D | null = null;

/** Mostly white and grey: a scanned page or a line drawing, not a photo. */
function papery(from: HTMLCanvasElement, b: Box) {
  const n = 32;
  probe ??= Object.assign(document.createElement('canvas'), { width: n, height: n }).getContext('2d', { willReadFrequently: true });
  if (!probe) return false;
  probe.clearRect(0, 0, n, n);
  probe.drawImage(from, b[0], b[1], b[2] - b[0], b[3] - b[1], 0, 0, n, n);
  const px = probe.getImageData(0, 0, n, n).data;
  let grey = 0;
  let light = 0;
  for (let i = 0; i < px.length; i += 4) {
    const hi = Math.max(px[i], px[i + 1], px[i + 2]);
    if (hi - Math.min(px[i], px[i + 1], px[i + 2]) < 28) {
      grey++;
      if (hi > 200) light++;
    }
  }
  const all = px.length / 4;
  return grey > all * 0.95 && light > all * 0.6;
}

/**
 * Copies the pictures in `boxes` from `page` (as drawn, before any theme's filter) onto `pics`,
 * which sits over it at the same size.
 */
export async function keepPictures(boxes: Promise<Box[]>, page: HTMLCanvasElement, pics: HTMLCanvasElement) {
  const found = await boxes.catch(() => []);
  const ctx = pics.getContext('2d');
  if (!ctx) return;
  for (const b of found) {
    // Whole pixels only: the edges blend into the page, and would show as a pale line.
    const x = Math.ceil(b[0]);
    const y = Math.ceil(b[1]);
    const w = Math.floor(b[2]) - x;
    const h = Math.floor(b[3]) - y;
    if (w < 1 || h < 1 || papery(page, b)) continue;
    ctx.drawImage(page, x, y, w, h, x, y, w, h);
  }
}
