/*
 * A manga page's panels, found in its picture. The gutters between panels are the page's paper,
 * reaching in from its edges; what they don't reach is drawn on. Drawing that joins across a gutter
 * (a character breaking out of one panel into the next, a balloon over two) makes one group, zoomed
 * as one. Inside a group, the gutters it crosses still mostly show, and cut it into its panels.
 */

/** A part of a page, in fractions of its picture's width and height. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Panels drawn together, and each panel in them. */
export interface Group {
  box: Box;
  panels: Box[];
}

/** Pictures are looked at this wide at most: plenty to find gutters in, and quick to go over. */
const WIDTH = 400;
/** A long webtoon strip is looked at no taller than this, narrower if it must be. */
const TALLEST = 6000;
/** Paper: this light on a white page, or this dark on a black one. */
const LIGHT = 225;
const DARK = 35;
/** Smaller than this, of the page, is lettering or a page number in a gutter, not a panel. */
const SMALLEST = 0.012;
/** A row (or column) across a group is a gutter when this much of it is paper... */
const GUTTER = 0.45;
/** ...and the gutter is no wider than this, of the page: wider is the paper beside a panel. */
const WIDEST = 0.08;

/** Integer pixel bounds, inclusive. */
interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Picture {
  luma: Uint8Array;
  w: number;
  h: number;
}

