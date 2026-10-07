import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { animate } from 'motion';
import { printOf } from '@breader/shared/ai';
import type { FlowBook, Position } from '../../books/types';
import { countWords } from '../../lib/format';
import { glide, stopGlide } from '../../lib/glide';
import { firstSentence } from '../../books/record';
import { caretAt, charRect, collectBlocks, firstCharWhere, firstRect, offsetIn, picturesIn, rangeOf, sentenceAt, type Pic } from './dom';
import { pad2 } from './chapters';
import { lookLeft, useLook } from './look';
import { light, sentencesIn, type Listen, type Paragraph, type Sentence } from './narration';
import { fontFamily, type Style, type StyleSettings } from './settings';
import { curves, runTurn, swaps, type TurnStyle } from './turn';

/** Gap between columns (and between page views). */
export const GAP = 80;
/** The lines of controls above and below the text (instrument.css), which cover a scrolled page's edges. */
export const BAR = 76;

export interface Loc {
  section: number;
  block: number;
  offset: number;
  progress: number;
  sectionWordsLeft: number;
  bookWordsLeft: number;
  line: string;
  page: number;
  pages: number;
  /** About how many words fit on the screen here. */
  screen: number;
}

/** Where to open: an exact position, or a fraction of the book plus the saved sentence to look for. */
export type Start = { kind: 'pos'; pos: Position } | { kind: 'fraction'; value: number; line?: string };

export interface ViewHandle {
  goTo: (section: number, anchor?: string) => void;
  /** Open at a fraction of the whole book. */
  goToFraction: (f: number) => void;
  turn: (dir: 1 | -1) => void;
  /** For reading aloud (narration.ts). */
  listen: Listen;
}

/** Told to the reader's controls as a page or chapter change starts, e.g. to sweep a line across it. */
export interface TurnEvent {
  dir: 1 | -1;
  chapter: boolean;
  rect: DOMRect;
}

type Target =
  | { kind: 'start' }
  | { kind: 'end' }
  /** `y`: scrolled, how far down the view to put it (just under the top line of controls, if not said). */
  | { kind: 'pos'; block: number; offset: number; y?: number }
  | { kind: 'words'; value: number }
  | { kind: 'text'; needle: string }
  | { kind: 'anchor'; id: string }
  /** The chapter's how-manyth picture (Sentence.pic). */
  | { kind: 'pic'; n: number };

