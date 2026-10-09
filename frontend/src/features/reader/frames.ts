/*
 * A manga page's panels, found in its picture, and the order they're read in. The page is cut
 * along its gutters, straight or slanted, again and again: into rows read top to bottom where a
 * gutter runs all the way across, into columns read right to left (left to right for comics)
 * where one runs all the way down instead, and each of those the same way. What can't be cut
 * further is a panel.
 *
 * A gutter is a band of paper with a panel's edge close by on both sides, or a thin black band
 * (some pages draw their gutters black). A balloon or a character drawn over a gutter still lets
 * the cut through, as most of it is still gutter; a line through the white of a panel with no
 * border, which the paper floods into, isn't one, as nothing bounds it. Drawing that joins across
 * a gutter makes a group of panels, zoomed as one.
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

/** A page's groups, and its panels in the order they're read, right to left and left to right. */
export interface Frames {
  groups: Group[];
  rtl: Box[];
  ltr: Box[];
}

/** Pictures are looked at about this wide at most (a page, not a spread): plenty to find gutters in, and quick to go over. */
const WIDTH = 400;
/** A long webtoon strip is looked at no taller than this, narrower if it must be. */
const TALLEST = 6000;
/** A page's usual height over its width, to look at a spread as wide as two pages. */
const PAGE = 1.42;
/** Paper on a black page: this dark at most. A white page's paper is found from the page itself. */
const DARK = 40;
/** A plain strip along an edge, scanned in or added (a binding's black band), this far in at most: cut off. */
const STRIP = 0.1;
/** A gutter's paper is at most this wide, of the page, between the panels either side. */
const GUTTER_WIDTH = 0.06;
/** A black gutter: a band this dark, no thicker than this, of the page (thicker is a black sky or hair). */
const BLACK = 40;
const BAND = 0.035;
/** A cut is a gutter when this much of it is gutter, the rest what's drawn over it... */
const GUTTER = 0.65;
/** ...crossing it this many times at most: a line through speed lines or tone crosses them all the time. */
const CROSSINGS = 4;
/** Or when this much of it is paper of any kind: a plain gap, however wide (a webtoon's). */
const CLEAR = 0.97;
/** Slanted gutters lean this much at most, across a page. */
const LEAN = 0.3;
/** Parts smaller than this, of the page, aren't looked at for slanted gutters: they're a panel or two. */
const SLANTED_PART = 0.1;
/**
 * A gutter has a panel's straight edge along at least one side: as far from the cut all along it,
 * give or take this much, for this much of it. A gap between two figures, or the sky between a
 * tree's branches, has none.
 */
const EVEN = 2;
const EVENLY = 0.6;
/** A black gutter is a line this much black, at least half of it a thin band (the rest is hair or a sky touching it). */
const BLACK_LINE = 0.9;
/**
 * Black thinner than this, of the page, is a line drawn: a panel's border when it runs along a cut
 * for this much of it at a time, an outline crossing the cut when it doesn't.
 */
const THIN_LINE = 0.012;
const LONG_LINE = 0.1;
/** Cuts this close together, of the page, are the same gutter. */
const APART = 0.035;
/** Each piece a cut leaves has at least this much drawn, of the page, and is this thick. */
const LEAST_INK = 0.006;
const LEAST_THICK = 0.07;
/** Smaller than this, of the page, is lettering or a page number in a gutter, not a panel. */
const SMALLEST = 0.012;
/** This much of a panel inside a bigger one's bounds, and it's part of that one, not a panel to step to. */
const INSIDE = 0.9;

/** What a pixel is to a cut through it: drawing, a paper gutter, open paper, a thin black band, deep black. */
const INK = 0;
const GUT = 1;
const OPEN = 2;
const BANDED = 3;
const DEEP = 4;

/** Integer pixel bounds, inclusive. */
interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A page's picture as greys, to look for its panels in. */
export interface Picture {
  luma: Uint8Array;
  w: number;
  h: number;
}

/**
 * A line across a part of the page, through `at` where it starts, leaning `lean` pixels for each
 * one along it. `across` runs left to right (y = at + lean * (x - from)); otherwise top to bottom.
 */
interface Cut {
  across: boolean;
  from: number;
  to: number;
  at: number;
  lean: number;
}

/** A part of the page as it's cut: its pixels are those labelled `id`, its drawing within `rect`. */
interface Part {
  id: number;
  rect: Rect;
}

