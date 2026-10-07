import { animate, motion, useMotionValue, type MotionValue } from 'motion/react';
import { useEffect, useRef, useState, type PointerEvent, type SyntheticEvent } from 'react';
import type { Box } from './frames';

/*
 * A page looked at closely, over everything else. A panel (or panels drawn together) grows from where
 * it is on the page to fill the middle of the screen, the rest of the page fading away, and a tap
 * puts it back. A page tapped twice comes closer around the tap instead, to be dragged about, and
 * twice again puts it back.
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
}

interface Props {
  look: Look;
  onClose: () => void;
}

/** A double tap brings the page this much closer. */
const CLOSER = 2.5;
/** At most this many screen pixels to each of the picture's. */
const SHARPEST = 2.5;
/** A panel already this near its fitted size is looked at by coming closer instead. */
const GAIN = 1.15;
/** Two taps this close in time are a double tap. */
const TWICE = 300;
const EASE = [0.2, 0.9, 0.25, 1] as const;

const still = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const pct = (n: number) => `${(Math.max(0, n) * 100).toFixed(3)}%`;

/** The clip showing just a part of the page, a hair around it so its border shows. */
function clipOf(b: Box | null): string {
  if (!b) return 'inset(0% 0% 0% 0%)';
  const hair = 0.004;
  return `inset(${pct(b.y - hair)} ${pct(1 - b.x - b.w - hair)} ${pct(1 - b.y - b.h - hair)} ${pct(b.x - hair)})`;
}

/** Where the page goes: its width on the screen, its top left corner, and the part of it shown. */
function placeOf(look: Look, vw: number, vh: number): { s: number; left: number; top: number; box: Box | null } {
  const { from, box } = look;
  const ratio = from.height / from.width;
  const most = Math.max(from.width * GAIN, look.natural * SHARPEST);
  if (box) {
    const pad = vw < 640 ? 12 : 32;
    const s = Math.min((vw - 2 * pad) / box.w, (vh - 2 * pad) / (box.h * ratio), most);
    if (s >= from.width * GAIN) {
      const left = vw / 2 - s * (box.x + box.w / 2);
      const top = vh / 2 - s * ratio * (box.y + box.h / 2);
      return { s, left, top, box };
    }
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

export function MangaZoom({ look, onClose }: Props) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const [{ s, left, top, box }] = useState(() => placeOf(look, vw, vh));
  const ratio = look.from.height / look.from.width;
  const panning = box === null;

  // From the page as it's drawn to its place here: moved, scaled, and cut down to the part looked at.
  const away = { x: look.from.left - left, y: look.from.top - top, scale: look.from.width / s };
  const x = useMotionValue(away.x);
  const y = useMotionValue(away.y);
  const scale = useMotionValue(away.scale);
  const clip = useMotionValue(clipOf(null));
  const fade = useMotionValue(0);
  const leaving = useRef(false);

  const go = (to: { x: number; y: number; scale: number; clip: string; fade: number }) => {
    const t = { duration: still() ? 0 : 0.3, ease: EASE };
    const pairs: Array<[MotionValue<number>, number]> = [[x, to.x], [y, to.y], [scale, to.scale], [fade, to.fade]];
    return Promise.all([...pairs.map(([v, n]) => animate(v, n, t)), animate(clip, to.clip, t)]);
  };

  const close = () => {
    if (leaving.current) return;
    leaving.current = true;
    void go({ ...away, clip: clipOf(null), fade: 0 }).then(onClose);
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    void go({ x: 0, y: 0, scale: 1, clip: clipOf(box), fade: 1 });
    // Escape puts the page back without leaving the book; any other key puts it back and goes on.
    const onKey = (e: KeyboardEvent) => {
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

  /** Dragging a page come closer, and the taps that put it back. */
  const drag = useRef<{ id: number; px: number; py: number; x: number; y: number; moved: boolean } | null>(null);
  const lastTap = useRef(-Infinity);
  const onPointerDown = (e: PointerEvent) => {
    e.stopPropagation();
    if (leaving.current || drag.current) return;
    drag.current = { id: e.pointerId, px: e.clientX, py: e.clientY, x: x.get(), y: y.get(), moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    if (Math.hypot(dx, dy) > 8) d.moved = true;
    if (!panning || !d.moved) return;
    x.set(within(left + d.x + dx, s, vw) - left);
    y.set(within(top + d.y + dy, s * ratio, vh) - top);
  };
  const onPointerUp = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (d.moved) return;
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
        style={{ left, top, width: s, height: s * ratio, x, y, scale, clipPath: clip }}
      />
    </div>
  );
}
