import { animate, motion, useMotionValue, type MotionValue } from 'motion/react';
import { useEffect, useRef, useState, type PointerEvent, type SyntheticEvent } from 'react';
import type { Box } from './frames';

/*
 * A page looked at closely, over everything else. A panel (or panels drawn together) grows from where
 * it is on the page to fill the middle of the screen, the rest of the page fading away, and a tap
 * puts it back. From there ‹ and › (the arrow keys, or a swipe) go on to the panel read next, the
 * page gliding across to it, and past the page's last panel, on to the next page's first. A page
 * tapped twice comes closer around the tap instead, to be dragged about, and twice again puts it back.
 */

export interface Look {
  /** The page's picture. */
  src: string;
  /** Its widest, in pixels: no closer than a few screen pixels to each of them. */
  natural: number;
  /** Where the picture is drawn on the screen. */
  from: DOMRect;
  /** Where on the page, in fractions of it: the part to fit the screen, or else the point to come closer around. */
  box: Box | null;
  x: number;
  y: number;
  /** The page it's of. */
  page: number;
  /** Read a step at a time (steps.ts): the page's steps in the order they're read, and which of them show. */
  steps?: Box[];
  shown?: { from: number; to: number };
  /** Come on from the page before or after, as the page turned: it's where it goes from the start. */
  here?: boolean;
}

interface Props {
  look: Look;
  /** Steps go right to left, so ‹ goes on. */
  rtl: boolean;
  onClose: () => void;
  /** Past the page's first step or its last: on to the page before or after. */
  onBeyond?: (d: 1 | -1) => void;
  /** Where the page is drawn as it's put back, which may move to show the part last looked at. */
  backTo?: (box: Box | null) => DOMRect | null;
}

/** A double tap brings the page this much closer. */
const CLOSER = 2.5;
/** At most this many screen pixels to each of the picture's. */
const SHARPEST = 2.5;
/** A panel already this near its fitted size is looked at by coming closer instead. */
const GAIN = 1.15;
/** Two taps this close in time are a double tap. */
const TWICE = 300;
/** A swipe: this far sideways, more sideways than not, this quickly. */
const SWIPE = 40;
const SWIPE_MS = 800;
const EASE = [0.2, 0.9, 0.25, 1] as const;
/** Grown from the page and put back, and gliding from one panel to the next. */
const GROW = 0.3;
const GLIDE = 0.42;

const still = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const pct = (n: number) => `${(Math.max(0, n) * 100).toFixed(3)}%`;

/** The clip showing just a part of the page, a hair around it so its border shows. */
export function clipOf(b: Box | null): string {
  if (!b) return 'inset(0% 0% 0% 0%)';
  const hair = 0.004;
  return `inset(${pct(b.y - hair)} ${pct(1 - b.x - b.w - hair)} ${pct(1 - b.y - b.h - hair)} ${pct(b.x - hair)})`;
}

/** The room kept around a part fitted to a screen this wide. */
export const padOf = (vw: number) => (vw < 640 ? 12 : 32);

/** The widest a picture this many pixels wide is shown. */
export const widestOf = (natural: number) => natural * SHARPEST;

/**
 * Where a page goes so a part of it fits a screen (or an area) vw by vh, shown no wider than
 * `most`: its width there, and its top left corner.
 */
export function fitOf(box: Box, ratio: number, most: number, vw: number, vh: number): { s: number; left: number; top: number } {
  const pad = padOf(vw);
  const s = Math.min((vw - 2 * pad) / box.w, (vh - 2 * pad) / (box.h * ratio), most);
  const left = vw / 2 - s * (box.x + box.w / 2);
  const top = vh / 2 - s * ratio * (box.y + box.h / 2);
  return { s, left, top };
}

/** The widest the page is shown here: as sharp as its picture allows, and at least a little closer. */
const mostOf = (look: Look) => Math.max(look.from.width * GAIN, widestOf(look.natural));