/** A part cut into pieces, read in order (top to bottom, or across), or one that wouldn't cut: a panel. */
type Node = { across: boolean; kids: Node[] } | { panel: Rect };

/**
 * The picture, small, as greys. Transparent parts are paper. It's drawn twice as fine first, and
 * each little square of four keeps its darkest: a panel's thin border, shrunk, would otherwise
 * fade to the paper's grey and let the paper in.
 */
function greysOf(img: HTMLImageElement): Picture | null {
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  if (!nw || !nh) return null;
  // A spread is looked at as two pages, each as wide as one alone.
  const pageW = Math.min(nw, nh / PAGE);
  let scale = Math.min(1, WIDTH / pageW);
  if (nh * scale > TALLEST) scale = TALLEST / nh;
  const w = Math.max(1, Math.round(nw * scale));
  const h = Math.max(1, Math.round(nh * scale));
  const fw = w * 2;
  const fh = h * 2;
  const canvas = document.createElement('canvas');
  canvas.width = fw;
  canvas.height = fh;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, fw, fh);
  ctx.drawImage(img, 0, 0, fw, fh);
  const rgba = ctx.getImageData(0, 0, fw, fh).data;
  const luma = new Uint8Array(w * h).fill(255);
  for (let y = 0; y < fh; y++) {
    const row = (y >> 1) * w;
    for (let x = 0; x < fw; x++) {
      const p = (y * fw + x) * 4;
      const l = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
      const i = row + (x >> 1);
      if (l < luma[i]) luma[i] = l;
    }
  }
  return { luma, w, h };
}

/** The page inside any plain dark strips along its edges: a line of one even grey that isn't paper. */
function trimOf({ luma, w, h }: Picture): Rect {
  const plain = (from: number, step: number, n: number) => {
    let sum = 0;
    let sq = 0;
    for (let k = 0; k < n; k++) {
      const l = luma[from + k * step];
      sum += l;
      sq += l * l;
    }
    const mean = sum / n;
    return mean < 200 && sq / n - mean * mean < 64;
  };
  const r = { x0: 0, y0: 0, x1: w - 1, y1: h - 1 };
  const most = (n: number) => Math.floor(n * STRIP);
  while (r.x0 < most(w) && plain(r.x0, w, h)) r.x0++;
  while (w - 1 - r.x1 < most(w) && plain(r.x1, w, h)) r.x1--;
  while (r.y0 < most(h) && plain(r.y0 * w, 1, w)) r.y0++;
  while (h - 1 - r.y1 < most(h) && plain(r.y1 * w, 1, w)) r.y1--;
  return r;
}

/** Each pixel around the page's edge, inside its strips. */
function ringOf(r: Rect, w: number): number[] {
  const ring: number[] = [];
  for (let x = r.x0; x <= r.x1; x++) {
    ring.push(r.y0 * w + x);
    ring.push(r.y1 * w + x);
  }
  for (let y = r.y0 + 1; y < r.y1; y++) {
    ring.push(y * w + r.x0);
    ring.push(y * w + r.x1);
  }
  return ring;
}

/**
 * What paper looks like on this page, from its edges: black when they're mostly black and hardly
 * any white, white otherwise, as light as the lightest of its edges, a little less (a scan's paper
 * can be a grey).
 */
function paperOf({ luma }: Picture, ring: number[]): (l: number) => boolean {
  const greys = ring.map((i) => luma[i]).sort((a, b) => a - b);
  const dark = greys.filter((l) => l <= DARK).length;
  const light = greys.filter((l) => l >= 200).length;
  if (dark >= ring.length * 0.6 && light < ring.length * 0.1) return (l) => l <= DARK;
  const lightest = greys[Math.floor(greys.length * 0.9)];
  const least = Math.max(180, Math.min(225, lightest - 30));
  return (l) => l >= least;
}

/** The paper reached from the page's edges (the margins and gutters), and everything outside its strips. */
function gutters(pic: Picture, page: Rect, ring: number[], paper: (l: number) => boolean, queue: Int32Array): Uint8Array {
  const { luma, w, h } = pic;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < page.x0 || x > page.x1 || y < page.y0 || y > page.y1) out[y * w + x] = 1;
    }
  }
  let head = 0;
  let tail = 0;
  const reach = (i: number) => {
    if (out[i] || !paper(luma[i])) return;
    out[i] = 1;
    queue[tail++] = i;
  };
  for (const i of ring) reach(i);
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

