import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { flushSync } from 'react-dom';
import type { MangaBook, RemoteChapter } from '../../books/types';
import { glide } from '../../lib/glide';
import { BAR, type Loc, type Start, type TurnEvent, type ViewHandle } from './FlowView';
import type { Layout, MangaDir } from './settings';
import { runTurn } from './turn';

/*
 * A manga's pages. Scrolled, they're a column read downwards, with no gaps between a webtoon's
 * strips. In pages, they turn one at a time, or two side by side as the book prints them once the
 * screen is wide enough, right to left as manga is read (or left to right, as comics are). A page's
 * picture comes out of the file as it nears the screen, and is let go once it's well behind.
 * A series read from MangaDex is its chapters one after another: scrolled, each starts under a line
 * crediting who made it, and in pages, a chapter starts on a page of its own.
 */

interface Props {
  book: MangaBook;
  layout: Layout;
  dir: MangaDir;
  start: Start;
  onLocation: (l: Loc) => void;
  onWidth: (w: number) => void;
  onTurn?: (e: TurnEvent) => void;
}

/** A page's height over its width, until its file says: a manga volume's usual shape. */
const RATIO = 1.42;
/** Wider than this is a spread drawn across two pages, so it shows on its own. */
const WIDE = 0.9;
/** Taller than this, typically, is a webtoon's long strip, read with no gaps between its pieces. */
const STRIP = 1.9;
/** Scrolled: the column at its widest, and the space between pages. */
const COLUMN = 860;
const GAP = 16;
/** Scrolled: room above the first page and below the last, clear of the lines of controls. */
const HEAD = BAR + 12;
const TAIL = BAR + 24;
/** Page sizes read from the file at a time. */
const BATCH = 24;
/** Pages kept open past those wanted, so going back a little doesn't open them again. */
const SPARE = 6;
/** Scrolled: the line before each chapter of a series read from MangaDex. */
const BAND = 56;

/** The space beside the pages: on a phone, the screen is better spent on the page (and the lines of controls cover it). */
const sideOf = (w: number) => (w < 640 ? 16 : 48);
const wait = (ms: number) => new Promise<null>((done) => window.setTimeout(() => done(null), ms));

/** Where the reader is: a page, and how far down it a scrolled page is at the top of the screen. */
interface At {
  page: number;
  frac: number;
  /** Scrolled to the very end. */
  end: boolean;
}

function startAt(start: Start, total: number, book: MangaBook): At {
  if (start.kind === 'pos') {
    const page = book.locate ? book.locate(start.pos) : start.pos.section;
    return { page: Math.max(0, Math.min(total - 1, page)), frac: Math.max(0, Math.min(1, start.pos.offset / 1000)), end: false };
  }
  const x = Math.max(0, Math.min(0.9999, start.value)) * total;
  return { page: Math.floor(x), frac: x - Math.floor(x), end: false };
}

/** The usual shape of the pages known so far. */
function typicalOf(ratios: number[]): number {
  const known = ratios.filter((r) => r > 0).sort((a, b) => a - b);
  return known.length ? known[Math.floor(known.length / 2)] : RATIO;
}

/**
 * Pages as they face each other in print: the cover alone, then in twos, with a spread drawn across
 * two pages on its own (and the page before it, when that leaves it without a partner). Each
 * chapter of a series starts alone, as its cover does, and no two pages of different chapters pair.
 */
function spreadsOf(ratio: (i: number) => number, total: number, two: boolean, starts: ReadonlySet<number>): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < total; ) {
    if (two && i > 0 && i + 1 < total && !starts.has(i) && !starts.has(i + 1) && ratio(i) >= WIDE && ratio(i + 1) >= WIDE) {
      out.push([i, i + 1]);
      i += 2;
    } else {
      out.push([i]);
      i += 1;
    }
  }
  return out;
}

