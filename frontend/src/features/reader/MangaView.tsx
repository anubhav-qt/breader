import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent, type TouchEvent } from 'react';
import { flushSync } from 'react-dom';
import { WORDS_PER_MANGA_PAGE } from '../../books/manga';
import type { MangaBook, Position, RemoteChapter } from '../../books/types';
import { glide } from '../../lib/glide';
import { BAR, type Loc, type Start, type TurnEvent, type ViewHandle } from './FlowView';
import { frameAt, framesFor } from './frames';
import { MangaZoom, type Look } from './MangaZoom';
import type { Layout, MangaDir } from './settings';
import { runTurn } from './turn';

/*
 * A manga's pages. Scrolled, they're a column read downwards, with no gaps between them, each
 * drawn a few screens before it's reached. In pages, they turn one at a time, or two side by side as the book prints them once the
 * screen is wide enough, right to left as manga is read (or left to right, as comics are). A page's
 * picture comes out of the file as it nears the screen, and is let go once it's well behind.
 * A series read from MangaDex is its chapters one after another: scrolled, each starts under a line
 * crediting who made it, and in pages, a chapter starts on a page of its own. One opened a few
 * chapters at a time opens the next few as the reader nears the end of these.
 *
 * A click on a panel brings it (and any drawn together with it) to the middle of the screen; three
 * clicks or a long press, just the one panel. Two clicks bring the page closer around them. On a
 * touch screen a tap is the reader's, for the controls, so it's two taps that bring the panels
 * closer (or the page, off a panel), and three the one panel.
 */

interface Props {
  book: MangaBook;
  layout: Layout;
  dir: MangaDir;
  /** Scrolled: the column at its widest. */
  width: number;
  start: Start;
  onLocation: (l: Loc) => void;
  onWidth: (w: number) => void;
  onTurn?: (e: TurnEvent) => void;
  /** A tap on a page that isn't on a panel. */
  onTap?: () => void;
  /** The book with more chapters open (MangaBook.more). */
  onGrow?: (book: MangaBook) => void;
}

/** A page's height over its width, until its file says: a manga volume's usual shape. */
const RATIO = 1.42;
/** Wider than this is a spread drawn across two pages, so it shows on its own. */
const WIDE = 0.9;
/** Taller than this, typically, is a webtoon's long strip, never shown two side by side. */
const STRIP = 1.9;
/** Scrolled: the screens above and below the one shown whose pages are drawn, ready to scroll onto. */
const BEHIND = 1.5;
const AHEAD = 4;
/** Scrolled: room above the first page and below the last, clear of the lines of controls. */
const HEAD = BAR + 12;
const TAIL = BAR + 24;
/** Page sizes read from the file at a time. */
const BATCH = 24;
/** Pages kept open past those wanted, so going back a little doesn't open them again. */
const SPARE = 6;
/** Scrolled: the line before each chapter of a series read from MangaDex. */
const BAND = 56;
/** Taps this close in time count together, as a double or triple tap. */
const TAPS = 280;
/** A press held this long is a long press. */
const LONG = 450;
/** Scrolled: the page at rest once it's gone this long without moving. */
const REST = 200;
/** Scrolled: while it moves, the place is said at most this often, as each time it's saved, through the whole app. */
const PLACE_EVERY = 1000;

/** A series opened a few chapters at a time opens again at a chapter outside them (App.tsx). */
const reopen = (pos: Position) => window.dispatchEvent(new CustomEvent('breader:reopen', { detail: { pos } }));

/** The space beside the pages: on a phone, none, as every bit of the screen is better spent on the page. */
const sideOf = (w: number) => (w < 640 ? 0 : 48);
const wait = (ms: number) => new Promise<null>((done) => window.setTimeout(() => done(null), ms));