/** What each pixel is to a cut through it, and how far its gutter reaches from it, back and on. */
interface Kinds {
  kinds: Uint8Array;
  before: Uint8Array;
  after: Uint8Array;
}

/**
 * What each pixel is to a cut through it, `across` the page or down it: gutter (paper with drawing
 * close by on both sides of the cut), open paper, a thin black band, deep black (a black sky,
 * hair), or drawing; and how far its gutter reaches from it, either way.
 */
function kindsOf(pic: Picture, out: Uint8Array, page: Rect, across: boolean): Kinds {
  const { luma, w, h } = pic;
  const kinds = new Uint8Array(w * h);
  const before = new Uint8Array(w * h);
  const after = new Uint8Array(w * h);
  // Runs go down the page for a cut across it, and across it for one down it.
  const lines = across ? w : h;
  const room = across ? h : w;
  const start = across ? page.y0 : page.x0;
  const end = across ? page.y1 : page.x1;
  const widest = Math.ceil(GUTTER_WIDTH * room);
  const band = Math.ceil(BAND * room);
  const index = (line: number, k: number) => (across ? k * w + line : line * w + k);
  for (let line = 0; line < lines; line++) {
    let k = start;
    while (k <= end) {
      const i = index(line, k);
      const paper = out[i] === 1;
      const black = !paper && luma[i] <= BLACK;
      if (!paper && !black) {
        k++;
        continue;
      }
      // The run of paper (or of black) this pixel starts.
      let last = k;
      while (last + 1 <= end) {
        const j = index(line, last + 1);
        const same = paper ? out[j] === 1 : out[j] === 0 && luma[j] <= BLACK;
        if (!same) break;
        last++;
      }
      const length = last - k + 1;
      let kind = DEEP;
      if (paper) {
        const bounded = k > start && last < end && length <= widest;
        kind = bounded ? GUT : OPEN;
      } else if (length <= band) {
        kind = BANDED;
      }
      for (let m = k; m <= last; m++) {
        const j = index(line, m);
        kinds[j] = kind;
        before[j] = Math.min(255, m - k);
        after[j] = Math.min(255, last - m);
      }
      k = last + 1;
    }
  }
  return { kinds, before, after };
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

/** Cuts the page along its gutters, and keeps what each piece is: a part cut again, or a panel. */
class Cutter {
  private pic: Picture;
  private out: Uint8Array;
  /** What each pixel is to a cut across the page, and to one down it. */
  private across: Kinds;
  private down: Kinds;
  /** How many of a cut's gutter pixels are each distance from the gutter's edge, back and on, counted afresh for each cut. */
  private back = new Int32Array(256);
  private on = new Int32Array(256);
  /** The pixels of a stretch of thin black along a cut, while it's looked at. */
  private run: Int32Array;
  /** Which part each pixel is in, as the page is cut; 0 outside the page's strips. */
  private part: Int32Array;
  private parts = 1;
  private leastInk: number;

  constructor(pic: Picture, out: Uint8Array, page: Rect) {
    this.pic = pic;
    this.out = out;
    this.across = kindsOf(pic, out, page, true);
    this.down = kindsOf(pic, out, page, false);
    this.part = new Int32Array(pic.w * pic.h);
    this.run = new Int32Array(Math.max(pic.w, pic.h));
    for (let y = page.y0; y <= page.y1; y++) this.part.fill(1, y * pic.w + page.x0, y * pic.w + page.x1 + 1);
    this.leastInk = LEAST_INK * pic.w * pic.h;
  }

  /** The page, cut. */
  cut(page: Rect): Node | null {
    const ink = this.inkOf(1, page);
    if (!ink) return null;
    return this.node({ id: 1, rect: ink }, 0);
  }

  /**
   * A part, cut into rows if a gutter runs all the way across it, into columns if not. Rows come
   * first, as a page is read a row at a time; a gutter running down past several panels makes
   * columns, each read to its foot before the next.
   */
  private node(p: Part, depth: number): Node {
    if (depth < 10) {
      for (const across of [true, false]) {
        const pieces = this.split(p, across);
        if (pieces.length > 1) return { across, kids: pieces.map((q) => this.node(q, depth + 1)) };
      }
    }
    return { panel: p.rect };
  }

  /** The drawing in a part: its bounds, or null when there's too little of it. */
  private inkOf(id: number, r: Rect): Rect | null {
    const { w } = this.pic;
    const t = { x0: r.x1, y0: r.y1, x1: r.x0, y1: r.y0 };
    let n = 0;
    for (let y = r.y0; y <= r.y1; y++) {
      for (let x = r.x0; x <= r.x1; x++) {
        const i = y * w + x;
        if (this.part[i] !== id || this.out[i]) continue;
        n++;
        if (x < t.x0) t.x0 = x;
        if (x > t.x1) t.x1 = x;
        if (y < t.y0) t.y0 = y;
        if (y > t.y1) t.y1 = y;
      }
    }
    if (n < this.leastInk) return null;
    return t;
  }

  /** Where a cut is, at a point along it. */
  private at(c: Cut, u: number): number {
    return Math.round(c.at + c.lean * (u - c.from));
  }

  /**
   * Whether a cut, within the part, could be a gutter, at a quick look: every few pixels along it,
   * after a quicker one still at every few more. A straight cut has to be little drawn on; a
   * slanted one, mostly gutter, as only a straight one can be a plain gap.
   */
  private mostlyPaper(c: Cut, id: number): boolean {
    if (!this.paperEvery(c, id, 27, 0.7)) return false;
    if (!this.paperEvery(c, id, 9, 0.8)) return false;
    return this.paperEvery(c, id, 3, 0.9);
  }

  /**
   * Whether a cut, looked at every `step` pixels, is no more unlike a gutter than a gutter can be,
   * give or take `slack`. Thin black is half unlike: a panel's border, or the dots of a tone.
   */
  private paperEvery(c: Cut, id: number, step: number, slack: number): boolean {
    const { w, h } = this.pic;
    const { kinds, before, after } = c.across ? this.across : this.down;
    const room = c.across ? h : w;
    const thinnest = THIN_LINE * room;
    const straight = c.lean === 0;
    let most = (1 - GUTTER * slack) * ((c.to - c.from) / step + 1);
    if (!straight) most = (1 - 0.5 * slack) * ((c.to - c.from) / step + 1);
    let inside = 0;
    let unlike = 0;
    for (let u = c.from; u <= c.to; u += step) {
      const v = this.at(c, u);
      if (v < 0 || v >= room) continue;
      let i = u * w + v;
      if (c.across) i = v * w + u;
      if (this.part[i] !== id) continue;
      inside++;
      const kind = kinds[i];
      if (kind === INK) {
        unlike++;
      } else if (!straight) {
        if (kind === BANDED && before[i] + after[i] + 1 < thinnest) unlike += 0.5;
        else if (kind !== GUT && kind !== BANDED) unlike++;
      }
      if (unlike > most) return false;
    }
    // A line that mostly runs outside the part, past one of its corners, isn't a cut across it.
    const all = (c.to - c.from) / step + 1;
    return inside >= 0.45 * all;
  }

  /** How much of a cut, within the part, is gutter, when it's a gutter; 0 when it isn't. */
  private gutterAlong(c: Cut, id: number): number {
    const { w, h } = this.pic;
    const { kinds, before, after } = c.across ? this.across : this.down;
    this.back.fill(0);
    this.on.fill(0);
    const room = c.across ? h : w;
    const length = c.to - c.from + 1;
    const thinnest = THIN_LINE * room;
    const long = LONG_LINE * length;
    // Past this much drawing it can't be a gutter: no need to look further.
    const most = (1 - GUTTER) * length;
    let inside = 0;
    let gutter = 0;
    let open = 0;
    let band = 0;
    let deep = 0;
    let ink = 0;
    let crossings = 0;
    let onInk = false;
    // A stretch of thin black along the cut, settled once it ends.
    const run = this.run;
    let thin = 0;
    let inkBefore = false;
    const settle = () => {
      if (thin >= long) {
        gutter += thin;
        band += thin;
        for (let k = 0; k < thin; k++) {
          this.back[before[run[k]]]++;
          this.on[after[run[k]]]++;
        }
        onInk = false;
      } else if (thin > 0) {
        ink += thin;
        if (!inkBefore) crossings++;
        onInk = true;
      }
      thin = 0;
    };
    for (let u = c.from; u <= c.to; u++) {
      const v = this.at(c, u);
      if (v < 0 || v >= room) continue;
      let i = u * w + v;
      if (c.across) i = v * w + u;
      if (this.part[i] !== id) continue;
      inside++;
      const kind = kinds[i];
      if (kind === BANDED && before[i] + after[i] + 1 < thinnest) {
        if (thin === 0) inkBefore = onInk;
        run[thin] = i;
        thin++;
        continue;
      }
      settle();
      if (ink > most) return 0;
      if (kind === GUT || kind === BANDED) {
        gutter++;
        if (kind === BANDED) band++;
        this.back[before[i]]++;
        this.on[after[i]]++;
        onInk = false;
        continue;
      }
      if (kind === OPEN) {
        open++;
        onInk = false;
        continue;
      }
      // Black drawing touching a gutter isn't crossing it.
      if (kind === DEEP) {
        deep++;
        continue;
      }
      ink++;
      if (ink > most) return 0;
      if (!onInk) crossings++;
      onInk = true;
    }
    settle();
    if (ink > most) return 0;
    if (inside < length / 2) return 0;
    const straightEdge = this.even(this.back, gutter) || this.even(this.on, gutter);
    // A black band, with hair or a black sky touching it here and there.
    if (band >= inside / 2 && band + deep >= BLACK_LINE * inside && straightEdge) return (band + deep) / inside;
    const paper = (gutter + open) / inside;
    // A plain gap, however wide, runs straight.
    if (paper >= CLEAR && c.lean === 0) return paper;
    // Drawing at either end isn't crossing the gutter, it's the panel the cut ends against.
    if (crossings - this.endsOnInk(c, id) > CROSSINGS) return 0;
    if (gutter < GUTTER * inside * 0.85 || paper < GUTTER) return 0;
    if (!straightEdge) return 0;
    return paper;
  }

  /** Whether most of a cut's gutter is about one distance from its edge, as a tally of the distances says. */
  private even(tally: Int32Array, gutter: number): boolean {
    let most = 0;
    let near = 0;
    for (let k = 0; k <= 2 * EVEN; k++) near += tally[k];
    for (let k = EVEN; k < 256 - EVEN; k++) {
      if (near > most) most = near;
      near += tally[k + EVEN + 1] ?? 0;
      near -= tally[k - EVEN];
    }
    return most >= EVENLY * gutter;
  }

  /** How many of a cut's two ends are on drawing, inside the part. */
  private endsOnInk(c: Cut, id: number): number {
    const { w, h } = this.pic;
    const { kinds } = c.across ? this.across : this.down;
    const room = c.across ? h : w;
    let n = 0;
    for (const u of [c.from, c.to]) {
      const v = this.at(c, u);
      if (v < 0 || v >= room) continue;
      let i = u * w + v;
      if (c.across) i = v * w + u;
      if (this.part[i] === id && kinds[i] === INK) n++;
    }
    return n;
  }

  /** Lines across the part (or down it) that are gutters, the best of each: straight ones, or `slanted` ones too. */
  private gutterLines(p: Part, across: boolean, slanted: boolean): Cut[] {
    const r = p.rect;
    const from = across ? r.x0 : r.y0;
    const to = across ? r.x1 : r.y1;
    const first = across ? r.y0 : r.x0;
    const last = across ? r.y1 : r.x1;
    const length = to - from + 1;
    const found: Array<Cut & { paper: number }> = [];
    const look = (lean: number) => {
      const drop = lean * length;
      for (let at = Math.floor(first - Math.max(0, drop)); at <= Math.ceil(last - Math.min(0, drop)); at++) {
        const c = { across, from, to, at, lean };
        // A quick look every few pixels first: most lines are plainly not gutters.
        if (!this.mostlyPaper(c, p.id)) continue;
        const paper = this.gutterAlong(c, p.id);
        if (paper) found.push({ ...c, paper });
      }
    };
    if (slanted) {
      // Leaning a pixel or two more each time, so a slanted gutter is never missed between two tries.
      const step = 2 / length;
      for (let lean = step; lean <= LEAN; lean += step) {
        look(lean);
        look(-lean);
      }
    } else {
      look(0);
    }
    let best = this.bestOf(found);
    // A gutter found straight may well lean a little: its best line, then.
    if (!slanted) best = this.bestOf(best.map((c) => this.leaning(p, c)));
    return best.sort((a, b) => this.at(a, a.from) + this.at(a, a.to) - this.at(b, b.from) - this.at(b, b.to));
  }

  /** The best line of each gutter: the most paper, then the least slant. */
  private bestOf(found: Array<Cut & { paper: number }>): Array<Cut & { paper: number }> {
    const sorted = [...found].sort((a, b) => b.paper - a.paper || Math.abs(a.lean) - Math.abs(b.lean));
    const kept: Array<Cut & { paper: number }> = [];
    for (const c of sorted) {
      if (kept.every((k) => this.apart(c, k))) kept.push(c);
    }
    return kept;
  }

  /** The best line along a straight cut's gutter, leaning as much as it does, through about the same middle. */
  private leaning(p: Part, c: Cut & { paper: number }): Cut & { paper: number } {
    const length = c.to - c.from + 1;
    const room = c.across ? this.pic.h : this.pic.w;
    const near = Math.ceil(APART * room);
    const step = 2 / length;
    let best = c;
    for (let lean = step; lean <= LEAN; lean += step) {
      for (const way of [lean, -lean]) {
        const half = (way * length) / 2;
        for (let middle = c.at - near; middle <= c.at + near; middle++) {
          const line = { across: c.across, from: c.from, to: c.to, at: Math.round(middle - half), lean: way };
          if (!this.mostlyPaper(line, p.id)) continue;
          const paper = this.gutterAlong(line, p.id);
          if (paper > best.paper) best = { ...line, paper };
        }
      }
    }
    return best;
  }

  /** Whether two cuts don't cross and aren't the same gutter. */
  private apart(a: Cut, b: Cut): boolean {
    const start = this.at(a, a.from) - this.at(b, b.from);
    const end = this.at(a, a.to) - this.at(b, b.to);
    if (Math.sign(start) !== Math.sign(end)) return false;
    const room = a.across ? this.pic.h : this.pic.w;
    return Math.min(Math.abs(start), Math.abs(end)) > APART * room;
  }

  /** Which of the pieces between the cuts a pixel is in, 0 for the first. */
  private sideOf(cuts: Cut[], x: number, y: number): number {
    let k = 0;
    for (const c of cuts) {
      const u = c.across ? x : y;
      const v = c.across ? y : x;
      if (v > this.at(c, u)) k++;
    }
    return k;
  }

  /** The part cut into its pieces along its gutters, in order (straight gutters first, slanted if none): just itself when it has none. */
  private split(p: Part, across: boolean): Part[] {
    const { w, h } = this.pic;
    let cuts = this.kept(p, across, this.gutterLines(p, across, false));
    const r = p.rect;
    const big = (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1) >= SLANTED_PART * w * h;
    if (!cuts.length && big) cuts = this.kept(p, across, this.gutterLines(p, across, true));
    if (!cuts.length) return [p];
    // Each piece becomes a part of its own.
    const ids = cuts.map(() => ++this.parts);
    for (let y = r.y0; y <= r.y1; y++) {
      for (let x = r.x0; x <= r.x1; x++) {
        const i = y * w + x;
        if (this.part[i] !== p.id) continue;
        const k = this.sideOf(cuts, x, y);
        if (k > 0) this.part[i] = ids[k - 1];
      }
    }
    const pieces: Part[] = [];
    for (const id of [p.id, ...ids]) {
      const ink = this.inkOf(id, r);
      if (ink) pieces.push({ id, rect: ink });
    }
    return pieces;
  }

  /** The cuts that leave a panel's worth of drawing between each and the next, as thick as a panel. */
  private kept(p: Part, across: boolean, lines: Cut[]): Cut[] {
    let cuts = lines;
    const { w, h } = this.pic;
    const thick = LEAST_THICK * (across ? h : w);
    while (cuts.length) {
      // How much is drawn between each cut and the next, and how far it reaches from the cut before it (or, for the first, from the cut after).
      const n = new Array<number>(cuts.length + 1).fill(0);
      const reach = new Array<number>(cuts.length + 1).fill(0);
      const r = p.rect;
      for (let y = r.y0; y <= r.y1; y++) {
        for (let x = r.x0; x <= r.x1; x++) {
          const i = y * w + x;
          if (this.part[i] !== p.id || this.out[i]) continue;
          const k = this.sideOf(cuts, x, y);
          const u = across ? x : y;
          const v = across ? y : x;
          n[k]++;
          let far = this.at(cuts[0], u) - v;
          if (k > 0) far = v - this.at(cuts[k - 1], u);
          if (far > reach[k]) reach[k] = far;
        }
      }
      // A piece with too little drawn in it, or too thin, isn't a panel: the cut beside it, with less paper, goes.
      const thin = n.findIndex((m, k) => m < this.leastInk || reach[k] < thick);
      if (thin < 0) break;
      let drop = thin;
      if (thin === cuts.length) drop = thin - 1;
      else if (thin > 0 && this.gutterAlong(cuts[thin - 1], p.id) < this.gutterAlong(cuts[thin], p.id)) drop = thin - 1;
      cuts = cuts.filter((_, k) => k !== drop);
    }
    return cuts;
  }
}

const boxOf = (r: Rect, w: number, h: number): Box => ({ x: r.x0 / w, y: r.y0 / h, w: (r.x1 - r.x0 + 1) / w, h: (r.y1 - r.y0 + 1) / h });
const area = (b: Box) => b.w * b.h;
const sizeOf = (r: Rect) => (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);

/** How much of a lies inside b, of a. */
function shareIn(a: Rect, b: Rect): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + 1;
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) + 1;
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / sizeOf(a);
}

