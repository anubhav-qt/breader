import { useLayoutEffect, useRef } from 'react';
import './theme-toggle.css';

const rad = (a: number) => (a * Math.PI) / 180;

/** A circle's arc from one angle to another as cubic curves: each curve's two handles and its end. */
function arc(cx: number, cy: number, r: number, from: number, to: number, parts: number): number[][] {
  const pts: number[][] = [];
  const step = (to - from) / parts;
  const k = (4 / 3) * Math.tan(rad(step) / 4);
  for (let i = 0; i < parts; i++) {
    const a = rad(from + step * i), b = rad(from + step * (i + 1));
    pts.push(
      [cx + r * (Math.cos(a) - k * Math.sin(a)), cy + r * (Math.sin(a) + k * Math.cos(a))],
      [cx + r * (Math.cos(b) + k * Math.sin(b)), cy + r * (Math.sin(b) - k * Math.cos(b))],
      [cx + r * Math.cos(b), cy + r * Math.sin(b)],
    );
  }
  return pts;
}

/*
 * The sun's ring and the moon's crescent as the same five curves: three round the outside, two back
 * across. In the sun both go round one small circle; in the moon the two come back along a second
 * circle (r 7 round 17,7) that bites the first (r 8.5), so the ring grows and its upper right caves
 * in. The tips are where those two circles meet.
 */
const TIP = 262.5, END = 7.5;
const SUN = [[12 + 4.25 * Math.cos(rad(TIP)), 12 + 4.25 * Math.sin(rad(TIP))], ...arc(12, 12, 4.25, TIP, END, 3), ...arc(12, 12, 4.25, END + 360, TIP, 2)];
const MOON = [[12 + 8.5 * Math.cos(rad(TIP)), 12 + 8.5 * Math.sin(rad(TIP))], ...arc(12, 12, 8.5, TIP, END, 3), ...arc(17, 7, 7, 60.7, 209.3, 2)];

/** The shape part way from sun (0) to moon (1). */
function shape(t: number): string {
  const p = SUN.map((s, i) => s.map((v, j) => Math.round((v + (MOON[i][j] - v) * t) * 100) / 100));
  let d = `M${p[0][0]} ${p[0][1]}`;
  for (let i = 1; i < p.length; i += 3) d += `C${p[i]} ${p[i + 1]} ${p[i + 2]}`;
  return `${d}Z`;
}

const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
/** Sun to moon, or back. */
const LONG = 480;

interface Props {
  /** The page is dark, whether picked here or by the device. */
  dark: boolean;
  onToggle: () => void;
}

/**
 * Light or dark: a sun while light, a moon while dark. Between them the rays spin in and the ring
 * swells into a crescent, or the crescent fills back out and the rays spring back. The shape is moved
 * from script, since Safari can't animate a path's shape in CSS; a tap mid-way turns it round from
 * where it is.
 */
export function ThemeToggle({ dark, onToggle }: Props) {
  const path = useRef<SVGPathElement>(null);
  /** Where the shape is: 0 the sun, 1 the moon. */
  const at = useRef<number | null>(null);

  // Drawn only from here, so a render never jumps the shape to where it's headed.
  useLayoutEffect(() => {
    const el = path.current;
    if (!el) return;
    const to = dark ? 1 : 0;
    const from = at.current;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (from === null || from === to || still) {
      at.current = to;
      el.setAttribute('d', shape(to));
      return;
    }
    const long = LONG * Math.abs(to - from);
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const x = Math.min(1, (now - start) / long);
      at.current = from + (to - from) * ease(x);
      el.setAttribute('d', shape(at.current));
      if (x < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [dark]);

  const label = dark ? 'Light mode' : 'Dark mode';
  return (
    <button type="button" className={`btn btn-ghost hdr-icon theme-toggle${dark ? ' is-dark' : ''}`} onClick={onToggle} aria-label={label} title={label}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path ref={path} />
        <path className="theme-rays" d="M12 2.5v1.75M12 19.75v1.75M2.5 12h1.75M19.75 12h1.75M5.28 5.28l1.24 1.24M17.48 17.48l1.24 1.24M5.28 18.72l1.24-1.24M17.48 6.52l1.24-1.24" />
      </svg>
    </button>
  );
}