/** Where the page goes first: its width on the screen, its top left corner, and the part of it shown. */
function placeOf(look: Look, vw: number, vh: number): { s: number; left: number; top: number; box: Box | null } {
  const { from, box } = look;
  const ratio = from.height / from.width;
  const most = mostOf(look);
  if (box) {
    const fit = fitOf(box, ratio, most, vw, vh);
    // A part read a step at a time is fitted however big it already is (a panel as wide as a phone
    // can't be shown wider), the rest of the page faded away; otherwise it's looked at closer.
    if (look.steps?.length || fit.s >= from.width * GAIN) return { ...fit, box };
  }
  // Closer around the point, which stays under the finger, as far as the page reaches.
  const s = Math.min(from.width * CLOSER, Math.max(most, from.width * GAIN));
  const px = from.left + look.x * from.width;
  const py = from.top + look.y * from.height;
  return { s, left: within(px - look.x * s, s, vw), top: within(py - look.y * s * ratio, s * ratio, vh), box: null };
}

/** A start along one side that keeps the page over the screen, or in its middle when it's smaller. */
function within(start: number, size: number, screen: number): number {
  if (size <= screen) return (screen - size) / 2;
  return Math.min(0, Math.max(screen - size, start));
}

/** Which way a key steps: on, back, or not at all. Right to left, the left arrow goes on. */
function stepOfKey(e: KeyboardEvent, rtl: boolean): 1 | -1 | 0 {
  if (e.key === 'ArrowRight') return rtl ? -1 : 1;
  if (e.key === 'ArrowLeft') return rtl ? 1 : -1;
  if (e.key === 'PageDown') return 1;
  if (e.key === 'PageUp') return -1;
  if (e.key === ' ') return e.shiftKey ? -1 : 1;
  return 0;
}

const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