/** Where a picture is drawn inside its box, which can be a little off its shape until the picture says. */
function drawnOf(img: HTMLImageElement): DOMRect {
  const r = img.getBoundingClientRect();
  const shape = img.naturalHeight / img.naturalWidth;
  if (shape > r.height / r.width) {
    const w = r.height / shape;
    return new DOMRect(r.left + (r.width - w) / 2, r.top, w, r.height);
  }
  const h = r.width * shape;
  return new DOMRect(r.left, r.top + (r.height - h) / 2, r.width, h);
}

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
  /** Each picture drawn once off screen, and held, so a page scrolled onto shows at once, never blank while it's drawn. */
  private drawn = new Map<number, HTMLImageElement>();
  /** The book the pictures come from: more chapters added at its end keep its pages where they are. */
  book: MangaBook;
  constructor(book: MangaBook) {
    this.book = book;
  }

  /** Page i's height over its width, once its picture is open; 0 until then. */
  shape(i: number): number {
    const img = this.drawn.get(i);
    return img?.naturalWidth ? img.naturalHeight / img.naturalWidth : 0;
  }

  /** Page i's picture, or null when it won't open. */
  get(i: number): Promise<string | null> {
    let u = this.urls.get(i);
    if (!u) {
      u = this.book.page(i).then(
        async (b) => {
          const url = URL.createObjectURL(b);
          const img = new Image();
          img.src = url;
          this.drawn.set(i, img);
          // A browser drawing nothing (a tab out of sight) never says it's drawn: shown anyway, soon.
          await Promise.race([img.decode().catch(() => {}), wait(1500)]);
          return url;
        },
        () => null,
      );
      this.urls.set(i, u);
    }
    return u;
  }

  /** Page i's picture asked for again, after it wouldn't open. */
  retry(i: number): Promise<string | null> {
    this.urls.delete(i);
    return this.get(i);
  }

  /** Lets go of every page outside from to to. */
  keep(from: number, to: number) {
    for (const [i, u] of this.urls) {
      if (i >= from && i <= to) continue;
      this.urls.delete(i);
      this.drawn.delete(i);
      void u.then((url) => { if (url) URL.revokeObjectURL(url); });
    }
  }
}

/** A chapter by its number and the series' last, "Ch. 42 of 290", or by its name when it has no number. */
function chapterOf(ch: RemoteChapter, all: RemoteChapter[]): string {
  if (ch.number === null) return ch.label;
  let last = ch.number;
  for (const c of all) {
    if (c.number !== null && c.number > last) last = c.number;
  }
  return `${ch.label} of ${last}`;
}