/** The page at a height down the column: the last that starts above it. */
function pageAt(tops: number[], y: number): number {
  let lo = 0;
  let hi = tops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Pages' pictures as object URLs: opened as they're wanted, let go once they're far from the screen. */
class Pictures {
  private urls = new Map<number, Promise<string | null>>();
  private book: MangaBook;
  constructor(book: MangaBook) {
    this.book = book;
  }

  /** Page i's picture, or null when it won't open. */
  get(i: number): Promise<string | null> {
    let u = this.urls.get(i);
    if (!u) {
      u = this.book.page(i).then((b) => URL.createObjectURL(b), () => null);
      this.urls.set(i, u);
    }
    return u;
  }

  /** Lets go of every page outside from to to. */
  keep(from: number, to: number) {
    for (const [i, u] of this.urls) {
      if (i >= from && i <= to) continue;
      this.urls.delete(i);
      void u.then((url) => { if (url) URL.revokeObjectURL(url); });
    }
  }
}

export const MangaView = forwardRef<ViewHandle, Props>(function MangaView({ book, layout, dir, start, onLocation, onWidth, onTurn }, ref) {
  const total = book.pages;
  const per = book.words / Math.max(1, total);
  const rtl = dir === 'rtl';
  const [at, setAt] = useState<At>(() => startAt(start, total, book));
  const [size, setSize] = useState({ w: 0, h: 0 });
  /** Each page's height over its width, 0 until known. */
  const [ratios, setRatios] = useState<number[]>(() => new Array<number>(total).fill(0));
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const onLocationRef = useRef(onLocation);
  onLocationRef.current = onLocation;
  /** Scrolled: the exact place at the top of the screen, kept as pages above it change size. */
  const anchor = useRef({ page: at.page, frac: at.frac });
  /** Pages: the page a turn is on its way to, so turns pressed quickly follow on from it. */
  const goal = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = rootRef.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Every page's size from its file's first bytes: those around where the book opens first, then
  // the rest in order, as pairing pages up needs every page before.
  useEffect(() => {
    let live = true;
    const near = Array.from({ length: 14 }, (_, k) => at.page - 2 + k).filter((i) => i >= 0 && i < total);
    const order = [...near, ...Array.from({ length: total }, (_, i) => i).filter((i) => !near.includes(i))];
    void (async () => {
      for (let k = 0; k < order.length && live; k += BATCH) {
        const chunk = order.slice(k, k + BATCH);
        const sizes = await Promise.all(chunk.map((i) => book.size(i).catch(() => null)));
        if (!live) return;
        // A series read from MangaDex says nothing here: its pictures tell their sizes as they come.
        if (!sizes.some(Boolean)) continue;
        setRatios((rs) => {
          const next = rs.slice();
          chunk.forEach((i, j) => {
            const s = sizes[j];
            // A size from the picture itself, once it's shown, is surer: it's kept.
            if (s && !next[i]) next[i] = s.h / s.w;
          });
          return next;
        });
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, total]);

  /** The picture as shown can disagree with its file's header (a photo turned by its camera's note). */
  const measured = (i: number, img: HTMLImageElement) => {
    const r = img.naturalHeight / img.naturalWidth;
    if (!r || !Number.isFinite(r)) return;
    setRatios((rs) => {
      if (Math.abs((rs[i] || 0) - r) < 0.005) return rs;
      const next = rs.slice();
      next[i] = r;
      return next;
    });
  };

  const typical = useMemo(() => typicalOf(ratios), [ratios]);
  const ratio = useCallback((i: number) => ratios[i] || typical, [ratios, typical]);
  const strip = typical > STRIP;
  const side = sideOf(size.w);
  const areaW = Math.max(0, size.w - 2 * side);
  const areaH = Math.max(0, size.h - 2 * BAR);
  // Two side by side when each can be nearly as tall as one alone.
  const two = layout === 'pages' && !strip && areaW / 2 >= 0.85 * (areaH / typical);

  /** A series' chapters by the page each starts on; those read on their publisher's site too, and at the end, past the last page. */
  const bands = useMemo(() => {
    const m = new Map<number, RemoteChapter[]>();
    for (const c of book.remote?.chapters ?? []) m.set(c.first, [...(m.get(c.first) ?? []), c]);
    return m;
  }, [book]);
  const starts = useMemo(() => new Set(book.remote?.chapters.filter((c) => c.pages > 0).map((c) => c.first) ?? []), [book]);
  const spreads = useMemo(() => spreadsOf(ratio, total, two, starts), [ratio, total, two, starts]);
  const spreadAt = useMemo(() => {
    const at = new Int32Array(total);
    spreads.forEach((s, k) => s.forEach((i) => { at[i] = k; }));
    return at;
  }, [spreads, total]);
  // Opened in pages, pairs wait (a moment at most) for the sizes of the pages before, so they don't change partners.
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setWaited(true), 800);
    return () => window.clearTimeout(t);
  }, []);
  const paired = !two || waited || ratios.slice(0, Math.min(total, at.page + 2)).every((r) => r > 0);
  const spread = spreads[spreadAt[Math.min(total - 1, at.page)]] ?? [at.page];

  // Scrolled: a column of pages at its width, each at its own height.
  const colW = Math.min(COLUMN, areaW);
  const gap = strip ? 0 : GAP;
  const { tops, heights, height } = useMemo(() => {
    const tops: number[] = [];
    const heights: number[] = [];
    let y = HEAD;
    for (let i = 0; i < total; i++) {
      y += (bands.get(i)?.length ?? 0) * BAND;
      tops.push(y);
      heights.push(Math.max(1, Math.round(colW * ratio(i))));
      y += heights[i] + gap;
    }
    return { tops, heights, height: y - gap + (bands.get(total)?.length ?? 0) * BAND + TAIL };
  }, [ratio, total, colW, gap, bands]);

  // The width the controls line up with: steady from page to page.
  const pageW = layout === 'pages' ? Math.min(areaW, ((two ? 2 : 1) * areaH) / typical) : colW;
  useEffect(() => { if (pageW > 0) onWidth(pageW); }, [onWidth, pageW]);

  // Scrolled: the pages near the screen, to show.
  const [win, setWin] = useState<[number, number]>(() => [at.page - 1, at.page + 3]);
  const placeFromScroll = () => {
    const el = scrollRef.current;
    if (!el || !tops.length) return;
    const y = el.scrollTop + BAR;
    const i = pageAt(tops, y);
    const frac = Math.max(0, Math.min(1, (y - tops[i]) / heights[i]));
    anchor.current = { page: i, frac };
    const end = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    // A tenth of a page at a time: close enough for the place kept, without a render a pixel.
    const tenth = Math.floor(frac * 10) / 10;
    setAt((a) => (a.page === i && a.frac === tenth && a.end === end ? a : { page: i, frac: tenth, end }));
    const from = pageAt(tops, el.scrollTop - el.clientHeight);
    const to = pageAt(tops, el.scrollTop + 2.5 * el.clientHeight);
    setWin((w) => (w[0] === from && w[1] === to ? w : [from, to]));
  };

  // Scrolled: the place stays put as the column is laid out again (sizes found, a new width).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (layout !== 'scroll' || !el || colW <= 0) return;
    const a = anchor.current;
    el.scrollTop = tops[a.page] + a.frac * heights[a.page] - BAR;
    placeFromScroll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, tops, heights, colW]);

  // Pictures: those to show, and the next few, opened ahead.
  const pics = useMemo(() => new Pictures(book), [book]);
  useEffect(() => () => pics.keep(1, 0), [pics]);
  const [srcs, setSrcs] = useState<ReadonlyMap<number, string | null>>(() => new Map());
  const s = spreadAt[Math.min(total - 1, at.page)];
  const [wantFrom, wantTo] = layout === 'pages'
    ? [spreads[Math.max(0, s - 1)]?.[0] ?? 0, spreads[Math.min(spreads.length - 1, s + 2)]?.slice(-1)[0] ?? total - 1]
    : [win[0], win[1] + 3];
  useEffect(() => {
    let live = true;
    const from = Math.max(0, wantFrom);
    const to = Math.min(total - 1, wantTo);
    pics.keep(from - SPARE, to + SPARE);
    setSrcs((m) => {
      const kept = new Map([...m].filter(([i]) => i >= from - SPARE && i <= to + SPARE));
      return kept.size === m.size ? m : kept;
    });
    for (let i = from; i <= to; i++) {
      void pics.get(i).then((url) => {
        if (live) setSrcs((m) => (m.get(i) === url ? m : new Map(m).set(i, url)));
      });
    }
    return () => { live = false; };
  }, [pics, wantFrom, wantTo, total]);

  useEffect(() => {
    const shown = layout === 'pages' ? spread : [at.page];
    const first = shown[0];
    const last = shown[shown.length - 1];
    const end = layout === 'pages' ? last >= total - 1 : at.end;
    const exact = layout === 'scroll' ? at.page + at.frac : first;
    const next = book.toc.find((t) => t.section > first)?.section ?? total;
    // A series' place goes by its chapter: page 5 of the series means little.
    const ch = book.remote?.chapters.filter((c) => c.pages > 0 && c.first <= first).pop();
    onLocationRef.current({
      section: first,
      block: book.anchor?.(first) ?? 0,
      offset: layout === 'scroll' ? Math.round(at.frac * 1000) : 0,
      progress: end ? 1 : exact / total,
      sectionWordsLeft: Math.round(Math.max(1, next - exact) * per),
      bookWordsLeft: end ? 0 : Math.round((total - (layout === 'pages' ? last + 1 : exact)) * per),
      line: ch ? `${ch.label}, page ${first - ch.first + 1} of ${ch.pages}` : `Page ${first + 1} of ${total}`,
      page: first,
      pages: total,
      screen: Math.round(shown.length * per),
    });
    // The spread is new each time pages change shape; its first and last pages are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, layout, spread[0], spread[spread.length - 1], total, per, book]);

  /** Goes to a page (and scrolled, that far down it). */
  const goTo = useCallback(async (p: number, frac = 0) => {
    const page = Math.max(0, Math.min(total - 1, p));
    if (layout === 'scroll') {
      const el = scrollRef.current;
      if (!el) return;
      anchor.current = { page, frac };
      const by = tops[page] + frac * heights[page] - BAR - el.scrollTop;
      // A long way is a jump: gliding there would open every page on the way.
      if (Math.abs(by) > 2 * el.clientHeight) el.scrollTop += by;
      else glide(el, by);
      return;
    }
    const from = spreadAt[Math.min(total - 1, goal.current ?? at.page)];
    const to = spreadAt[page];
    if (from === to && goal.current === null) return;
    const target = spreads[to];
    goal.current = target[0];
    // The new page is ready before it's turned to, so the turn shows it, not a blank.
    const urls = await Promise.race([Promise.all(target.map((i) => pics.get(i))), wait(800)]);
    // A later turn took over.
    if (goal.current !== target[0]) return;
    const d: 1 | -1 = to > from ? 1 : -1;
    const el = rootRef.current?.querySelector('.mg-spread');
    const rect = el?.getBoundingClientRect();
    if (rect) onTurn?.({ dir: d, chapter: Math.abs(to - from) > 1, rect });
    anchor.current = { page: target[0], frac: 0 };
    // Right to left, the next page comes in from the left.
    runTurn('wipe', rtl ? (-d as 1 | -1) : d, Math.abs(to - from) > 1 ? 'chapter' : 'page', async () => {
      flushSync(() => {
        if (urls) setSrcs((m) => { const next = new Map(m); target.forEach((i, k) => next.set(i, urls[k])); return next; });
        setAt({ page: target[0], frac: 0, end: false });
      });
      // Until here, a turn pressed again goes on from this one.
      if (goal.current === target[0]) goal.current = null;
      const imgs = Array.from(rootRef.current?.querySelectorAll<HTMLImageElement>('.mg-spread img') ?? []);
      await Promise.race([Promise.all(imgs.map((im) => im.decode().catch(() => {}))), wait(700)]);
    }, rect);
  }, [layout, total, tops, heights, spreadAt, spreads, at.page, pics, rtl, onTurn]);

  const turn = useCallback((d: 1 | -1) => {
    if (layout === 'scroll') {
      // Less what the lines of controls cover, so no part of a page goes by unseen under them.
      const r = scrollRef.current;
      if (r) glide(r, d * Math.max(80, r.clientHeight - 2 * BAR - 80));
      return;
    }
    const next = spreads[spreadAt[Math.min(total - 1, goal.current ?? at.page)] + d];
    if (next) void goTo(next[0]);
  }, [layout, spreads, spreadAt, total, at.page, goTo]);

  useImperativeHandle(ref, () => ({
    goTo: (i) => void goTo(i),
    goToFraction: (f) => {
      const x = Math.max(0, Math.min(0.9999, f)) * total;
      void goTo(Math.floor(x), x - Math.floor(x));
    },
    turn,
    // Nothing to read aloud: pictures, not text.
    listen: {
      at: () => at.page,
      from: async () => [],
      show: () => false,
      onScreen: (sn) => sn.section === at.page,
      clear: () => {},
      section: async () => null,
      // Back to a place kept: scrolled, `start` is how far down its page, in thousandths.
      reach: (sn) => void goTo(book.locate ? book.locate({ section: sn.section, block: sn.block, offset: sn.start }) : sn.section, sn.start / 1000),
    },
  }), [goTo, turn, total, at.page, book]);

  const picture = (i: number) => {
    const src = srcs.get(i);
    if (src === undefined) return null;
    if (src === null) return <span className="mg-broken">Page {i + 1} won’t open</span>;
    return <img src={src} alt={`Page ${i + 1}`} draggable={false} decoding="async" onLoad={(e) => measured(i, e.currentTarget)} />;
  };

  const fit = (pages: number[]) => {
    const h = Math.min(areaH, areaW / pages.reduce((n, i) => n + 1 / ratio(i), 0));
    return pages.map((i) => ({ i, w: Math.floor(h / ratio(i)), h: Math.floor(h) }));
  };

  const shownFrom = Math.max(0, win[0]);
  const shownTo = Math.min(total - 1, win[1]);
  /** The lines before page i (or after the last, at total): a chapter each, who made it or where it's read. */
  const bandsAt = (i: number, bottom: number) => {
    const here = bands.get(i) ?? [];
    return here.map((c, k) => (
      <div key={`b-${c.id}`} className={`mg-band${c.external ? ' is-out' : ''}`} style={{ top: bottom - (here.length - k) * BAND, height: BAND }}>
        <b>{c.number !== null && c.title ? `${c.label} · ${c.title}` : c.label}</b>
        {c.external ? (
          <a href={c.external} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>Read on its publisher’s site ↗</a>
        ) : (
          <span>{c.groups.length ? c.groups.map((g) => g.name).join(' & ') : 'No group credited'}</span>
        )}
      </div>
    ));
  };
  return (
    <div ref={rootRef} className={`mgv is-${layout}`} style={{ '--vw': `${Math.max(0, pageW)}px` } as CSSProperties}>
      {layout === 'pages' ? (
        <>
          <div className="mg-pages">
            {paired && size.w > 0 && (
              <div className={`mg-spread${rtl ? ' is-rtl' : ''}`}>
                {fit(spread).map(({ i, w, h }) => (
                  <div key={i} className="mg-pg" style={{ width: w, height: h }}>{picture(i)}</div>
                ))}
              </div>
            )}
          </div>
          {/* Right to left, the left side goes on. */}
          <button type="button" tabIndex={-1} className="fv-zone is-prev" aria-label={rtl ? 'Next page' : 'Previous page'} onClick={() => turn(rtl ? 1 : -1)}><span>‹</span></button>
          <button type="button" tabIndex={-1} className="fv-zone is-next" aria-label={rtl ? 'Previous page' : 'Next page'} onClick={() => turn(rtl ? -1 : 1)}><span>›</span></button>
        </>
      ) : (
        <div ref={scrollRef} className={`mg-scroll${strip ? ' is-strip' : ''}`} onScroll={placeFromScroll}>
          <div className="mg-column" style={{ width: colW, height }}>
            {colW > 0 && Array.from({ length: shownTo - shownFrom + 1 }, (_, k) => shownFrom + k).map((i) => (
              <div key={i} className="mg-pg" style={{ top: tops[i], height: heights[i] }}>{picture(i)}</div>
            ))}
            {colW > 0 && bands.size > 0 && Array.from({ length: shownTo - shownFrom + 1 }, (_, k) => shownFrom + k).flatMap((i) => bandsAt(i, tops[i]))}
            {colW > 0 && shownTo === total - 1 && bandsAt(total, tops[total - 1] + heights[total - 1] + (bands.get(total)?.length ?? 0) * BAND)}
          </div>
        </div>
      )}
    </div>
  );
});