const norm = (t: string) => t.replace(/\s+/g, ' ').trim();
const plain = (html: string) =>
  norm(html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"));

interface Props {
  book: FlowBook;
  style: Style;
  s: StyleSettings;
  start: Start;
  turnStyle: TurnStyle;
  onLocation: (l: Loc) => void;
  onWidth: (w: number) => void;
  onTurn?: (e: TurnEvent) => void;
  /** Each paragraph shows its number, for Immersive's choosing where to begin. */
  numbered?: boolean;
  /** The line of controls above the text is showing, over the top of a scrolled page. */
  head?: boolean;
  /**
   * What goes after a chapter's text, on its page but not part of the book (comments): never
   * read, lit or stopped at (dom.ts ASIDE). Null for none.
   */
  aside?: (section: number) => ReactNode;
}

const PAGE_SPRING = { type: 'spring', stiffness: 158, damping: 25.1, mass: 1 } as const;

const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/**
 * A chapter's sentences from `block` and `offset` on (all of them, from -1), with a stop at each
 * picture where it falls among them: those after that point, and any `seen` before it.
 */
function inOrder(section: number, blocks: HTMLElement[], pics: Pic[], block = -1, offset = 0, seen: (n: number) => boolean = () => false): Sentence[] {
  const out: Sentence[] = [];
  const at = new Map<number, number[]>();
  pics.forEach((p, n) => {
    if (p.block > block || (p.block === block && (!p.inside || offset === 0)) || seen(n)) at.set(p.block, [...(at.get(p.block) ?? []), n]);
  });
  const stops = (b: number, inside: boolean) => {
    for (const n of at.get(b) ?? []) if (pics[n].inside === inside) out.push({ section, block: Math.max(0, b), start: 0, end: 0, text: '', pic: n });
  };
  stops(-1, false);
  blocks.forEach((el, b) => {
    stops(b, true);
    if (b >= block) {
      const text = el.textContent ?? '';
      for (const [start, end] of sentencesIn(text, b === block ? offset : 0)) out.push({ section, block: b, start, end, text: text.slice(start, end) });
    }
    stops(b, false);
  });
  return out;
}

/** Paragraphs get numbers: blocks with words, not headings (the chapter's title isn't paragraph 1). */
const isParagraph = (el: HTMLElement) => !/^H[1-6]$/.test(el.tagName) && /[\p{L}\p{N}]/u.test(el.textContent ?? '');

function resolveStart(book: FlowBook, starts: number[], start: Start): { section: number; target: Target } {
  if (start.kind === 'pos' && start.pos.section < book.sections.length) {
    return { section: start.pos.section, target: { kind: 'pos', block: start.pos.block, offset: start.pos.offset } };
  }
  const f = start.kind === 'fraction' ? start.value : 0;
  if (f <= 0 || f >= 1) return { section: 0, target: { kind: 'start' } };
  // Prefer the saved sentence itself; percentages drift when a file carries front matter.
  const needle = start.kind === 'fraction' && start.line ? norm(start.line).slice(0, 60) : '';
  if (needle.length >= 12) {
    const guess = Math.floor(f * book.sections.length);
    const order = book.sections.map((_, i) => i).sort((a, b) => Math.abs(a - guess) - Math.abs(b - guess));
    const hit = order.find((i) => plain(book.sections[i].html).includes(needle));
    if (hit !== undefined) return { section: hit, target: { kind: 'text', needle } };
  }
  const w = f * book.words;
  let s = 0;
  while (s + 1 < starts.length && starts[s + 1] <= w) s++;
  return { section: s, target: { kind: 'words', value: w - starts[s] } };
}

export const FlowView = forwardRef<ViewHandle, Props>(function FlowView({ book, style, s, start, turnStyle, onLocation, onWidth, onTurn, numbered = false, head = true, aside }, ref) {
  const n = book.sections.length;
  const starts = useMemo(() => {
    let acc = 0;
    return book.sections.map((sec) => { const at = acc; acc += sec.words; return at; });
  }, [book]);
  const [init] = useState(() => resolveStart(book, starts, start));
  const [section, setSection] = useState(init.section);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [fontTick, setFontTick] = useState(0);

  const pending = useRef<Target | null>(init.target);
  const loc = useRef({ block: 0, offset: 0 });
  /** Scrolled: how far down the view the reader's place is, to put it back there after a change of size or font. */
  const locY = useRef<number | null>(null);
  const pageRef = useRef(0);
  const pagesRef = useRef(1);
  const rootRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<HTMLDivElement>(null);
  const blocks = useRef<HTMLElement[]>([]);
  const pics = useRef<Pic[]>([]);
  /** The place is a picture Immersive turned to: a page count changed by a picture drawn late keeps it. */
  const onPic = useRef<number | null>(null);
  /** Pictures drawn since the chapter was laid out, which take room the pages didn't count. */
  const [drawn, setDrawn] = useState(0);
  const blockWords = useRef<number[]>([]);
  const taggedFor = useRef(-1);
  const onLocationRef = useRef(onLocation);
  onLocationRef.current = onLocation;
  const onTurnRef = useRef(onTurn);
  onTurnRef.current = onTurn;
  /** Direction of the chapter change being landed, for the arrival animation. */
  const arriving = useRef<1 | -1 | 0>(0);
  const swap = swaps(turnStyle);

  const pagesMode = s.layout === 'pages';
  // On a phone the words run to 12px from each edge: every bit of a small screen goes to the text.
  const colW = Math.max(260, Math.min(s.measure, size.w - (size.w < 640 ? 24 : 96)));
  const spread = style === 'book' && pagesMode && size.w >= 2 * s.measure + GAP + 160;
  const viewW = spread ? colW * 2 + GAP : colW;
  const step = viewW + GAP;
  // Paged, the view reaches past the text this far each side for the paragraph numbers in the
  // margin: under half the gap between pages, so the next page's numbers never show.
  const hang = pagesMode ? Math.max(0, Math.min(GAP / 2, (size.w - viewW) / 2)) : 0;

  useEffect(() => { onWidth(pagesMode ? viewW : colW); }, [onWidth, pagesMode, viewW, colW]);

  useLayoutEffect(() => {
    const el = rootRef.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const fonts = document.fonts;
    if (!fonts) return;
    const bump = () => setFontTick((t) => t + 1);
    fonts.addEventListener('loadingdone', bump);
    return () => fonts.removeEventListener('loadingdone', bump);
  }, []);

  const html = useMemo(() => ({ __html: book.sections[section]?.html ?? '' }), [book, section]);

  // The aside is drawn into a box kept at the end of the chapter's text, put back each time the
  // text is replaced.
  const asideNode = aside?.(section) ?? null;
  const hasAside = !!asideNode;
  const [host] = useState(() => {
    const el = document.createElement('div');
    el.className = 'fv-aside';
    el.dataset.aside = '';
    return el;
  });
  /** Paged, the aside is on the page on screen: the page-turn zones keep to the margins, off it. */
  const [asideHere, setAsideHere] = useState(false);

  /* Geometry */
  const flowLeft = () => flowRef.current!.getBoundingClientRect().left;

  /** The last box of the text: its last block, or a picture after it. The aside isn't text. */
  const textEnds = (aside: boolean) => {
    const bl = blocks.current;
    return [bl[bl.length - 1] ?? (flowRef.current!.lastElementChild as HTMLElement | null), pics.current[pics.current.length - 1]?.el, aside && host.isConnected ? host : null].flatMap((el) => {
      if (!el) return [];
      const rects = el.getClientRects();
      return [rects[rects.length - 1] ?? el.getBoundingClientRect()];
    });
  };

  const measurePages = () => {
    const ends = textEnds(true).map((r) => r.left);
    if (!ends.length) return 1;
    return Math.max(1, Math.floor((Math.max(...ends) - flowLeft() + 1) / step) + 1);
  };

  /**
   * The text's end is on screen: the book has been read to its last word. The comments after it
   * add pages or scroll, which nobody has to go through to finish.
   */
  const textEndShown = () => {
    const ends = textEnds(false);
    if (!ends.length) return true;
    if (pagesMode) return pageRef.current >= Math.floor((Math.max(...ends.map((r) => r.left)) - flowLeft() + 1) / step);
    const v = viewRef.current!;
    if (v.scrollTop + v.clientHeight >= v.scrollHeight - 4) return true;
    return Math.max(...ends.map((r) => r.bottom)) <= v.getBoundingClientRect().bottom + 4;
  };

  const pageAt = (r: DOMRect) => Math.max(0, Math.min(pagesRef.current - 1, Math.floor((r.left - flowLeft() + 1) / step)));

  const pageOf = (block: number, offset: number) => {
    const el = blocks.current[block];
    const r = el ? charRect(el, offset) : null;
    return r ? pageAt(r) : 0;
  };

  /** The first character on screen (scrolled: from `below` pixels down the view), and how far down it is. */
  const locate = (below = 8): { block: number; offset: number; y?: number } => {
    const bl = blocks.current;
    if (!bl.length) return { block: 0, offset: 0 };
    if (pagesMode) {
      const fl = flowLeft();
      const x0 = pageRef.current * step;
      const x1 = x0 + viewW;
      for (let i = 0; i < bl.length; i++) {
        let hit = false;
        for (const r of Array.from(bl[i].getClientRects())) {
          if (!r.width && !r.height) continue;
          if (r.right - fl > x0 + 1 && r.left - fl < x1 - 1) { hit = true; break; }
        }
        if (!hit) {
          // A page with only a picture on it: the place is the first block after it.
          const after = firstRect(bl[i]);
          if (after && after.left - fl >= x1 - 1) return { block: i, offset: 0 };
          continue;
        }
        const f = firstRect(bl[i]);
        if (!f || f.left - fl >= x0 - 1) return { block: i, offset: 0 };
        return { block: i, offset: firstCharWhere(bl[i], (r) => r.left - fl >= x0 - 1) };
      }
      return { block: bl.length - 1, offset: 0 };
    }
    const box = viewRef.current!.getBoundingClientRect().top;
    const top = box + below;
    for (let i = 0; i < bl.length; i++) {
      const r = bl[i].getBoundingClientRect();
      if (r.bottom <= top) continue;
      if (r.top >= top - 1) return { block: i, offset: 0, y: r.top - box };
      const offset = firstCharWhere(bl[i], (c) => c.top >= top - 1);
      return { block: i, offset, y: (charRect(bl[i], offset)?.top ?? top) - box };
    }
    return { block: bl.length - 1, offset: 0 };
  };

  /** The reader's place: the first character on screen. */
  const locateNow = () => {
    const { block, offset, y } = locate();
    locY.current = y ?? null;
    return { block, offset };
  };

  /** The sentence to show on the library card; headings and images defer to the next real text. */
  const lineAt = (block: number, offset: number) => {
    const bl = blocks.current;
    const el = bl[block];
    const text = el?.textContent?.trim() ?? '';
    if (text && !/^H[1-6]$/.test(el.tagName)) return sentenceAt(el.textContent ?? '', offset);
    for (let i = block + 1; i < Math.min(bl.length, block + 40); i++) {
      if (/^H[1-6]$/.test(bl[i].tagName)) continue;
      const t = bl[i].textContent?.trim();
      if (t) return sentenceAt(t, 0);
    }
    return firstSentence(book.sections, section + 1) || text || book.title;
  };

  const report = () => {
    const { block, offset } = loc.current;
    const el = blocks.current[block];
    const text = el?.textContent ?? '';
    const into = (blockWords.current[block] ?? 0) + countWords(text.slice(0, offset));
    const secWords = Math.max(book.sections[section]?.words ?? 0, into);
    const done = starts[section] + into;
    const v = viewRef.current!;
    const atEnd = section === n - 1 && textEndShown();
    onLocationRef.current({
      section,
      block,
      offset,
      progress: atEnd ? 1 : book.words ? Math.min(0.999, done / book.words) : 0,
      sectionWordsLeft: Math.max(0, secWords - into),
      bookWordsLeft: atEnd ? 0 : Math.max(0, book.words - done),
      line: lineAt(block, offset),
      page: pageRef.current,
      pages: pagesRef.current,
      screen: pagesMode ? secWords / pagesRef.current : (secWords * v.clientHeight) / Math.max(1, v.scrollHeight),
    });
    const r = pagesMode && host.isConnected ? host.getClientRects()[0] : undefined;
    setAsideHere(!!r && pageAt(r) <= pageRef.current);
  };

  const setX = (p: number, instant: boolean) => {
    const el = flowRef.current;
    if (!el) return;
    animate(el, { x: -p * step }, instant ? { duration: 0 } : PAGE_SPRING);
    // A view transition snapshots the next frame, so an instant move lands now, not a frame later.
    if (instant) el.style.transform = `translateX(${-p * step}px)`;
  };

  const land = (t: Target) => {
    const bl = blocks.current;
    let block = 0;
    let offset = 0;
    if (t.kind === 'pos') {
      block = Math.min(t.block, Math.max(0, bl.length - 1));
      offset = t.offset;
    } else if (t.kind === 'words') {
      const bw = blockWords.current;
      while (block + 1 < bw.length && bw[block + 1] <= t.value) block++;
    } else if (t.kind === 'text') {
      const i = bl.findIndex((b) => norm(b.textContent ?? '').includes(t.needle));
      if (i >= 0) {
        block = i;
        const raw = bl[i].textContent ?? '';
        const head = t.needle.slice(0, 16);
        const at = raw.replace(/\s+/g, ' ').indexOf(head);
        offset = Math.max(0, at);
      }
    } else if (t.kind === 'anchor') {
      const target = flowRef.current!.querySelector<HTMLElement>(`#${CSS.escape(t.id)}`);
      const i = target ? bl.findIndex((b) => b === target || b.contains(target) || target.contains(b)) : -1;
      block = Math.max(0, i);
    } else if (t.kind === 'pic') {
      block = Math.max(0, pics.current[t.n]?.block ?? 0);
    }
    const pic = t.kind === 'pic' ? pics.current[t.n]?.el : undefined;
    onPic.current = t.kind === 'pic' && pic ? t.n : null;
    const precise = t.kind === 'pos' || t.kind === 'words' || t.kind === 'anchor' || t.kind === 'text' || t.kind === 'pic';
    if (pagesMode) {
      const total = measurePages();
      pagesRef.current = total;
      setPages(total);
      const p = t.kind === 'end' ? total - 1 : t.kind === 'start' ? 0 : pic ? pageAt(pic.getBoundingClientRect()) : pageOf(block, offset);
      pageRef.current = p;
      setPage(p);
      setX(p, true);
    } else {
      const v = viewRef.current!;
      stopGlide(v);
      if (t.kind === 'start') v.scrollTop = 0;
      else if (t.kind === 'end') v.scrollTop = v.scrollHeight;
      else if (pic) v.scrollTop += pic.getBoundingClientRect().top - v.getBoundingClientRect().top - 88;
      else {
        const r = bl[block] ? charRect(bl[block], offset) : null;
        if (r) v.scrollTop += r.top - v.getBoundingClientRect().top - (t.kind === 'pos' ? t.y ?? 88 : 88);
      }
      pagesRef.current = 1;
      setPages(1);
      pageRef.current = 0;
      setPage(0);
    }
    if (precise) {
      loc.current = { block, offset };
      const r = !pagesMode && bl[block] ? charRect(bl[block], offset) : null;
      locY.current = r ? r.top - viewRef.current!.getBoundingClientRect().top : null;
    } else loc.current = locateNow();
    report();
  };

  // Numbers on the paragraphs, drawn by CSS from an attribute so the text's own offsets don't
  // move, and hung in the margin, so no line moves either.
  useLayoutEffect(() => {
    const flow = flowRef.current;
    if (!flow) return;
    let n = 0;
    for (const el of collectBlocks(flow)) {
      if (numbered && isParagraph(el)) el.dataset.para = pad2(++n);
      else delete el.dataset.para;
    }
  }, [numbered, section]);

  useLayoutEffect(() => {
    const flow = flowRef.current;
    if (!flow || !size.w) return;
    if (!hasAside) host.remove();
    else if (host.parentNode !== flow) flow.appendChild(host);
    const newSection = taggedFor.current !== section;
    if (newSection) {
      blocks.current = collectBlocks(flow);
      pics.current = picturesIn(flow, blocks.current);
      let acc = 0;
      blockWords.current = blocks.current.map((b) => { const at = acc; acc += countWords(b.textContent ?? ''); return at; });
      taggedFor.current = section;
    }
    if (!pagesMode) { animate(flow, { x: 0 }, { duration: 0 }); flow.style.transform = ''; }
    // Nowhere new to go: the place stays where it was on screen, or on the picture it was turned to.
    const t: Target = pending.current ?? (onPic.current !== null && pagesMode ? { kind: 'pic', n: onPic.current } : { kind: 'pos', block: loc.current.block, offset: loc.current.offset, y: locY.current ?? undefined });
    pending.current = null;
    land(t);
    const dir = arriving.current;
    arriving.current = 0;
    if (newSection) {
      if (dir && turnStyle === 'slide') {
        // The Rail: a new chapter carries on in the direction you were going.
        viewRef.current!.animate(
          [{ opacity: 0, translate: `${dir * 56}px 0` }, { opacity: 1, translate: '0 0' }],
          { duration: curves.smooth.ms, easing: curves.smooth.easing },
        );
      } else if (!dir || !swap) {
        flow.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: 'ease-out' });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, size.w, size.h, pagesMode, viewW, colW, s.font, s.size, s.lh, s.justify, style, fontTick, drawn, hasAside]);

  // The aside growing (a thread opened, comments arriving) adds pages after the text: counted,
  // without moving the page on screen.
  const recount = useRef(() => {});
  recount.current = () => {
    if (!pagesMode || !host.isConnected || !blocks.current.length) return;
    const total = measurePages();
    if (total === pagesRef.current) return;
    pagesRef.current = total;
    setPages(total);
    report();
  };
  useEffect(() => {
    const ro = new ResizeObserver(() => recount.current());
    ro.observe(host);
    return () => ro.disconnect();
  }, [host]);

  useEffect(() => {
    const flow = flowRef.current;
    if (!flow) return;
    let frame = 0;
    const loaded = (e: Event) => {
      if (!(e.target instanceof HTMLImageElement)) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setDrawn((d) => d + 1));
    };
    flow.addEventListener('load', loaded, true);
    return () => {
      flow.removeEventListener('load', loaded, true);
      cancelAnimationFrame(frame);
    };
  }, []);

  const announce = (dir: 1 | -1, chapter: boolean) => {
    const v = viewRef.current;
    if (v) onTurnRef.current?.({ dir, chapter, rect: v.getBoundingClientRect() });
  };

  const goSection = (i: number, t: Target, towards?: 1 | -1) => {
    if (i < 0 || i >= n) return;
    const dir = towards ?? (i >= section ? 1 : -1);
    const move = () => {
      if (i === section) {
        pending.current = null;
        land(t);
      } else {
        pending.current = t;
        arriving.current = dir;
        // Inside a view transition the new chapter has to be on screen before the callback returns.
        if (swap) flushSync(() => setSection(i));
        else setSection(i);
      }
    };
    announce(dir, i !== section);
    runTurn(turnStyle, dir, 'chapter', move, viewRef.current?.getBoundingClientRect());
  };

  const turn = (dir: 1 | -1) => {
    if (!pagesMode) {
      const v = viewRef.current!;
      if (dir > 0 && v.scrollTop + v.clientHeight >= v.scrollHeight - 4) { if (section < n - 1) goSection(section + 1, { kind: 'start' }, 1); return; }
      if (dir < 0 && v.scrollTop <= 0) { if (section > 0) goSection(section - 1, { kind: 'end' }, -1); return; }
      // What can be seen between the lines of controls, less two lines to read on from, so none
      // go by unseen under them.
      const lines = s.size * s.lh * 2;
      glide(v, dir * Math.max(lines, v.clientHeight - (head ? BAR : 0) - BAR - lines));
      return;
    }
    const np = pageRef.current + dir;
    if (np < 0) { if (section > 0) goSection(section - 1, { kind: 'end' }, -1); return; }
    if (np >= pagesRef.current) { if (section < n - 1) goSection(section + 1, { kind: 'start' }, 1); return; }
    const move = () => {
      pageRef.current = np;
      onPic.current = null;
      if (swap) flushSync(() => setPage(np));
      else setPage(np);
      setX(np, swap);
      loc.current = locateNow();
      report();
    };
    announce(dir, false);
    runTurn(turnStyle, dir, 'page', move, viewRef.current?.getBoundingClientRect());
  };

  /* Reading aloud */

  /**
   * The page is scrolling itself to keep up with the voice. Those scrolls move the reader's place
   * too, but aren't the reader going somewhere else: the spot the voice is on is where the page is
   * headed. The reader's own wheel, touch or keys end it at once (glide.ts).
   */
  const steering = useRef(false);
  const steerings = useRef(0);
  const steered = () => !pagesMode && steering.current;
  const steer = (by: number) => {
    const mine = ++steerings.current;
    steering.current = true;
    glide(viewRef.current!, by, () => { if (steerings.current === mine) steering.current = false; });
  };

  /** Where a character sits against the page on screen: on it, on the one after, or elsewhere. */
  const placeOf = (block: number, offset: number): 'here' | 'next' | 'away' => {
    const el = blocks.current[block];
    const r = el ? charRect(el, offset) : null;
    if (!r) return 'away';
    if (pagesMode) {
      const p = Math.floor((r.left - flowLeft() + 1) / step);
      return p === pageRef.current ? 'here' : p === pageRef.current + 1 ? 'next' : 'away';
    }
    // Not under the lines of controls, which cover the first and last few lines of a scrolled page.
    const v = viewRef.current!.getBoundingClientRect();
    if (r.top >= v.top + (head ? BAR : 0) - 1 && r.bottom <= v.bottom - BAR - 8) return 'here';
    return r.top > v.top && r.top < v.bottom + v.height ? 'next' : 'away';
  };

  /** The same for a picture: scrolled, it's on screen once most of it can be seen. */
  const picPlace = (el: Element): 'here' | 'next' | 'away' => {
    const r = el.getBoundingClientRect();
    if (pagesMode) {
      const p = Math.floor((r.left - flowLeft() + 1) / step);
      return p === pageRef.current ? 'here' : p === pageRef.current + 1 ? 'next' : 'away';
    }
    const v = viewRef.current!.getBoundingClientRect();
    const top = v.top + (head ? BAR : 0);
    const bottom = v.bottom - BAR;
    if (Math.min(r.bottom, bottom) - Math.max(r.top, top) >= Math.min(r.height, bottom - top) * 0.6) return 'here';
    return r.top > v.top && r.top < v.bottom + v.height ? 'next' : 'away';
  };

  /** Turns to a picture stop, or scrolls it to the middle of what can be seen (its top to the top, when it's taller). */
  const showPic = (n: number) => {
    light(null);
    const el = pics.current[n]?.el;
    if (!el) return false;
    const place = picPlace(el);
    if (pagesMode) {
      if (place === 'next') turn(1);
    } else if (!steered() && place !== 'away') {
      const r = el.getBoundingClientRect();
      const box = viewRef.current!.getBoundingClientRect();
      const top = box.top + (head ? BAR : 0);
      const by = r.top - top - Math.max(0, (box.bottom - BAR - top - r.height) / 2);
      if (Math.abs(by) > 24) steer(by);
    }
    return place !== 'away';
  };

  const listen: Listen = {
    at: () => section,
    from: async () => {
      // Scrolled, from the first line that can be seen, not one under the controls. And a picture
      // on screen above that, at the top of the page.
      const { block, offset } = pagesMode ? loc.current : locate(head ? BAR : 8);
      return inOrder(section, blocks.current, pics.current, block, offset, (n) => picPlace(pics.current[n].el) === 'here');
    },
    show: (sn, at, centre) => {
      if (sn.section !== section) return false;
      if (sn.pic !== undefined) return showPic(sn.pic);
      const el = blocks.current[sn.block];
      light(el ? rangeOf(el, sn.start, sn.end) : null, el && at > 0 ? rangeOf(el, sn.start, sn.start + at) : null);
      const place = placeOf(sn.block, sn.start + at);
      if (pagesMode) {
        if (place === 'next') turn(1);
      } else if (!steered() && (place === 'next' || (centre && at === 0 && place === 'here'))) {
        // Scrolled: bring the words near the top, or in Immersive, the sentence to the middle.
        const v = viewRef.current!;
        const r = charRect(blocks.current[sn.block], sn.start + at);
        const box = v.getBoundingClientRect();
        const top = r && r.top - box.top - (centre ? box.height * 0.38 : 88);
        if (top && Math.abs(top) > (centre ? box.height * 0.12 : 0)) steer(top);
      }
      return place !== 'away';
    },
    onScreen: (sn, at) => {
      if (sn.section !== section) return false;
      if (steered()) return true;
      if (sn.pic === undefined) return placeOf(sn.block, sn.start + at) === 'here';
      const el = pics.current[sn.pic]?.el;
      return !!el && picPlace(el) === 'here';
    },
    clear: () => light(null),
    section: async (i) => {
      const html = book.sections[i]?.html;
      if (html === undefined) return null;
      // Parsed apart from the page, so nothing in it loads: the same blocks and pictures the page would have.
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const bl = collectBlocks(doc.body);
      return inOrder(i, bl, picturesIn(doc.body, bl));
    },
    reach: (sn, at) => goSection(sn.section, sn.pic !== undefined ? { kind: 'pic', n: sn.pic } : { kind: 'pos', block: sn.block, offset: sn.start + at }),
    picture: async (sn) => {
      const el = sn.section === taggedFor.current && sn.pic !== undefined ? pics.current[sn.pic]?.el : undefined;
      if (!el) return false;
      if (el instanceof HTMLImageElement && !el.complete) await Promise.race([el.decode().catch(() => {}), wait(2000)]);
      for (let waited = 0; !listenRef.current.onScreen(sn, 0) && waited < 1500; waited += 50) await wait(50);
      if (!listenRef.current.onScreen(sn, 0)) return false;
      // A flourish between scenes, or a letter drawn as a picture, isn't stopped at.
      const r = el.getBoundingClientRect();
      return r.width >= 100 && r.height >= 100;
    },
    print: async (i) => {
      const html = book.sections[i]?.html;
      if (html === undefined) return null;
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return printOf(collectBlocks(doc.body).map((el) => el.textContent ?? ''));
    },
    paragraphs: () => {
      const out: Paragraph[] = [];
      blocks.current.forEach((el, b) => {
        if (!isParagraph(el)) return;
        const text = el.textContent ?? '';
        const [first] = sentencesIn(text, 0);
        if (first) out.push({ n: out.length + 1, s: { section, block: b, start: first[0], end: first[1], text: text.slice(first[0], first[1]) } });
      });
      return out;
    },
    range: (sn) => {
      const el = sn.section === section && sn.pic === undefined ? blocks.current[sn.block] : undefined;
      return el ? rangeOf(el, sn.start, sn.end) : null;
    },
    pick: (x, y) => {
      const hit = caretAt(x, y);
      const i = hit ? blocks.current.findIndex((b) => b.contains(hit.node)) : -1;
      const el = blocks.current[i];
      // On a paragraph, not the space between two.
      if (!hit || !el || !Array.from(el.getClientRects()).some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) return null;
      const at = offsetIn(el, hit.node, hit.offset);
      const text = el.textContent ?? '';
      const all = sentencesIn(text, 0);
      const found = all.find(([, end]) => at < end) ?? all[all.length - 1];
      return found ? { section, block: i, start: found[0], end: found[1], text: text.slice(found[0], found[1]) } : null;
    },
  };

  const listenRef = useRef(listen);
  listenRef.current = listen;

  // The ring in the corner of a picture Immersive waits on, counting down, kept there as the page
  // moves. On the picture, not under it, where a caption would be.
  const look = useLook();
  const looked = look && look.section === section ? look : null;
  const ringRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!looked) return;
    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const el = pics.current[looked.pic]?.el;
      const ring = ringRef.current;
      if (!el || !ring) return;
      const r = el.getBoundingClientRect();
      const box = rootRef.current!.getBoundingClientRect();
      const v = viewRef.current!.getBoundingClientRect();
      const x = Math.min(r.right, v.right) - 10 - ring.offsetWidth;
      const y = Math.min(r.bottom, v.bottom - (pagesMode ? 4 : BAR)) - 10 - ring.offsetHeight;
      ring.style.translate = `${x - box.left}px ${y - box.top}px`;
      ring.style.setProperty('--left', lookLeft().toFixed(4));
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [looked, pagesMode]);

  useImperativeHandle(ref, () => ({
    goTo: (i, anchor) => goSection(i, anchor ? { kind: 'anchor', id: anchor } : { kind: 'start' }),
    goToFraction: (f) => {
      const at = resolveStart(book, starts, { kind: 'fraction', value: Math.min(0.999, Math.max(0, f)) });
      goSection(at.section, at.target);
    },
    turn,
    listen,
  }));

  const scrollFrame = useRef(0);
  const onScroll = () => {
    cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = requestAnimationFrame(() => {
      loc.current = locateNow();
      report();
    });
  };

  const onFlowClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    const href = a.getAttribute('data-href');
    if (href !== null) {
      e.preventDefault();
      const [sec, anchor] = href.split('#');
      goSection(Number(sec), anchor ? { kind: 'anchor', id: anchor } : { kind: 'start' });
    } else if (a.getAttribute('href') === '#') {
      e.preventDefault();
    }
  };

  const onZone = (dir: 1 | -1) => {
    if (window.getSelection()?.toString()) return;
    turn(dir);
  };

  const title = book.sections[section]?.title ?? '';
  const cssVars = {
    '--rf': fontFamily(s.font),
    '--rs': `${s.size}px`,
    '--rl': s.lh,
    '--cw': `${colW}px`,
    '--vw': `${viewW}px`,
    '--gap': `${GAP}px`,
    '--hang': `${hang}px`,
  } as CSSProperties;

  return (
    <div
      ref={rootRef}
      className={`fv ${pagesMode ? 'is-pages' : 'is-scroll'}${s.justify ? ' is-justified' : ''}${spread ? ' is-spread' : ''}${asideHere && pagesMode ? ' is-aside' : ''}`}
      style={cssVars}
    >
      {pagesMode && <div className="fv-rh">{style === 'book' ? title : ''}</div>}
      <div ref={viewRef} className="fv-view" onScroll={pagesMode ? undefined : onScroll}>
        {!pagesMode && section > 0 && (
          <div className="fv-prev">
            <button type="button" className="btn btn-ghost" onClick={() => goSection(section - 1, { kind: 'start' })}>‹ {book.sections[section - 1]?.title}</button>
          </div>
        )}
        <div ref={flowRef} className="fv-flow" onClick={onFlowClick} dangerouslySetInnerHTML={html} />
        {asideNode && createPortal(asideNode, host)}
        {!pagesMode && (
          <div className="fv-next">
            {section >= n - 1 ? (
              <span>The end</span>
            ) : (
              <button type="button" className="btn btn-quiet" onClick={() => goSection(section + 1, { kind: 'start' })}>
                Next: {book.sections[section + 1]?.title} ›
              </button>
            )}
          </div>
        )}
      </div>
      {looked && (
        <div ref={ringRef} className={`fv-look${looked.held ? ' is-held' : ''}`} role="timer" aria-label="A picture. Tap to go on, or hold to keep looking.">
          <svg viewBox="0 0 28 28" aria-hidden="true">
            <circle className="is-track" cx="14" cy="14" r="10" pathLength={1} />
            <circle className="is-left" cx="14" cy="14" r="10" pathLength={1} />
          </svg>
        </div>
      )}
      {pagesMode && (
        <>
          <div className="fv-folio">{pages > 1 ? `${page + 1} of ${pages}` : ''}</div>
          <button type="button" tabIndex={-1} className="fv-zone is-prev" aria-label="Previous page" onClick={() => onZone(-1)}><span>‹</span></button>
          <button type="button" tabIndex={-1} className="fv-zone is-next" aria-label="Next page" onClick={() => onZone(1)}><span>›</span></button>
        </>
      )}
    </div>
  );
});