/**
 * Whether a panel is almost all inside a bigger one's bounds. A piece cut off slanted has bounds as
 * wide as the part it was cut from, which can hold a whole other piece: a sliver beside it, say.
 */
function within(r: Rect, panels: Rect[]): boolean {
  return panels.some((o) => o !== r && sizeOf(o) >= sizeOf(r) && shareIn(r, o) >= INSIDE);
}

/** The panels of a cut page in the order they're read: rows top to bottom, and across them right to left, or left to right. */
function orderOf(node: Node, rtl: boolean): Rect[] {
  if ('panel' in node) return [node.panel];
  let kids = node.kids;
  if (!node.across && rtl) kids = [...kids].reverse();
  return kids.flatMap((k) => orderOf(k, rtl));
}

/** The page's groups of panels, and its panels in order: none when nothing on it can be told apart. */
export function framesIn(pic: Picture): Frames {
  const none = { groups: [], rtl: [], ltr: [] };
  const { w, h } = pic;
  const page = trimOf(pic);
  const ring = ringOf(page, w);
  const paper = paperOf(pic, ring);
  const queue = new Int32Array(w * h);
  const out = gutters(pic, page, ring, paper, queue);
  const tree = new Cutter(pic, out, page).cut(page);
  if (!tree) return none;
  const small = SMALLEST * w * h;
  const big = orderOf(tree, true).filter((r) => sizeOf(r) >= small);
  const rtl = big.filter((r) => !within(r, big));
  // One panel the size of the page is no panel at all: nothing on it could be told apart.
  if (rtl.length < 2) return none;
  const ltr = orderOf(tree, false).filter((r) => rtl.includes(r));

  // Panels whose drawing joins across a gutter are a group: the stretch of drawing most of each is in.
  const { label, found } = drawings(pic, out, queue);
  const byDrawing = new Map<number, Rect[]>();
  for (const r of rtl) {
    const count = new Map<number, number>();
    for (let y = r.y0; y <= r.y1; y++) {
      for (let x = r.x0; x <= r.x1; x++) {
        const id = label[y * w + x];
        if (id) count.set(id, (count.get(id) ?? 0) + 1);
      }
    }
    let best = 0;
    let most = 0;
    for (const [id, n] of count) {
      if (n > most) {
        best = id;
        most = n;
      }
    }
    byDrawing.set(best, [...(byDrawing.get(best) ?? []), r]);
  }
  const groups: Group[] = [];
  for (const [id, panels] of byDrawing) {
    let r = panels[0];
    for (const p of panels) r = { x0: Math.min(r.x0, p.x0), y0: Math.min(r.y0, p.y0), x1: Math.max(r.x1, p.x1), y1: Math.max(r.y1, p.y1) };
    // Within the stretch of drawing, which can reach a little past the panels (a balloon over a gutter).
    const d = found[id - 1];
    if (d) r = { x0: Math.min(r.x0, d.x0), y0: Math.min(r.y0, d.y0), x1: Math.max(r.x1, d.x1), y1: Math.max(r.y1, d.y1) };
    groups.push({ box: boxOf(r, w, h), panels: panels.map((p) => boxOf(p, w, h)) });
  }
  return { groups, rtl: rtl.map((r) => boxOf(r, w, h)), ltr: ltr.map((r) => boxOf(r, w, h)) };
}

