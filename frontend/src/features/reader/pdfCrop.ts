import type { PDFPageProxy } from 'pdfjs-dist';
import type { PdfBook } from '../../books/types';

/*
 * Most PDFs are laid out for paper, with wide white margins of their own. On a phone those margins
 * take a third of the screen, so a page is drawn trimmed to where its print is.
 *
 * Each page is trimmed alike, to the margins the book's pages usually have (left and right pages
 * apart, as books mirror them), so the text stays the same size from page to page. A page whose
 * print reaches further out, a wide table or a picture to the edge, keeps all of it.
 */

/** Part of a page, as fractions of its width and height. */
export interface Crop { x0: number; y0: number; x1: number; y1: number }

export const WHOLE: Crop = { x0: 0, y0: 0, x1: 1, y1: 1 };

/** How wide a page is drawn to find its print: enough to see a line of small text. */
const PROBE_W = 240;
/** Darker than this counts as print (0 black to 255 white), on white paper. */
const INK = 225;
/** On grey paper (a scan's), print must be this much darker than the paper. */
const PAPER_GAP = 40;
/** The paper is the tone this share of the page is at or below. */
const PAPER_SHARE = 0.7;
/** White kept around the print, as a part of the page's width. */
const PAD = 0.025;
/** Pages looked at for the book's usual margins. */
const SAMPLES = 10;

/** Where a page's print is, or null if it has none (a blank page). */
async function inkOn(page: PDFPageProxy): Promise<Crop | null> {
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: PROBE_W / base.width });
  const w = Math.max(1, Math.round(vp.width));
  const h = Math.max(1, Math.round(vp.height));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const px = ctx.getImageData(0, 0, w, h).data;
  const n = w * h;
  // Each pixel's brightness, and how many of each tone the page has.
  const lum = new Uint8Array(n);
  const tones = new Uint32Array(256);
  for (let j = 0; j < n; j++) {
    const i = j * 4;
    const v = Math.round(px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11);
    lum[j] = v;
    tones[v]++;
  }
  // The paper is the tone most of the page is at or below, the brightest of its tones: a scan's
  // paper is grey, not white, and the print is darker than that.
  let paper = 255;
  for (let v = 0, seen = 0; v < 256; v++) {
    seen += tones[v];
    if (seen >= PAPER_SHARE * n) { paper = v; break; }
  }
  const ink = Math.min(INK, paper - PAPER_GAP);
  const mark = new Uint8Array(n);
  const cols = new Uint32Array(w);
  for (let j = 0; j < n; j++) {
    if (lum[j] < ink) { mark[j] = 1; cols[j % w]++; }
  }
  // A scanner's frame and the shadow of a book's spine run the height or width of the page at its
  // edges, dark all the way along: not print. Only the outer tenth of the page is looked at for them.
  const outer = (i: number, size: number) => i < size * 0.1 || i >= size * 0.9;
  const dropX = new Uint8Array(w);
  for (let x = 0; x < w; x++) if (outer(x, w) && cols[x] > 0.6 * h) dropX[x] = 1;
  let keptW = 0;
  for (let x = 0; x < w; x++) if (!dropX[x]) keptW++;
  const rowsKept = new Uint32Array(h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) if (mark[y * w + x] && !dropX[x]) rowsKept[y]++;
  }
  const dropY = new Uint8Array(h);
  for (let y = 0; y < h; y++) if (outer(y, h) && rowsKept[y] > 0.6 * keptW) dropY[y] = 1;
  // The print that's left, by column and by row.
  const colsLeft = new Uint32Array(w);
  const rowsLeft = new Uint32Array(h);
  for (let y = 0; y < h; y++) {
    if (dropY[y]) continue;
    for (let x = 0; x < w; x++) {
      if (mark[y * w + x] && !dropX[x]) { colsLeft[x]++; rowsLeft[y]++; }
    }
  }
  // A speck or two isn't print: a scan's dust, a printer's mark.
  const span = (counts: Uint32Array, least: number): [number, number] | null => {
    let a = 0;
    while (a < counts.length && counts[a] < least) a++;
    let b = counts.length - 1;
    while (b > a && counts[b] < least) b--;
    return a < counts.length ? [a, b + 1] : null;
  };
  const xs = span(colsLeft, 2);
  const ys = span(rowsLeft, 2);
  if (!xs || !ys) return null;
  return { x0: xs[0] / w, x1: xs[1] / w, y0: ys[0] / h, y1: ys[1] / h };
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const union = (a: Crop, b: Crop): Crop => ({
  x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
});

