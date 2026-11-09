/*
 * Position helpers. A position is (block, character offset): stable across any reflow, unlike a
 * page number. These map between positions and what's on screen.
 */

const BLOCKS = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, figure, table, dt, dd, hr, div';
const INNER = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, figure, table, dt, dd, div';

/** Leaf-level block elements in reading order. */
export function collectBlocks(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(BLOCKS)).filter((el) => !el.querySelector(INNER));
}

/** A picture Immersive stops at, and the block it's in, or else the last one before it (-1: none). */
export interface Pic {
  el: Element;
  block: number;
  inside: boolean;
}

const WORDY = /[\p{L}\p{N}]/u;

/**
 * The pictures in reading order, by the blocks `collectBlocks` found. Not one set in a line of words
 * (a letter drawn as a picture), unless it's a figure's, whose caption is read after it.
 */
export function picturesIn(root: HTMLElement, blocks: HTMLElement[]): Pic[] {
  const out: Pic[] = [];
  let before = -1;
  for (const el of Array.from(root.querySelectorAll('img, svg'))) {
    if (el.parentElement?.closest('svg')) continue;
    while (before + 1 < blocks.length && blocks[before + 1].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING && !blocks[before + 1].contains(el)) before++;
    const host = blocks[before + 1];
    if (host?.contains(el)) {
      if (!host.closest('figure') && WORDY.test(host.textContent ?? '')) continue;
      out.push({ el, block: before + 1, inside: true });
    } else out.push({ el, block: before, inside: false });
  }
  return out;
}

function textNodes(el: HTMLElement): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

function rectAt(nodes: Text[], index: number): DOMRect | null {
  let i = index;
  for (const node of nodes) {
    const len = node.data.length;
    if (i < len) {
      const range = document.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const r = range.getClientRects()[0];
      return r && (r.width || r.height) ? r : null;
    }
    i -= len;
  }
  return null;
}

export function firstRect(el: HTMLElement): DOMRect | null {
  for (const r of Array.from(el.getClientRects())) if (r.width || r.height) return r;
  return null;
}

export function charRect(el: HTMLElement, offset: number): DOMRect | null {
  if (offset <= 0) return firstRect(el);
  const nodes = textNodes(el);
  for (let i = offset; i < offset + 40; i++) {
    const r = rectAt(nodes, i);
    if (r) return r;
  }
  return firstRect(el);
}

/** A range over characters [start, end) of a block's text. */
export function rangeOf(el: HTMLElement, start: number, end: number): Range | null {
  const nodes = textNodes(el);
  const range = document.createRange();
  let at = 0;
  let began = false;
  for (const node of nodes) {
    const len = node.data.length;
    if (!began && start < at + len) { range.setStart(node, start - at); began = true; }
    if (began && end <= at + len) { range.setEnd(node, end - at); return range; }
    at += len;
  }
  if (!began) return null;
  const last = nodes[nodes.length - 1];
  range.setEnd(last, last.data.length);
  return range;
}

/** The text position at a point on screen, where the browser can say. */
export function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const p = 'caretPositionFromPoint' in document ? document.caretPositionFromPoint(x, y) : null;
  if (p) return { node: p.offsetNode, offset: p.offset };
  const r = 'caretRangeFromPoint' in document ? document.caretRangeFromPoint(x, y) : null;
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}

/** How many characters of a block's text come before a position in it. */
export function offsetIn(el: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange();
  range.setStart(el, 0);
  range.setEnd(node, offset);
  return range.toString().length;
}

/** The first character in the block for which `pred` holds, by binary search (characters flow in order). */
export function firstCharWhere(el: HTMLElement, pred: (r: DOMRect) => boolean): number {
  const nodes = textNodes(el);
  const total = nodes.reduce((n, t) => n + t.data.length, 0);
  let lo = 0;
  let hi = total - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = rectAt(nodes, mid);
    if (r && pred(r)) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

/** The sentence around a character offset, for the library card's "where you stopped" line. */
export function sentenceAt(text: string, offset: number): string {
  const re = /[.!?…]["”’)\]]*\s+/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && m.index + m[0].length <= offset) start = m.index + m[0].length;
  re.lastIndex = Math.max(offset, start);
  const e = re.exec(text);
  const end = e ? e.index + e[0].length : text.length;
  const s = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return s.length > 280 ? `${s.slice(0, 277)}…` : s;
}