/** The page's groups of panels and their order: none when nothing on it can be told apart. */
export function framesOf(img: HTMLImageElement): Frames {
  const pic = greysOf(img);
  if (!pic) return { groups: [], rtl: [], ltr: [] };
  return framesIn(pic);
}

const holds = (b: Box, x: number, y: number) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
const distance = (b: Box, x: number, y: number) => Math.hypot(Math.max(b.x - x, 0, x - b.x - b.w), Math.max(b.y - y, 0, y - b.y - b.h));

/** Of some panels, the one a point is in, or else the nearest; the smaller when it's in two. */
function nearest(panels: Box[], x: number, y: number): Box | null {
  let panel: Box | null = null;
  let best = Infinity;
  for (const p of panels) {
    const d = distance(p, x, y);
    let better = d < best;
    if (d === best && panel && area(p) < area(panel)) better = true;
    if (better) {
      best = d;
      panel = p;
    }
  }
  return panel;
}

/**
 * The group a point on the page is in, and the panel in it: the smallest group that holds it, and
 * its panel nearest the point. A point in no group (a gutter, the margin) is in the panel nearest it.
 */
export function frameAt(frames: Frames, x: number, y: number): { group: Box; panel: Box } | null {
  const hit = frames.groups.filter((g) => holds(g.box, x, y)).sort((a, b) => area(a.box) - area(b.box))[0];
  if (hit) {
    const panel = nearest(hit.panels, x, y) ?? hit.box;
    return { group: hit.box, panel };
  }
  const panel = nearest(frames.rtl, x, y);
  if (!panel) return null;
  const group = frames.groups.find((g) => g.panels.some((p) => same(p, panel)));
  return { group: group?.box ?? panel, panel };
}

