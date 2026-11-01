import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { flushSync } from 'react-dom';
import type { RenderTask } from 'pdfjs-dist';
import { printOf } from '@breader/shared/ai';
import type { PdfBook } from '../../books/types';
import { WORDS_PER_PDF_PAGE } from '../../books/pdf';
import { glide } from '../../lib/glide';
import { BAR, footOf, type Loc, type Start, type TurnEvent, type ViewHandle } from './FlowView';
import { sentencesIn, type Sentence } from './narration';
import { findPictures, keepPictures } from './pictures';
import { cropOf, usualCrop, WHOLE } from './pdfCrop';
import { useNarrowPortrait, type Layout } from './settings';
import { runTurn, swaps, type TurnStyle } from './turn';

interface Props {
  book: PdfBook;
  layout: Layout;
  /** Whether pages are trimmed to their print (pdfCrop.ts), or drawn with the margins they have. */
  trim: boolean;
  start: Start;
  turnStyle: TurnStyle;
  onLocation: (l: Loc) => void;
  onWidth: (w: number) => void;
  onTurn?: (e: TurnEvent) => void;
}

interface Drawing {
  /** Settles once the page and its pictures are drawn. */
  promise: Promise<void>;
  cancel: () => void;
}

/**
 * Draws a page to fit, trimmed to its print if `trim`, and its pictures onto `pics` so dark themes
 * don't invert them.
 */