export const MangaView = forwardRef<ViewHandle, Props>(function MangaView({ book, layout, dir, width, start, onLocation, onWidth, onTurn, onTap, onGrow }, ref) {
  const total = book.pages;
  // A series opened a few chapters at a time counts the words of all of it, not those open.
  const per = WORDS_PER_MANGA_PAGE;
  const rtl = dir === 'rtl';
  const [at, setAt] = useState<At>(() => startAt(start, total, book));
  const [size, setSize] = useState({ w: 0, h: 0 });
  /** Each page's height over its width, 0 until known. */
  const [ratios, setRatios] = useState<number[]>(() => new Array<number>(total).fill(0));
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const onLocationRef = useRef(onLocation);
  onLocationRef.current = onLocation;
  /**
   * Scrolled: the exact place at the top of the screen, kept as pages above it change size: how far
   * down its page, and once scrolled there, where its page started then, how many pixels down it
   * (past its end, in the line before the next chapter), how tall it was and whether that was known.
   */
  const anchor = useRef<{ page: number; frac: number; top?: number; into?: number; h?: number; sized?: boolean }>({ page: at.page, frac: at.frac });
  /** Scrolled: the page is moving, or still gliding from a flick, and a finger's on it. */
  const moving = useRef(false);
  const touching = useRef(false);
  const restTimer = useRef(0);
  /** Scrolled: the place to say next, and when it was said last. */
  const place = useRef<At>(at);
  const placedAt = useRef(0);
  /** Scrolled: shapes found for pages above the screen while it moved, taken once it rests. */
  const later = useRef(new Map<number, { r: number; guess: boolean }>());
  /** Pages: the page a turn is on its way to, so turns pressed quickly follow on from it. */
  const goal = useRef<number | null>(null);
  useEffect(() => () => window.clearTimeout(restTimer.current), []);

  /**
   * Pages found to be a shape (height over width), from their pictures, or as a `guess` from their
   * files' first bytes, which doesn't replace one known. Scrolled, a page above the screen keeps
   * the shape it has while the page moves, and takes this once it rests: the pages under the
   * reader's finger would jump, or, put back where they were, stop their flick dead.
   */
  const shaped = useCallback((found: Array<[number, number]>, guess = false) => {
    const now = found.filter(([i, r]) => {
      if (!r || !Number.isFinite(r)) return false;
      if (!(moving.current || touching.current) || i >= anchor.current.page) return true;
      const held = later.current.get(i);
      if (!(guess && held && !held.guess)) later.current.set(i, { r, guess });
      return false;
    });
    if (!now.length) return;
    setRatios((rs) => {
      let next = rs;
      for (const [i, r] of now) {
        if (guess ? rs[i] : Math.abs((rs[i] || 0) - r) < 0.005) continue;
        if (next === rs) next = rs.slice();
        next[i] = r;
      }
      return next;
    });
  }, []);

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
    // More chapters open: their pages, unknown as yet.
    setRatios((rs) => (rs.length >= total ? rs : [...rs, ...new Array<number>(total - rs.length).fill(0)]));
    const near = Array.from({ length: 14 }, (_, k) => at.page - 2 + k).filter((i) => i >= 0 && i < total);
    const order = [...near, ...Array.from({ length: total }, (_, i) => i).filter((i) => !near.includes(i))];
    void (async () => {
      for (let k = 0; k < order.length && live; k += BATCH) {
        const chunk = order.slice(k, k + BATCH);
        const sizes = await Promise.all(chunk.map((i) => book.size(i).catch(() => null)));
        if (!live) return;
        // A series read from MangaDex says nothing here: its pictures tell their sizes as they come.
        // A size from the picture itself, once it's shown, is surer: it's kept.
        shaped(chunk.flatMap((i, j): Array<[number, number]> => {
          const s = sizes[j];
          return s ? [[i, s.h / s.w]] : [];
        }), true);
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, total]);

  /** The picture as shown can disagree with its file's header (a photo turned by its camera's note). */
  const measured = (i: number, img: HTMLImageElement) => shaped([[i, img.naturalHeight / img.naturalWidth]]);

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
    for (const c of book.remote?.chapters ?? []) if (!c.away) m.set(c.first, [...(m.get(c.first) ?? []), c]);
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
  const colW = Math.min(width, areaW);
  // Opened a few chapters at a time, the way to the chapters before and after these.
  const prev = book.remote?.prev;
  const next = book.remote?.next;
  const { tops, heights, height } = useMemo(() => {
    const tops: number[] = [];
    const heights: number[] = [];
    let y = HEAD + (prev ? BAND : 0);
    for (let i = 0; i < total; i++) {
      y += (bands.get(i)?.length ?? 0) * BAND;
      tops.push(y);
      heights.push(Math.max(1, Math.round(colW * ratio(i))));
      y += heights[i];
    }
    return { tops, heights, height: y + ((bands.get(total)?.length ?? 0) + (next ? 1 : 0)) * BAND + TAIL };
  }, [ratio, total, colW, bands, prev, next]);

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
    anchor.current = { page: i, frac, top: tops[i], into: y - tops[i], h: heights[i], sized: !!ratios[i] };
    const end = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    // A tenth of a page at a time: close enough for the place kept, without a render a pixel.
    place.current = { page: i, frac: Math.floor(frac * 10) / 10, end };
    if (!moving.current || performance.now() - placedAt.current >= PLACE_EVERY) say();
    const from = pageAt(tops, el.scrollTop - BEHIND * el.clientHeight);
    const to = pageAt(tops, el.scrollTop + AHEAD * el.clientHeight);
    setWin((w) => (w[0] === from && w[1] === to ? w : [from, to]));
  };
  /** Says the place: in the controls, and kept. */
  const say = () => {
    placedAt.current = performance.now();
    const p = place.current;
    setAt((a) => (a.page === p.page && a.frac === p.frac && a.end === p.end ? a : p));
  };
  /** At rest, unless a finger's still on the page: the shapes found meanwhile are taken, and the place said. */
  const rest = () => {
    if (touching.current) return;
    moving.current = false;
    const held = [...later.current];
    later.current.clear();
    shaped(held.flatMap(([i, h]): Array<[number, number]> => (h.guess ? [] : [[i, h.r]])));
    shaped(held.flatMap(([i, h]): Array<[number, number]> => (h.guess ? [[i, h.r]] : [])), true);
    say();
  };
  const restSoon = () => {
    window.clearTimeout(restTimer.current);
    restTimer.current = window.setTimeout(rest, REST);
  };
  const onScroll = () => {
    moving.current = true;
    restSoon();
    placeFromScroll();
  };
  const onTouchStart = () => { touching.current = true; };
  const onTouchEnd = (e: TouchEvent) => {
    if (e.touches.length) return;
    touching.current = false;
    restSoon();
  };

  // Scrolled: the place stays put as the column is laid out again (sizes found, a new width).
  const laidW = useRef(0);
  const laidIn = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (layout !== 'scroll' || !el || colW <= 0) return;
    const a = anchor.current;
    const same = laidW.current === colW;
    laidW.current = colW;
    // A new width resizes every page alike, so the place goes by how far down its page it was, as it
    // does on a page whose size was a guess while it's still (pixels down it meant nothing once it's
    // known). Otherwise a page finding its size only moves the pages after it: the place stays as
    // many pixels down its page.
    let into = a.frac * heights[a.page];
    if (a.into !== undefined && a.h) {
      if (same && (a.sized || moving.current || touching.current)) into = a.into;
      else into = a.into <= a.h ? (a.into / a.h) * heights[a.page] : heights[a.page] + a.into - a.h;
    }
    // Opened at a place, or gone to one: there. Otherwise moved as far as the place moved down the
    // column, from wherever it's been scrolled to since.
    let to = tops[a.page] + into - BAR;
    if (laidIn.current === el && a.top !== undefined && a.into !== undefined) to = el.scrollTop + tops[a.page] + into - (a.top + a.into);
    laidIn.current = el;
    to = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, Math.round(to)));
    // On a phone, the place written again, even the same one, stops a flick of the finger dead: it's
    // written only when it moved, as pages coming in below as they're read never move it.
    if (Math.abs(el.scrollTop - to) >= 1) el.scrollTop = to;
    placeFromScroll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, tops, heights, colW]);

  // Pictures: those to show, and the next few, opened ahead.
  const [pics] = useState(() => new Pictures(book));
  useLayoutEffect(() => { pics.book = book; }, [pics, book]);
  useEffect(() => () => pics.keep(1, 0), [pics]);
  const [srcs, setSrcs] = useState<ReadonlyMap<number, string | null>>(() => new Map());
  const s = spreadAt[Math.min(total - 1, at.page)];
  const [wantFrom, wantTo] = layout === 'pages'
    ? [spreads[Math.max(0, s - 1)]?.[0] ?? 0, spreads[Math.min(spreads.length - 1, s + 2)]?.slice(-1)[0] ?? total - 1]
    : [win[0], win[1] + 4];
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
        if (!live) return;
        // Its shape with it, so it's never shown in a box of the wrong one.
        shaped([[i, pics.shape(i)]]);
        setSrcs((m) => (m.get(i) === url ? m : new Map(m).set(i, url)));
      });
    }
    return () => { live = false; };
  }, [pics, wantFrom, wantTo, total, shaped]);

  useEffect(() => {
    const shown = layout === 'pages' ? spread : [at.page];
    const first = shown[0];
    const last = shown[shown.length - 1];
    const end = layout === 'pages' ? last >= total - 1 : at.end;
    const exact = layout === 'scroll' ? at.page + at.frac : first;
    // Of a series opened a few chapters at a time, how far through all of it.
    const progress = book.progressOf ? book.progressOf(exact, end) : end ? 1 : exact / total;
    const nextAt = book.toc.find((t) => t.section > first && !t.reopen)?.section ?? total;
    // A series' place goes by its chapter: page 5 of the series means little.
    const ch = book.remote?.chapters.filter((c) => c.pages > 0 && c.first <= first).pop();
    onLocationRef.current({
      section: first,
      block: book.anchor?.(first) ?? 0,
      offset: layout === 'scroll' ? Math.round(at.frac * 1000) : 0,
      progress,
      sectionWordsLeft: Math.round(Math.max(1, nextAt - exact) * per),
      bookWordsLeft: book.progressOf ? Math.round((1 - progress) * book.words) : end ? 0 : Math.round((total - (layout === 'pages' ? last + 1 : exact)) * per),
      line: ch ? `${chapterOf(ch, book.remote!.chapters)}, page ${first - ch.first + 1} of ${ch.pages}` : `Page ${first + 1} of ${total}`,
      page: first,
      pages: total,
      screen: Math.round(shown.length * per),
    });
    // The spread is new each time pages change shape; its first and last pages are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, layout, spread[0], spread[spread.length - 1], total, per, book]);

  // Opened a few chapters at a time: nearing the last of them, the next few open, and the pages carry
  // on past these as though they'd been there all along. Once a book: if they won't open, its last
  // line still opens the book again at the next chapter.
  const grown = useRef<MangaBook | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!book.more || !onGrow || grown.current === book) return;
    const open = book.remote?.chapters.filter((c) => c.pages > 0) ?? [];
    const near = open[Math.max(0, open.length - 2)];
    if (!near || at.page < near.first) return;
    grown.current = book;
    book.more().then(
      (more) => { if (more && mounted.current) onGrow(more); },
      () => {},
    );
  }, [at.page, book, onGrow]);

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

  /** A page that wouldn't open, asked for again. */
  const retry = (i: number) => {
    setSrcs((m) => {
      const next = new Map(m);
      next.delete(i);
      return next;
    });
    void pics.retry(i).then((url) => setSrcs((m) => new Map(m).set(i, url)));
  };

  const picture = (i: number) => {
    const src = srcs.get(i);
    if (src === undefined) return null;
    if (src === null) {
      return (
        <span className="mg-broken">
          Page {i + 1} won’t open
          <button type="button" onClick={(e) => { e.stopPropagation(); retry(i); }}>Try again</button>
        </span>
      );
    }
    return <img src={src} alt={`Page ${i + 1}`} draggable={false} decoding="async" onLoad={(e) => measured(i, e.currentTarget)} />;
  };

  // A page looked at closely (MangaZoom.tsx).
  const [look, setLook] = useState<Look | null>(null);

  /** Brings a page closer: the panels drawn together at a point on its picture, the one panel there, or the page around it. False when there's no panel there. */
  const zoom = (img: HTMLImageElement, cx: number, cy: number, what: 'group' | 'panel' | 'page'): boolean => {
    // Turned away from while the taps were counted.
    if (!img.isConnected || !img.naturalWidth) return false;
    const from = drawnOf(img);
    if (from.width <= 0 || from.height <= 0) return false;
    const x = (cx - from.left) / from.width;
    const y = (cy - from.top) / from.height;
    let box = null;
    if (what !== 'page') {
      const hit = frameAt(framesFor(img), x, y);
      if (!hit) return false;
      box = hit.panel;
      if (what === 'group') box = hit.group;
    }
    setLook({ src: img.currentSrc || img.src, natural: img.naturalWidth, from, box, x, y });
    return true;
  };

  /**
   * What clicks on a picture do, once they stop coming: one, the panels there; two, the page; three,
   * the one panel. Tapped, one is the reader's (the controls, in full screen); two, the panels there,
   * or the page off a panel; three, the one panel.
   */
  const tapped = (n: number, img: HTMLImageElement, x: number, y: number, touch: boolean) => {
    if (n === 1) {
      if (touch || !zoom(img, x, y, 'group')) onTap?.();
      return;
    }
    if (n === 2) {
      if (!touch || !zoom(img, x, y, 'group')) zoom(img, x, y, 'page');
      return;
    }
    if (!zoom(img, x, y, 'panel')) zoom(img, x, y, 'page');
  };

  /** Taps on a picture, counted until they stop coming, and a press held on one. */
  const taps = useRef<{ n: number; img: HTMLImageElement; x: number; y: number; touch: boolean; timer: number } | null>(null);
  const press = useRef<{ id: number; img: HTMLImageElement; x: number; y: number; timer: number; long: boolean } | null>(null);
  const touch = useRef(false);
  useEffect(() => () => {
    window.clearTimeout(taps.current?.timer);
    window.clearTimeout(press.current?.timer);
  }, []);
  const pictureAt = (t: EventTarget): HTMLImageElement | null => {
    if (t instanceof HTMLImageElement && t.closest('.mg-pg')) return t;
    return null;
  };
  const onPagesDown = (e: PointerEvent) => {
    touch.current = e.pointerType === 'touch';
    const img = pictureAt(e.target);
    // A touch that stops the page gliding from a flick is just that.
    if (!img || e.button !== 0 || !e.isPrimary || moving.current) return;
    const p = { id: e.pointerId, img, x: e.clientX, y: e.clientY, timer: 0, long: false };
    p.timer = window.setTimeout(() => {
      p.long = true;
      window.clearTimeout(taps.current?.timer);
      taps.current = null;
      zoom(img, p.x, p.y, 'panel');
    }, LONG);
    press.current = p;
  };
  // Moved: a scroll or a swipe, not a tap.
  const onPagesMove = (e: PointerEvent) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) <= 10) return;
    window.clearTimeout(p.timer);
    press.current = null;
  };
  const onPagesUp = (e: PointerEvent) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    press.current = null;
    window.clearTimeout(p.timer);
    if (p.long) return;
    let t = taps.current;
    if (t && Math.hypot(p.x - t.x, p.y - t.y) < 40) {
      window.clearTimeout(t.timer);
      t.n++;
    } else {
      window.clearTimeout(t?.timer);
      t = { n: 1, img: p.img, x: p.x, y: p.y, touch: touch.current, timer: 0 };
      taps.current = t;
    }
    const done = t;
    // Three is as many as count: no need to wait for a fourth.
    if (done.n >= 3) {
      taps.current = null;
      tapped(done.n, done.img, done.x, done.y, done.touch);
      return;
    }
    done.timer = window.setTimeout(() => {
      taps.current = null;
      tapped(done.n, done.img, done.x, done.y, done.touch);
    }, TAPS);
  };
  const onPagesCancel = () => {
    window.clearTimeout(press.current?.timer);
    press.current = null;
  };
  // A tap on a picture is the page's, not the reader's (Reader.tsx), and a picture held shows no menu.
  const onPagesClick = (e: MouseEvent) => { if (pictureAt(e.target)) e.preventDefault(); };
  const onPagesMenu = (e: MouseEvent) => { if (touch.current && pictureAt(e.target)) e.preventDefault(); };
  const pageTaps = {
    onPointerDown: onPagesDown,
    onPointerMove: onPagesMove,
    onPointerUp: onPagesUp,
    onPointerCancel: onPagesCancel,
    onClick: onPagesClick,
    onContextMenu: onPagesMenu,
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
          <div className="mg-pages" {...pageTaps}>
            {paired && size.w > 0 && (
              <div className={`mg-spread${rtl ? ' is-rtl' : ''}`}>
                {fit(spread).map(({ i, w, h }) => (
                  <div key={i} className={`mg-pg${ratios[i] ? ' is-sized' : ''}`} style={{ width: w, height: h }}>{picture(i)}</div>
                ))}
              </div>
            )}
          </div>
          {next && spread[spread.length - 1] >= total - 1 && (
            <button type="button" className="mg-more" onClick={(e) => { e.stopPropagation(); reopen(next.at); }}>Carry on to {next.label} ›</button>
          )}
          {prev && spread[0] === 0 && !(next && spread[spread.length - 1] >= total - 1) && (
            <button type="button" className="mg-more" onClick={(e) => { e.stopPropagation(); reopen(prev.at); }}>‹ Back to {prev.label}</button>
          )}
          {/* Right to left, the left side goes on. */}
          <button type="button" tabIndex={-1} className="fv-zone is-prev" aria-label={rtl ? 'Next page' : 'Previous page'} onClick={() => turn(rtl ? 1 : -1)}><span>‹</span></button>
          <button type="button" tabIndex={-1} className="fv-zone is-next" aria-label={rtl ? 'Previous page' : 'Next page'} onClick={() => turn(rtl ? -1 : 1)}><span>›</span></button>
        </>
      ) : (
        <div ref={scrollRef} className="mg-scroll" onScroll={onScroll} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd} onTouchCancel={onTouchEnd}>
          <div className="mg-column" style={{ width: colW, height }} {...pageTaps}>
            {colW > 0 && Array.from({ length: shownTo - shownFrom + 1 }, (_, k) => shownFrom + k).map((i) => (
              <div key={i} className={`mg-pg${ratios[i] ? ' is-sized' : ''}`} style={{ top: tops[i], height: heights[i] }}>{picture(i)}</div>
            ))}
            {colW > 0 && bands.size > 0 && Array.from({ length: shownTo - shownFrom + 1 }, (_, k) => shownFrom + k).flatMap((i) => bandsAt(i, tops[i]))}
            {colW > 0 && shownTo === total - 1 && bandsAt(total, tops[total - 1] + heights[total - 1] + (bands.get(total)?.length ?? 0) * BAND)}
            {colW > 0 && prev && shownFrom === 0 && (
              <div className="mg-band is-more" style={{ top: tops[0] - (bands.get(0)?.length ?? 0) * BAND - BAND, height: BAND }}>
                <button type="button" onClick={(e) => { e.stopPropagation(); reopen(prev.at); }}>‹ Back to {prev.label}</button>
              </div>
            )}
            {colW > 0 && next && shownTo === total - 1 && (
              <div className="mg-band is-more" style={{ top: tops[total - 1] + heights[total - 1] + (bands.get(total)?.length ?? 0) * BAND, height: BAND }}>
                <button type="button" onClick={(e) => { e.stopPropagation(); reopen(next.at); }}>Carry on to {next.label} ›</button>
              </div>
            )}
          </div>
        </div>
      )}
      {look && <MangaZoom look={look} onClose={() => setLook(null)} />}
    </div>
  );
});