/** Whether two boxes are the same part of the page, as found apart (sent from the worker, say). */
export function same(a: Box, b: Box): boolean {
  const near = 1e-6;
  if (Math.abs(a.x - b.x) > near || Math.abs(a.y - b.y) > near) return false;
  return Math.abs(a.w - b.w) <= near && Math.abs(a.h - b.h) <= near;
}

const none: Frames = { groups: [], rtl: [], ltr: [] };

/** Pages' frames, by their picture, looked for once each, and those found already. */
const seen = new Map<string, Promise<Frames>>();
const known = new Map<string, Frames>();
/** Pages' frames being found by the worker, by the id each was sent with. */
let worker: Worker | null | undefined;
const asked = new Map<number, { img: HTMLImageElement; done: (f: Frames) => void }>();
let lastId = 0;

/** Found here, on the page's thread, as a last resort: the worker wouldn't start. */
function framesHere(img: HTMLImageElement): Frames {
  const pic = greysOf(img);
  if (!pic) return none;
  return framesIn(pic);
}

/** The worker that finds frames (frames.worker.ts), started the first time it's wanted; null when it won't start. */
function workerOf(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL('./frames.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    worker = null;
    return null;
  }
  worker.onmessage = (e: MessageEvent<{ id: number; frames: Frames }>) => {
    const a = asked.get(e.data.id);
    asked.delete(e.data.id);
    a?.done(e.data.frames);
  };
  worker.onerror = () => {
    worker?.terminate();
    worker = null;
    for (const a of asked.values()) a.done(framesHere(a.img));
    asked.clear();
  };
  return worker;
}

async function find(img: HTMLImageElement): Promise<Frames> {
  if (!img.naturalWidth) await img.decode().catch(() => {});
  const pic = greysOf(img);
  if (!pic) return none;
  const w = workerOf();
  if (!w) return framesIn(pic);
  return new Promise<Frames>((done) => {
    const id = ++lastId;
    asked.set(id, { img, done });
    w.postMessage({ id, pic }, [pic.luma.buffer]);
  });
}

/** The page's frames, looked for once per picture, away from the page's thread where it can be. */
export function framesSoon(img: HTMLImageElement): Promise<Frames> {
  const key = img.currentSrc || img.src;
  let found = seen.get(key);
  if (!found) {
    found = find(img).then((f) => {
      if (seen.has(key)) known.set(key, f);
      return f;
    });
    seen.set(key, found);
    // Only the pages about the screen are wanted again.
    if (seen.size > 80) {
      const old = seen.keys().next().value!;
      seen.delete(old);
      known.delete(old);
    }
  }
  return found;
}

/** The page's frames, when they've been found already. */
export function framesKnown(img: HTMLImageElement): Frames | null {
  return known.get(img.currentSrc || img.src) ?? null;
}
