import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { flushSync } from 'react-dom';
import { animate } from 'motion';
import type { FlowBook, Position } from '../../books/types';
import { countWords } from '../../lib/format';
import { firstSentence } from '../../books/record';
import { charRect, collectBlocks, firstCharWhere, firstRect, rangeOf, sentenceAt } from './dom';
import { light, sentencesIn, type Listen, type Sentence } from './narration';
import { fontFamily, type Style, type StyleSettings } from './settings';
import { curves, runTurn, swaps, type TurnStyle } from './turn';

/** Gap between columns (and between page views). */
export const GAP = 80;

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
  | { kind: 'pos'; block: number; offset: number }
  | { kind: 'words'; value: number }
  | { kind: 'text'; needle: string }
  | { kind: 'anchor'; id: string };

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
}

const PAGE_SPRING = { type: 'spring', stiffness: 158, damping: 25.1, mass: 1 } as const;

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

export const FlowView = forwardRef<ViewHandle, Props>(function FlowView({ book, style, s, start, turnStyle, onLocation, onWidth, onTurn }, ref) {
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
  const pageRef = useRef(0);
  const pagesRef = useRef(1);
  const rootRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<HTMLDivElement>(null);
  const blocks = useRef<HTMLElement[]>([]);
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
  const colW = Math.max(260, Math.min(s.measure, size.w - 96));
  const spread = style === 'book' && pagesMode && size.w >= 2 * s.measure + GAP + 160;
  const viewW = spread ? colW * 2 + GAP : colW;
  const step = viewW + GAP;

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

  /* Geometry */
  const flowLeft = () => flowRef.current!.getBoundingClientRect().left;

  const measurePages = () => {
    const bl = blocks.current;
    const last = bl[bl.length - 1] ?? (flowRef.current!.lastElementChild as HTMLElement | null);
    if (!last) return 1;
    const rects = last.getClientRects();
    const r = rects[rects.length - 1] ?? last.getBoundingClientRect();
    return Math.max(1, Math.floor((r.left - flowLeft() + 1) / step) + 1);
  };

  const pageOf = (block: number, offset: number) => {
    const el = blocks.current[block];
    const r = el ? charRect(el, offset) : null;
    if (!r) return 0;
    return Math.max(0, Math.min(pagesRef.current - 1, Math.floor((r.left - flowLeft() + 1) / step)));
  };

  const locateNow = (): { block: number; offset: number } => {
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
        if (!hit) continue;
        const f = firstRect(bl[i]);
        if (!f || f.left - fl >= x0 - 1) return { block: i, offset: 0 };
        return { block: i, offset: firstCharWhere(bl[i], (r) => r.left - fl >= x0 - 1) };
      }
      return { block: bl.length - 1, offset: 0 };
    }
    const top = viewRef.current!.getBoundingClientRect().top + 8;
    for (let i = 0; i < bl.length; i++) {
      const r = bl[i].getBoundingClientRect();
      if (r.bottom <= top) continue;
      if (r.top >= top - 1) return { block: i, offset: 0 };
      return { block: i, offset: firstCharWhere(bl[i], (c) => c.top >= top - 1) };
    }
    return { block: bl.length - 1, offset: 0 };
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
    let atEnd = false;
    if (section === n - 1) {
      if (pagesMode) atEnd = pageRef.current >= pagesRef.current - 1;
      else { const v = viewRef.current!; atEnd = v.scrollTop + v.clientHeight >= v.scrollHeight - 4; }
    }
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
    });
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
    }
    const precise = t.kind === 'pos' || t.kind === 'words' || t.kind === 'anchor' || t.kind === 'text';
    if (pagesMode) {
      const total = measurePages();
      pagesRef.current = total;
      setPages(total);
      const p = t.kind === 'end' ? total - 1 : t.kind === 'start' ? 0 : pageOf(block, offset);
      pageRef.current = p;
      setPage(p);
      setX(p, true);
    } else {
      const v = viewRef.current!;
      if (t.kind === 'start') v.scrollTop = 0;
      else if (t.kind === 'end') v.scrollTop = v.scrollHeight;
      else {
        const r = bl[block] ? charRect(bl[block], offset) : null;
        if (r) v.scrollTop += r.top - v.getBoundingClientRect().top - 88;
      }
      pagesRef.current = 1;
      setPages(1);
      pageRef.current = 0;
      setPage(0);
    }
    loc.current = precise ? { block, offset } : locateNow();
    report();
  };

  useLayoutEffect(() => {
    const flow = flowRef.current;
    if (!flow || !size.w) return;
    const newSection = taggedFor.current !== section;
    if (newSection) {
      blocks.current = collectBlocks(flow);
      let acc = 0;
      blockWords.current = blocks.current.map((b) => { const at = acc; acc += countWords(b.textContent ?? ''); return at; });
      taggedFor.current = section;
    }
    if (!pagesMode) { animate(flow, { x: 0 }, { duration: 0 }); flow.style.transform = ''; }
    const t = pending.current ?? { kind: 'pos', block: loc.current.block, offset: loc.current.offset };
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
  }, [section, size.w, size.h, pagesMode, viewW, colW, s.font, s.size, s.lh, s.justify, style, fontTick]);

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
      v.scrollBy({ top: dir * (v.clientHeight - s.size * s.lh * 2), behavior: 'smooth' });
      return;
    }
    const np = pageRef.current + dir;
    if (np < 0) { if (section > 0) goSection(section - 1, { kind: 'end' }, -1); return; }
    if (np >= pagesRef.current) { if (section < n - 1) goSection(section + 1, { kind: 'start' }, 1); return; }
    const move = () => {
      pageRef.current = np;
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

  /** Where a character sits against the page on screen: on it, on the one after, or elsewhere. */
  const placeOf = (block: number, offset: number): 'here' | 'next' | 'away' => {
    const el = blocks.current[block];
    const r = el ? charRect(el, offset) : null;
    if (!r) return 'away';
    if (pagesMode) {
      const p = Math.floor((r.left - flowLeft() + 1) / step);
      return p === pageRef.current ? 'here' : p === pageRef.current + 1 ? 'next' : 'away';
    }
    const v = viewRef.current!.getBoundingClientRect();
    if (r.top >= v.top - 1 && r.bottom <= v.bottom - 24) return 'here';
    return r.top > v.top && r.top < v.bottom + v.height ? 'next' : 'away';
  };

  const listen: Listen = {
    at: () => section,
    from: async () => {
      const out: Sentence[] = [];
      const { block, offset } = loc.current;
      blocks.current.forEach((el, i) => {
        if (i < block) return;
        const text = el.textContent ?? '';
        for (const [start, end] of sentencesIn(text, i === block ? offset : 0)) out.push({ section, block: i, start, end, text: text.slice(start, end) });
      });
      return out;
    },
    show: (sn, at) => {
      if (sn.section !== section) return false;
      if (at === 0) {
        const el = blocks.current[sn.block];
        light(el ? rangeOf(el, sn.start, sn.end) : null);
      }
      const place = placeOf(sn.block, sn.start + at);
      if (place === 'next') {
        if (pagesMode) turn(1);
        else {
          const v = viewRef.current!;
          const r = charRect(blocks.current[sn.block], sn.start + at);
          if (r) v.scrollBy({ top: r.top - v.getBoundingClientRect().top - 88, behavior: 'smooth' });
        }
      }
      return place !== 'away';
    },
    onScreen: (sn, at) => sn.section === section && placeOf(sn.block, sn.start + at) === 'here',
    clear: () => light(null),
    next: () => {
      if (section >= n - 1) return false;
      goSection(section + 1, { kind: 'start' }, 1);
      return true;
    },
  };

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
  } as CSSProperties;

  return (
    <div
      ref={rootRef}
      className={`fv ${pagesMode ? 'is-pages' : 'is-scroll'}${s.justify ? ' is-justified' : ''}${spread ? ' is-spread' : ''}`}
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