/** Room around the print, kept inside the page. */
function padded(c: Crop, ratio: number): Crop {
  const px = PAD;
  const py = PAD / ratio;
  return { x0: Math.max(0, c.x0 - px), y0: Math.max(0, c.y0 - py), x1: Math.min(1, c.x1 + px), y1: Math.min(1, c.y1 + py) };
}

interface Trim {
  /** Where page i's print is, found once. */
  inkAt: (i: number) => Promise<Crop | null>;
  /** The book's usual print, on its odd pages and its even ones. */
  usual: Promise<{ odd: Crop | null; even: Crop | null; both: Crop | null }>;
}

const trims = new WeakMap<PdfBook, Trim>();

function trimOf(book: PdfBook): Trim {
  let t = trims.get(book);
  if (t) return t;
  const ink = new Map<number, Promise<Crop | null>>();
  const inkAt = (i: number) => {
    let p = ink.get(i);
    if (!p) {
      p = book.doc.getPage(i + 1).then(inkOn).catch(() => null);
      ink.set(i, p);
    }
    return p;
  };
  // Pages from the body of the book, past its cover and front matter.
  const from = Math.floor(book.pages * 0.15);
  const to = Math.max(from, Math.ceil(book.pages * 0.9) - 1);
  const picks = new Set<number>();
  for (let k = 0; k < SAMPLES; k++) picks.add(Math.round(from + ((to - from) * k) / Math.max(1, SAMPLES - 1)));
  const usual = Promise.all([...picks].map(async (i) => ({ i, c: await inkAt(i) }))).then((found) => {
    const of = (list: Array<{ c: Crop | null }>) => {
      const cs = list.map((f) => f.c).filter((c): c is Crop => !!c);
      if (!cs.length) return null;
      return { x0: median(cs.map((c) => c.x0)), y0: median(cs.map((c) => c.y0)), x1: median(cs.map((c) => c.x1)), y1: median(cs.map((c) => c.y1)) };
    };
    const odd = of(found.filter((f) => f.i % 2 === 0));
    const even = of(found.filter((f) => f.i % 2 === 1));
    const both = of(found);
    // Too few of one side to tell its margins: use every page's.
    return { odd: odd ?? both, even: even ?? both, both: odd && even ? union(odd, even) : both };
  });
  t = { inkAt, usual };
  trims.set(book, t);
  return t;
}

/**
 * The part of page `index` to draw: the book's usual print, and whatever of the page's own lies
 * outside it. `alike`: every page the same, left and right ones too, as when they're scrolled in a column.
 */
export async function cropOf(book: PdfBook, index: number, ratio: number, alike = false): Promise<Crop> {
  const t = trimOf(book);
  const [usual, own] = await Promise.all([t.usual, t.inkAt(index)]);
  const side = alike ? usual.both : index % 2 === 0 ? usual.odd : usual.even;
  const c = side && own ? union(side, own) : side ?? own;
  return c ? padded(c, ratio) : WHOLE;
}

/** The book's usual trimmed page, for sizing pages before they're drawn. */
export async function usualCrop(book: PdfBook, ratio: number): Promise<Crop> {
  const { both } = await trimOf(book).usual;
  return both ? padded(both, ratio) : WHOLE;
}