async function draw(book: PdfBook, index: number, canvas: HTMLCanvasElement, pics: HTMLCanvasElement | null, maxW: number, maxH: number, trim: boolean, alike = false): Promise<Drawing | null> {
  const page = await book.doc.getPage(index + 1);
  const base = page.getViewport({ scale: 1 });
  const crop = trim ? await cropOf(book, index, base.height / base.width, alike) : WHOLE;
  const cw = base.width * (crop.x1 - crop.x0);
  const ch = base.height * (crop.y1 - crop.y0);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const scale = Math.min(maxW / cw, maxH / ch) * dpr;
  // Shifted so the trimmed part lands at the canvas's corner; the rest falls outside it.
  const vp = page.getViewport({ scale, offsetX: -crop.x0 * base.width * scale, offsetY: -crop.y0 * base.height * scale });
  for (const c of pics ? [canvas, pics] : [canvas]) {
    c.width = Math.floor(cw * scale);
    c.height = Math.floor(ch * scale);
    c.style.width = `${Math.floor((cw * scale) / dpr)}px`;
    c.style.height = `${Math.floor((ch * scale) / dpr)}px`;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const found = pics ? findPictures(page, vp) : null;
  const task: RenderTask = page.render({ canvasContext: ctx, viewport: vp });
  return {
    promise: task.promise.then(() => (found && pics ? keepPictures(found, canvas, pics) : undefined)),
    cancel: () => task.cancel(),
  };
}

/** A page's text, as one paragraph. */
async function textOn(book: PdfBook, page: number): Promise<string> {
  const content = await (await book.doc.getPage(page + 1)).getTextContent();
  let text = '';
  for (const it of content.items) if ('str' in it) text += it.str + (it.hasEOL ? '\n' : '');
  // Words broken across lines join up again.
  return text.replace(/-\n(?=\p{Ll})/gu, '').replace(/\s+/g, ' ');
}

/** A page's text as sentences to read aloud. */
async function sentencesOn(book: PdfBook, page: number): Promise<Sentence[]> {
  const text = await textOn(book, page);
  return sentencesIn(text, 0).map(([start, end]) => ({ section: page, block: 0, start, end, text: text.slice(start, end) }));
}

export const PdfView = forwardRef<ViewHandle, Props>(function PdfView({ book, layout, trim, start, turnStyle, onLocation, onWidth, onTurn }, ref) {
  const total = book.pages;
  const [page, setPage] = useState(() =>
    start.kind === 'pos' ? Math.min(total - 1, start.pos.section) : Math.max(0, Math.min(total - 1, Math.floor(start.value * total))),
  );
  const [size, setSize] = useState({ w: 0, h: 0 });
  /** In pages, the room a page has: between the lines of controls, less the gutters (reader.css). */
  const [box, setBox] = useState({ w: 0, h: 0 });
  const pageRef = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(1.3);
  const narrowPortrait = useNarrowPortrait();
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const picsRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const onLocationRef = useRef(onLocation);
  onLocationRef.current = onLocation;
  /** Resolves once the page being turned to has drawn, so a transition shows it finished. */
  const drawn = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const el = rootRef.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = pageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [layout]);

  // The shape pages are laid out in before they're drawn: the first page's, trimmed as the book's usually are.
  useEffect(() => {
    let gone = false;
    void book.doc.getPage(1).then(async (p) => {
      const v = p.getViewport({ scale: 1 });
      const c = trim ? await usualCrop(book, v.height / v.width) : WHOLE;
      if (!gone) setRatio((v.height * (c.y1 - c.y0)) / (v.width * (c.x1 - c.x0)));
    });
    return () => { gone = true; };
  }, [book, trim]);

  // A phone's width is too little to give any away: pages go nearly edge to edge on narrow screens.
  // Narrow and held up, the page goes nearly edge to edge; elsewhere there's room for a margin.
  const gutter = narrowPortrait ? 10 : 48;
  const pageW = layout === 'pages' ? Math.min(box.w, box.h / ratio) : Math.min(860, size.w - 2 * gutter);
  useEffect(() => { if (pageW > 0) onWidth(pageW); }, [onWidth, pageW]);

  useEffect(() => {
    onLocationRef.current({
      section: page,
      block: 0,
      offset: 0,
      progress: page >= total - 1 ? 1 : page / total,
      sectionWordsLeft: WORDS_PER_PDF_PAGE,
      bookWordsLeft: (total - page - 1) * WORDS_PER_PDF_PAGE,
      line: `Page ${page + 1} of ${total}`,
      page,
      pages: total,
      screen: WORDS_PER_PDF_PAGE,
    });
  }, [page, total]);

  // Paged: draw the current page to fit the window.
  useEffect(() => {
    if (layout !== 'pages' || !box.w || !box.h || !canvasRef.current) return;
    let task: Drawing | null = null;
    let cancelled = false;
    void draw(book, page, canvasRef.current, picsRef.current, box.w, box.h, trim).then((t) => {
      if (cancelled) { t?.promise.catch(() => {}); t?.cancel(); return; }
      task = t;
      const done = () => { drawn.current?.(); drawn.current = null; };
      if (task) task.promise.then(done, () => { /* cancelled */ });
      else done();
    });
    return () => { cancelled = true; task?.cancel(); };
  }, [book, page, layout, box.w, box.h, trim]);

  // Scroll: draw pages as they come near the viewport.
  useEffect(() => {
    const root = scrollRef.current;
    if (layout !== 'scroll' || !root || pageW <= 0) return;
    const drawn = new Set<number>();
    let gone = false;
    const drawings: Drawing[] = [];
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const i = Number((e.target as HTMLElement).dataset.i);
        if (!e.isIntersecting || drawn.has(i)) continue;
        drawn.add(i);
        const [c, pics] = Array.from(e.target.querySelectorAll('canvas'));
        // Fitted to its slot, so a page of another shape can't spill into the next.
        if (c) void draw(book, i, c, pics ?? null, pageW, pageW * ratio, trim, true).then((t) => {
          t?.promise.catch(() => {});
          if (gone) { t?.cancel(); return; }
          if (t) drawings.push(t);
        });
      }
    }, { root, rootMargin: '800px 0px' });
    root.querySelectorAll('.pdf-slot').forEach((el) => io.observe(el));
    const slot = root.querySelector<HTMLElement>(`.pdf-slot[data-i="${page}"]`);
    if (slot) root.scrollTop = slot.offsetTop - 40;
    return () => { gone = true; io.disconnect(); drawings.forEach((d) => d.cancel()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, layout, pageW, ratio, trim]);

  const onScroll = () => {
    const root = scrollRef.current!;
    const top = root.scrollTop + 60;
    const slots = root.querySelectorAll<HTMLElement>('.pdf-slot');
    for (const s of Array.from(slots)) {
      if (s.offsetTop + s.offsetHeight > top) {
        const i = Number(s.dataset.i);
        if (i !== page) setPage(i);
        break;
      }
    }
  };

  const goTo = useCallback((i: number) => {
    const p = Math.max(0, Math.min(total - 1, i));
    if (p === page) return;
    if (layout === 'scroll') {
      setPage(p);
      const slot = scrollRef.current?.querySelector<HTMLElement>(`.pdf-slot[data-i="${p}"]`);
      if (slot) glide(scrollRef.current!, slot.offsetTop - 40 - scrollRef.current!.scrollTop);
      return;
    }
    const dir = p > page ? 1 : -1;
    const el = rootRef.current?.querySelector('.pdf-page');
    if (el) onTurn?.({ dir, chapter: Math.abs(p - page) > 1, rect: el.getBoundingClientRect() });
    if (!swaps(turnStyle)) { setPage(p); return; }
    runTurn(turnStyle, dir, Math.abs(p - page) > 1 ? 'chapter' : 'page', () => new Promise<void>((resolve) => {
      drawn.current = resolve;
      flushSync(() => setPage(p));
      window.setTimeout(resolve, 900);
    }), canvasRef.current?.getBoundingClientRect());
  }, [layout, total, page, turnStyle, onTurn]);

  useImperativeHandle(ref, () => ({
    goTo: (i) => goTo(i),
    goToFraction: (f) => goTo(Math.floor(Math.max(0, Math.min(0.999, f)) * total)),
    turn: (dir) => {
      if (layout === 'scroll') {
        // Less what the lines of controls cover, so no part of a page goes by unseen under them.
        const r = scrollRef.current!;
        glide(r, dir * Math.max(80, r.clientHeight - BAR - footOf(r) - 80));
      } else goTo(page + dir);
    },
    // Read aloud a page at a time. The text sits in the drawing, so nothing lights up.
    listen: {
      at: () => page,
      from: () => sentencesOn(book, page),
      show: (sn) => sn.section === page,
      onScreen: (sn) => sn.section === page,
      clear: () => {},
      section: async (i) => (i >= 0 && i < total ? sentencesOn(book, i) : null),
      print: async (i) => (i >= 0 && i < total ? printOf([await textOn(book, i)]) : null),
      reach: (sn) => goTo(sn.section),
    },
  }), [book, goTo, layout, page, total]);

  return (
    <div ref={rootRef} className={`pdfv is-${layout}`} style={{ '--vw': `${Math.max(0, pageW)}px`, '--pg-x': `${gutter}px` } as CSSProperties}>
      {layout === 'pages' ? (
        <>
          <div ref={pageRef} className="pdf-page"><canvas ref={canvasRef} /><canvas ref={picsRef} className="pdf-pics" /></div>
          <div className="fv-folio">{page + 1} of {total}</div>
          <button type="button" tabIndex={-1} className="fv-zone is-prev" aria-label="Previous page" onClick={() => goTo(page - 1)}><span>‹</span></button>
          <button type="button" tabIndex={-1} className="fv-zone is-next" aria-label="Next page" onClick={() => goTo(page + 1)}><span>›</span></button>
        </>
      ) : (
        <div ref={scrollRef} className="pdf-scroll" onScroll={onScroll}>
          {Array.from({ length: total }, (_, i) => (
            <div key={i} className="pdf-slot" data-i={i} style={{ width: pageW, height: pageW * ratio }}>
              <canvas />
              <canvas className="pdf-pics" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
