import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { flushSync } from 'react-dom';
import type { RenderTask } from 'pdfjs-dist';
import type { PdfBook } from '../../books/types';
import { WORDS_PER_PDF_PAGE } from '../../books/pdf';
import type { Loc, Start, TurnEvent, ViewHandle } from './FlowView';
import { sentencesIn, type Sentence } from './narration';
import { findPictures, keepPictures } from './pictures';
import type { Layout } from './settings';
import { runTurn, swaps, type TurnStyle } from './turn';

interface Props {
  book: PdfBook;
  layout: Layout;
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

/** Draws a page to fit, and its pictures onto `pics` so dark themes don't invert them. */
async function draw(book: PdfBook, index: number, canvas: HTMLCanvasElement, pics: HTMLCanvasElement | null, maxW: number, maxH: number): Promise<Drawing | null> {
  const page = await book.doc.getPage(index + 1);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(maxW / base.width, maxH / base.height);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const vp = page.getViewport({ scale: scale * dpr });
  for (const c of pics ? [canvas, pics] : [canvas]) {
    c.width = Math.floor(vp.width);
    c.height = Math.floor(vp.height);
    c.style.width = `${Math.floor(vp.width / dpr)}px`;
    c.style.height = `${Math.floor(vp.height / dpr)}px`;
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

/** A page's text as sentences to read aloud. */
async function sentencesOn(book: PdfBook, page: number): Promise<Sentence[]> {
  const content = await (await book.doc.getPage(page + 1)).getTextContent();
  let text = '';
  for (const it of content.items) if ('str' in it) text += it.str + (it.hasEOL ? '\n' : '');
  // Words broken across lines join up again.
  text = text.replace(/-\n(?=\p{Ll})/gu, '').replace(/\s+/g, ' ');
  return sentencesIn(text, 0).map(([start, end]) => ({ section: page, block: 0, start, end, text: text.slice(start, end) }));
}

export const PdfView = forwardRef<ViewHandle, Props>(function PdfView({ book, layout, start, turnStyle, onLocation, onWidth, onTurn }, ref) {
  const total = book.pages;
  const [page, setPage] = useState(() =>
    start.kind === 'pos' ? Math.min(total - 1, start.pos.section) : Math.max(0, Math.min(total - 1, Math.floor(start.value * total))),
  );
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [ratio, setRatio] = useState(1.3);
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

  useEffect(() => {
    void book.doc.getPage(1).then((p) => {
      const v = p.getViewport({ scale: 1 });
      setRatio(v.height / v.width);
    });
  }, [book]);

  const pageW = layout === 'pages' ? Math.min(size.w - 96, (size.h - 96) / ratio) : Math.min(860, size.w - 96);
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
    });
  }, [page, total]);

  // Paged: draw the current page to fit the window.
  useEffect(() => {
    if (layout !== 'pages' || !size.w || !canvasRef.current) return;
    let task: Drawing | null = null;
    let cancelled = false;
    void draw(book, page, canvasRef.current, picsRef.current, size.w - 96, size.h - 96).then((t) => {
      if (cancelled) { t?.cancel(); return; }
      task = t;
      const done = () => { drawn.current?.(); drawn.current = null; };
      if (task) task.promise.then(done, () => { /* cancelled */ });
      else done();
    });
    return () => { cancelled = true; task?.cancel(); };
  }, [book, page, layout, size.w, size.h]);

  // Scroll: draw pages as they come near the viewport.
  useEffect(() => {
    const root = scrollRef.current;
    if (layout !== 'scroll' || !root || pageW <= 0) return;
    const drawn = new Set<number>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const i = Number((e.target as HTMLElement).dataset.i);
        if (!e.isIntersecting || drawn.has(i)) continue;
        drawn.add(i);
        const [c, pics] = Array.from(e.target.querySelectorAll('canvas'));
        if (c) void draw(book, i, c, pics ?? null, pageW, pageW * 4).then((t) => t?.promise.catch(() => {}));
      }
    }, { root, rootMargin: '800px 0px' });
    root.querySelectorAll('.pdf-slot').forEach((el) => io.observe(el));
    const slot = root.querySelector<HTMLElement>(`.pdf-slot[data-i="${page}"]`);
    if (slot) root.scrollTop = slot.offsetTop - 40;
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, layout, pageW]);

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
      if (slot) scrollRef.current!.scrollTo({ top: slot.offsetTop - 40, behavior: 'smooth' });
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
        const r = scrollRef.current!;
        r.scrollBy({ top: dir * (r.clientHeight - 80), behavior: 'smooth' });
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
      reach: (sn) => goTo(sn.section),
    },
  }), [book, goTo, layout, page, total]);

  return (
    <div ref={rootRef} className={`pdfv is-${layout}`} style={{ '--vw': `${Math.max(0, pageW)}px` } as CSSProperties}>
      {layout === 'pages' ? (
        <>
          <div className="pdf-page"><canvas ref={canvasRef} /><canvas ref={picsRef} className="pdf-pics" /></div>
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