export function MangaZoom({ look, rtl, onClose, onBeyond, backTo }: Props) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const ratio = look.from.height / look.from.width;
  const [first] = useState(() => placeOf(look, vw, vh));
  const steps = look.steps ?? [];
  const [fits] = useState(() => steps.map((b) => fitOf(b, ratio, mostOf(look), vw, vh)));
  // Laid out as wide as it's ever shown here, so it's only ever made smaller, and stays sharp.
  const [wide] = useState(() => Math.max(first.s, ...fits.map((f) => f.s)));
  const panning = first.box === null;
  const stepping = steps.length > 0 && !!look.shown;
  /** The steps showing now. */
  const shown = useRef(look.shown);

  /** The page drawn at `rect`, as moved and scaled here. */
  const drawnAt = (rect: DOMRect) => ({ x: rect.left, y: rect.top, scale: rect.width / wide });
  const placed = (p: { s: number; left: number; top: number }) => ({ x: p.left, y: p.top, scale: p.s / wide });

  // From the page as it's drawn to its place here: moved, scaled, and cut down to the part looked at.
  let start = drawnAt(look.from);
  if (look.here) start = placed(first);
  const x = useMotionValue(start.x);
  const y = useMotionValue(start.y);
  const scale = useMotionValue(start.scale);
  const clip = useMotionValue(clipOf(look.here ? first.box : null));
  const fade = useMotionValue(look.here ? 1 : 0);
  const leaving = useRef(false);

  const go = (to: { x: number; y: number; scale: number; clip: string; fade: number }, duration = GROW) => {
    const t = { duration: still() ? 0 : duration, ease: EASE };
    const pairs: Array<[MotionValue<number>, number]> = [[x, to.x], [y, to.y], [scale, to.scale], [fade, to.fade]];
    return Promise.all([...pairs.map(([v, n]) => animate(v, n, t)), animate(clip, to.clip, t)]);
  };

  const close = () => {
    if (leaving.current) return;
    leaving.current = true;
    let part = first.box;
    if (stepping && shown.current) part = steps[shown.current.from];
    const to = backTo?.(part) ?? look.from;
    void go({ ...drawnAt(to), clip: clipOf(null), fade: 0 }).then(onClose);
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  /** On to the next step (or back to the one before), gliding across the page; past its first or last, the page before or after. */
  const step = (d: 1 | -1) => {
    const now = shown.current;
    if (leaving.current || !now) return;
    let k = now.from - 1;
    if (d > 0) k = now.to + 1;
    if (k < 0 || k >= steps.length) {
      onBeyond?.(d);
      return;
    }
    shown.current = { from: k, to: k };
    void go({ ...placed(fits[k]), clip: clipOf(steps[k]), fade: 1 }, GLIDE);
  };
  const stepRef = useRef(step);
  stepRef.current = step;

  useEffect(() => {
    if (!look.here) void go({ ...placed(first), clip: clipOf(first.box), fade: 1 });
    // The arrows step from panel to panel; Escape puts the page back without leaving the book, and
    // any other key puts it back and goes on.
    const onKey = (e: KeyboardEvent) => {
      if (MODIFIERS.has(e.key)) return;
      const d = stepOfKey(e, rtl);
      if (d && stepping) {
        e.preventDefault();
        e.stopImmediatePropagation();
        stepRef.current(d);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      closeRef.current();
    };
    // Laid out for this screen: another size starts over.
    const onResize = () => onClose();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Dragging a page come closer, the swipes that step, and the taps that put it back. */
  const drag = useRef<{ id: number; px: number; py: number; x: number; y: number; t: number; moved: boolean } | null>(null);
  const lastTap = useRef(-Infinity);
  const onPointerDown = (e: PointerEvent) => {
    e.stopPropagation();
    if (leaving.current || drag.current) return;
    drag.current = { id: e.pointerId, px: e.clientX, py: e.clientY, x: x.get(), y: y.get(), t: e.timeStamp, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (Math.hypot(dx, dy) > 8) d.moved = true;
    if (!panning || !d.moved) return;
    const s = scale.get() * wide;
    x.set(within(d.x + dx, s, vw));
    y.set(within(d.y + dy, s * ratio, vh));
  };
  const onPointerUp = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (d.moved) {
      // A panel swiped sideways steps, the way a page turns: right to left, a swipe to the right goes on.
      const dx = e.clientX - d.px;
      const dy = e.clientY - d.py;
      const swiped = Math.abs(dx) >= SWIPE && Math.abs(dx) >= Math.abs(dy) * 1.4 && e.timeStamp - d.t <= SWIPE_MS;
      if (!panning && stepping && swiped) {
        let on = dx < 0;
        if (rtl) on = !on;
        step(on ? 1 : -1);
      }
      return;
    }
    // A panel goes back at a tap; a page come closer, at a double tap, so a tap while looking about doesn't.
    if (!panning) {
      close();
      return;
    }
    if (e.timeStamp - lastTap.current < TWICE) close();
    else lastTap.current = e.timeStamp;
  };
  const onPointerCancel = () => { drag.current = null; };
  // The reader underneath mustn't take these as its own taps, swipes or presses.
  const keep = (e: SyntheticEvent) => e.stopPropagation();
  const zone = (d: 1 | -1) => (e: SyntheticEvent) => {
    e.stopPropagation();
    step(d);
  };

  return (
    <div
      className={`mg-zoom${panning ? ' is-pan' : ''}`}
      role="dialog"
      aria-label={panning ? 'Page, closer' : 'Panel, closer'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); }}
      onTouchStart={keep}
      onTouchMove={keep}
      onTouchEnd={keep}
      onWheel={keep}
      onContextMenu={(e) => e.preventDefault()}
    >
      <motion.div className="mg-zoom-bg" style={{ opacity: fade }} />
      <motion.img
        src={look.src}
        alt=""
        draggable={false}
        style={{ left: 0, top: 0, width: wide, height: wide * ratio, x, y, scale, clipPath: clip }}
      />
      {stepping && (
        <>
          {/* Right to left, the left side goes on. */}
          <button type="button" tabIndex={-1} className="fv-zone is-prev" aria-label={rtl ? 'Next panel' : 'Previous panel'} onPointerDown={keep} onClick={zone(rtl ? 1 : -1)}><span>‹</span></button>
          <button type="button" tabIndex={-1} className="fv-zone is-next" aria-label={rtl ? 'Previous panel' : 'Next panel'} onPointerDown={keep} onClick={zone(rtl ? -1 : 1)}><span>›</span></button>
        </>
      )}
    </div>
  );
}