/** The picture, small, as greys. Transparent parts are paper. */
function greysOf(img: HTMLImageElement): Picture | null {
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  if (!nw || !nh) return null;
  let scale = Math.min(1, WIDTH / nw);
  if (nh * scale > TALLEST) scale = TALLEST / nh;
  const w = Math.max(1, Math.round(nw * scale));
  const h = Math.max(1, Math.round(nh * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const luma = new Uint8Array(w * h);
  for (let i = 0; i < luma.length; i++) {
    const p = i * 4;
    luma[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  }
  return { luma, w, h };
}

/** What paper looks like on this page, from its edges: white, black, or neither (no gutters to find). */
function paperOf({ luma, w, h }: Picture): ((l: number) => boolean) | null {
  let light = 0;
  let dark = 0;
  let all = 0;
  const look = (i: number) => {
    all++;
    if (luma[i] >= LIGHT) light++;
    else if (luma[i] <= DARK) dark++;
  };
  for (let x = 0; x < w; x++) {
    look(x);
    look((h - 1) * w + x);
  }
  for (let y = 1; y < h - 1; y++) {
    look(y * w);
    look(y * w + w - 1);
  }
  if (light >= all / 2) return (l) => l >= LIGHT;
  if (dark >= all / 2) return (l) => l <= DARK;
  return null;
}

/** The paper reached from the page's edges: the margins and gutters. */
function gutters(pic: Picture, paper: (l: number) => boolean, queue: Int32Array): Uint8Array {
  const { luma, w, h } = pic;
  const out = new Uint8Array(w * h);
  let head = 0;
  let tail = 0;
  const reach = (i: number) => {
    if (out[i] || !paper(luma[i])) return;
    out[i] = 1;
    queue[tail++] = i;
  };
  for (let x = 0; x < w; x++) {
    reach(x);
    reach((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    reach(y * w);
    reach(y * w + w - 1);
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    if (x > 0) reach(i - 1);
    if (x < w - 1) reach(i + 1);
    if (i >= w) reach(i - w);
    if (i < w * (h - 1)) reach(i + w);
  }
  return out;
}

/** Each stretch of drawing the paper doesn't reach, labelled 1, 2, ..., with its bounds and size. */
function drawings(pic: Picture, out: Uint8Array, queue: Int32Array): { label: Int32Array; found: Array<Rect & { n: number }> } {
  const { w, h } = pic;
  const label = new Int32Array(w * h);
  const found: Array<Rect & { n: number }> = [];
  for (let s = 0; s < w * h; s++) {
    if (out[s] || label[s]) continue;
    const id = found.length + 1;
    const r = { x0: w, y0: h, x1: 0, y1: 0, n: 0 };
    let head = 0;
    let tail = 0;
    const take = (j: number) => {
      if (out[j] || label[j]) return;
      label[j] = id;
      queue[tail++] = j;
    };
    take(s);
    while (head < tail) {
      const i = queue[head++];
      const x = i % w;
      const y = (i - x) / w;
      r.n++;
      if (x < r.x0) r.x0 = x;
      if (x > r.x1) r.x1 = x;
      if (y < r.y0) r.y0 = y;
      if (y > r.y1) r.y1 = y;
      if (x > 0) take(i - 1);
      if (x < w - 1) take(i + 1);
      if (i >= w) take(i - w);
      if (i < w * (h - 1)) take(i + w);
    }
    found.push(r);
  }
  return { label, found };
}

/** Cuts a group into its panels along the gutters it crosses, across and down in turn. */
function panelsIn(pic: Picture, out: Uint8Array, label: Int32Array, id: number, group: Rect): Rect[] {
  const { w, h } = pic;
  const least = SMALLEST * w * h;

  /** The part of a rect that's this group's drawing, or null when there's too little of it. */
  const trim = (r: Rect): Rect | null => {
    const t = { x0: r.x1, y0: r.y1, x1: r.x0, y1: r.y0 };
    let n = 0;
    for (let y = r.y0; y <= r.y1; y++) {
      for (let x = r.x0; x <= r.x1; x++) {
        if (label[y * w + x] !== id) continue;
        n++;
        if (x < t.x0) t.x0 = x;
        if (x > t.x1) t.x1 = x;
        if (y < t.y0) t.y0 = y;
        if (y > t.y1) t.y1 = y;
      }
    }
    if (n < least / 3 || (t.x1 - t.x0 + 1) * (t.y1 - t.y0 + 1) < least) return null;
    return t;
  };

  /** The rect in pieces between its gutters: rows when `down`, columns otherwise. */
  const split = (r: Rect, down: boolean): Rect[] => {
    const from = down ? r.y0 : r.x0;
    const to = down ? r.y1 : r.x1;
    const widest = WIDEST * (down ? h : w);
    const gutter: boolean[] = [];
    for (let a = from; a <= to; a++) {
      let paper = 0;
      let mine = 0;
      const bFrom = down ? r.x0 : r.y0;
      const bTo = down ? r.x1 : r.y1;
      for (let b = bFrom; b <= bTo; b++) {
        let i = b * w + a;
        if (down) i = a * w + b;
        if (out[i]) paper++;
        else if (label[i] === id) mine++;
      }
      gutter.push(paper + mine > 0 && paper / (paper + mine) >= GUTTER);
    }
    const pieces: Rect[] = [];
    let start = 0;
    let k = 0;
    while (k < gutter.length) {
      if (!gutter[k]) {
        k++;
        continue;
      }
      let end = k;
      while (end + 1 < gutter.length && gutter[end + 1]) end++;
      // Inside the rect, and narrow enough to be a gutter: a cut.
      if (k > start && end < gutter.length - 1 && end - k + 1 <= widest) {
        pieces.push(down ? { ...r, y0: from + start, y1: from + k - 1 } : { ...r, x0: from + start, x1: from + k - 1 });
        start = end + 1;
      }
      k = end + 1;
    }
    pieces.push(down ? { ...r, y0: from + start, y1: to } : { ...r, x0: from + start, x1: to });
    return pieces;
  };

  const cut = (r: Rect, down: boolean, tried: boolean, depth: number): Rect[] => {
    if (depth > 8) return [r];
    const pieces = split(r, down).map(trim).filter((p): p is Rect => p !== null);
    if (pieces.length > 1) return pieces.flatMap((p) => cut(p, !down, false, depth + 1));
    if (!tried) return cut(r, !down, true, depth + 1);
    return [r];
  };

  return cut(group, true, false, 0);
}

const boxOf = (r: Rect, w: number, h: number): Box => ({ x: r.x0 / w, y: r.y0 / h, w: (r.x1 - r.x0 + 1) / w, h: (r.y1 - r.y0 + 1) / h });

/** The page's groups of panels: none when its edges aren't plain paper, so there are no gutters to go by. */
export function framesOf(img: HTMLImageElement): Group[] {
  const pic = greysOf(img);
  if (!pic) return [];
  const paper = paperOf(pic);
  if (!paper) return [];
  const { w, h } = pic;
  const queue = new Int32Array(w * h);
  const out = gutters(pic, paper, queue);
  const { label, found } = drawings(pic, out, queue);
  const least = SMALLEST * w * h;
  const groups: Group[] = [];
  found.forEach((r, k) => {
    if ((r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1) < least || r.n < least / 3) return;
    const panels = panelsIn(pic, out, label, k + 1, r);
    groups.push({ box: boxOf(r, w, h), panels: panels.map((p) => boxOf(p, w, h)) });
  });
  // A caption box or a balloon the gutters reach around sits inside a panel: it's part of that panel.
  return groups.filter((g) => !groups.some((other) => other !== g && inside(g.box, other.box)));
}

/** Whether a box lies within another, give or take a pixel or two. */
function inside(b: Box, outer: Box): boolean {
  const slack = 0.005;
  if (b.x < outer.x - slack || b.y < outer.y - slack) return false;
  if (b.x + b.w > outer.x + outer.w + slack) return false;
  return b.y + b.h <= outer.y + outer.h + slack;
}

const area = (b: Box) => b.w * b.h;
const holds = (b: Box, x: number, y: number) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
const distance = (b: Box, x: number, y: number) => Math.hypot(Math.max(b.x - x, 0, x - b.x - b.w), Math.max(b.y - y, 0, y - b.y - b.h));

/** The group a point on the page is in, and the panel in it: the smallest that holds it, or the nearest panel. */
export function frameAt(groups: Group[], x: number, y: number): { group: Box; panel: Box } | null {
  const hit = groups.filter((g) => holds(g.box, x, y)).sort((a, b) => area(a.box) - area(b.box))[0];
  if (!hit) return null;
  let panel = hit.box;
  let best = Infinity;
  for (const p of hit.panels) {
    const d = distance(p, x, y);
    if (d < best || (d === best && area(p) < area(panel))) {
      best = d;
      panel = p;
    }
  }
  return { group: hit.box, panel };
}

/** Pages' groups, by their picture, found once each. */
const seen = new Map<string, Group[]>();

/** The page's groups of panels, looked for once per picture. */
export function framesFor(img: HTMLImageElement): Group[] {
  const key = img.currentSrc || img.src;
  let groups = seen.get(key);
  if (!groups) {
    groups = framesOf(img);
    seen.set(key, groups);
    // Only the pages about the screen are wanted again.
    if (seen.size > 80) seen.delete(seen.keys().next().value!);
  }
  return groups;
}
