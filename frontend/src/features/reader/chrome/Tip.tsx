import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { springs } from '../../../lib/springs';

/*
 * A line saying what something does, by the resting pointer: over a word while a voice reads
 * (SayAs.tsx), and over the buttons along the top (HeadTips). On a touch screen, the words' line
 * sits under the page instead, and the buttons have none.
 */

export interface Tip { id: number; x: number; y: number; touch: boolean; text: string }

/** How long the pointer rests before the tip, and how long the tip stays. */
export const REST_MS = 250;
export const TIP_MS = 3000;

const TIP_X = 12;
const TIP_Y = 22;
const EDGE = 12;

export function TipBox({ tip, area, className = '' }: { tip: Tip; area: RefObject<HTMLDivElement | null>; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Below and right of the pointer, flipped where that would leave the page.
  useLayoutEffect(() => {
    const el = ref.current;
    const a = area.current;
    if (!el || !a || tip.touch) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const flipX = tip.x + TIP_X + w > a.clientWidth - EDGE;
    const flipY = tip.y + TIP_Y + h > a.clientHeight - EDGE;
    setPos({
      left: flipX ? Math.max(EDGE, tip.x - TIP_X - w) : tip.x + TIP_X,
      top: flipY ? Math.max(EDGE, tip.y - 10 - h) : tip.y + TIP_Y,
    });
  }, [tip, area]);

  const placed = tip.touch || !!pos;
  return (
    <motion.div
      ref={ref}
      className={`sa-tip${tip.touch ? ' is-touch' : ''} ${className}`}
      role="status"
      style={tip.touch ? undefined : { left: pos?.left ?? -9999, top: pos?.top ?? 0 }}
      initial={{ opacity: 0, scale: 0.96 }}
      animate={placed ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.96 }}
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
      transition={springs.snappy}
    >
      {tip.text}
    </motion.div>
  );
}

/**
 * What each button along the top does, said by the resting mouse: anything in `bar` with a
 * `data-tip`. Once per stay on a button; moving to another, leaving or clicking puts it away.
 */
export function HeadTips({ bar, area }: { bar: RefObject<HTMLElement | null>; area: RefObject<HTMLDivElement | null> }) {
  const [tip, setTip] = useState<Tip | null>(null);
  useEffect(() => {
    const el = bar.current;
    const a = area.current;
    if (!el || !a) return;
    let rest = 0;
    let gone = 0;
    let n = 0;
    let on: { button: HTMLElement; told: boolean } | null = null;
    const hide = () => { window.clearTimeout(rest); window.clearTimeout(gone); setTip(null); };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      const button = (e.target as Element).closest<HTMLElement>('[data-tip]');
      if (!button) { on = null; hide(); return; }
      if (on?.button === button) {
        if (on.told) return;
      } else {
        on = { button, told: false };
        hide();
      }
      window.clearTimeout(rest);
      const box = a.getBoundingClientRect();
      const x = e.clientX - box.left;
      const y = e.clientY - box.top;
      const here = on;
      rest = window.setTimeout(() => {
        here.told = true;
        setTip({ id: ++n, x, y, touch: false, text: button.dataset.tip ?? '' });
        window.clearTimeout(gone);
        gone = window.setTimeout(() => setTip(null), TIP_MS);
      }, REST_MS);
    };
    const onLeave = () => { on = null; hide(); };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('pointerdown', hide);
    return () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('pointerdown', hide);
      hide();
    };
  }, [bar, area]);
  return <AnimatePresence>{tip && <TipBox key={tip.id} tip={tip} area={area} className="is-head" />}</AnimatePresence>;
}
