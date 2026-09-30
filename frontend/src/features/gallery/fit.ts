/*
 * Fitting a card's text to its card. A title first shrinks until its longest word fits on a line,
 * so words never break, then a little more to fit all of it. Whatever still doesn't fit is cut
 * at a word with an ellipsis, in the text itself: a line clamp alone leaves the next line laid out
 * under the last, and the reading face's tall letters reach up past the clip. Every element that
 * is cut this way carries its full text in data-full; the text node React made is edited in
 * place, so React's own updates still land.
 */

/** Titles shrink this far below their set size to fit whole, before they're cut. */
const TITLE_FLOOR = 0.8;
/** The elements cut with an ellipsis, and the titles among them, which shrink first. */
const CUT = '.t-title, .t-line, .c-sub, .mc-title';

/**
 * Whether `el`'s text runs to more lines than it shows. Its scroll height can't tell: the reading
 * face's letters hang below their line box, so even one word seems to overflow. So the lines the
 * text is laid out on are counted instead, clamped ones included.
 */
function over(el: HTMLElement): boolean {
  const cs = getComputedStyle(el);
  const lh = parseFloat(cs.lineHeight);
  if (!lh) return el.scrollHeight > el.clientHeight + 1;
  const shown = Math.round((el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / lh);
  const range = document.createRange();
  range.selectNodeContents(el);
  const tops = Array.from(range.getClientRects(), (r) => r.top).sort((a, b) => a - b);
  let lines = 0;
  let last = -Infinity;
  for (const top of tops) {
    if (top - last <= lh / 2) continue;
    lines++;
    last = top;
  }
  return lines > shown;
}

function textNode(el: HTMLElement): Text | null {
  const t = el.firstChild;
  return t && t.nodeType === Node.TEXT_NODE ? (t as Text) : null;
}

/** Cuts `el`'s text at the last word that leaves room for an ellipsis. Returns what it shows. */
function cut(el: HTMLElement, full: string): string {
  const node = textNode(el);
  if (!node) return full;
  node.nodeValue = full;
  if (!over(el)) return full;
  const words = full.split(/\s+/);
  const at = (k: number) => `${words.slice(0, k).join(' ').replace(/[\s,;:.\-–—]+$/, '')}…`;
  let lo = 1;
  let hi = words.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    node.nodeValue = at(mid);
    if (over(el)) hi = mid - 1;
    else lo = mid;
  }
  node.nodeValue = at(lo);
  return node.nodeValue;
}

/** Shrinks titles until the longest word fits, then toward TITLE_FLOOR until all of it does. */
function shrink(titles: HTMLElement[]) {
  const t = titles[0];
  const set = (px: number) => titles.forEach((el) => el.style.setProperty('font-size', `${Math.floor(px * 10) / 10}px`));
  const base = parseFloat(getComputedStyle(t).fontSize);
  for (let i = 0; i < 3; i++) {
    const cs = getComputedStyle(t);
    const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const room = t.clientWidth - pad;
    const need = t.scrollWidth - pad;
    if (need <= room + 0.5 || room <= 0) break;
    set(parseFloat(cs.fontSize) * (room / need));
  }
  for (let i = 0; i < 4 && over(t); i++) {
    const size = parseFloat(getComputedStyle(t).fontSize);
    if (size <= base * TITLE_FLOOR + 0.5) break;
    set(Math.max(base * TITLE_FLOOR, size * 0.94));
  }
}

/**
 * Fits the text of a card: `faces` are its page face and its ink face, which hold the same text
 * and must be set the same.
 */
export function fitCard(tile: HTMLElement | null) {
  if (!tile) return;
  const faces = Array.from(tile.querySelectorAll<HTMLElement>(':scope > .tile-face, :scope > .tile-art'));
  const all = faces.flatMap((f) => Array.from(f.querySelectorAll<HTMLElement>(CUT)));
  // Back to the whole text at the set size, then fit again.
  for (const el of all) {
    const node = textNode(el);
    if (node && el.dataset.full != null) node.nodeValue = el.dataset.full;
    if (el.classList.contains('t-title')) el.style.removeProperty('font-size');
  }
  const titles = all.filter((el) => el.classList.contains('t-title') && el.offsetParent);
  if (titles.length) shrink(titles);
  // Each distinct piece of text is fitted once, on the first face that shows it; the others copy it.
  const done = new Map<string, string>();
  for (const el of all) {
    const full = el.dataset.full;
    if (full == null || !el.offsetParent) continue;
    const key = `${el.className}|${full}`;
    const shown = done.get(key) ?? cut(el, full);
    done.set(key, shown);
    const node = textNode(el);
    if (node && node.nodeValue !== shown) node.nodeValue = shown;
  }
}

/** Whether a card's text was cut short: its full text differs from what it shows. */
export const isCut = (el: HTMLElement) => el.dataset.full != null && el.textContent !== el.dataset.full;
