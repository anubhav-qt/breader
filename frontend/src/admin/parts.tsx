import type { CSSProperties, ReactNode } from 'react';
import { colorKeyFor } from '../data/colors';
import { toneOf } from './format';
import type { PartState } from './types';

/* The pieces the admin page is built from, in Breader's own look. */

const inkOf = (title: string) => `var(--bc-${colorKeyFor(title)}-ink)`;

/** The small grey uppercase label over a section, as in the voice sheet. */
export function Label({ children, side }: { children: ReactNode; side?: ReactNode }) {
  return (
    <span className="adm-label">
      <span>{children}</span>
      {side}
    </span>
  );
}

/**
 * A meter in square dots, like a book's progress: `of` dots, the first `on` of them filled. `tone`
 * fills them in a colour; `bad` in red.
 */
export function Dots({ on, of, tone, bad = false, label }: { on: number; of: number; tone?: string; bad?: boolean; label?: string }) {
  const lit = Math.round(Math.max(0, Math.min(of, on)));
  const style = tone ? ({ '--adm-dot': tone } as CSSProperties) : undefined;
  return (
    <span className={`adm-dots${bad ? ' is-bad' : ''}`} style={style} role="meter" aria-valuemin={0} aria-valuemax={of} aria-valuenow={lit} aria-label={label}>
      {Array.from({ length: of }, (_, i) => <i key={i} className={i < lit ? 'is-on' : undefined} />)}
    </span>
  );
}

/** A meter out of a hundred, in twenty dots. */
export function Percent({ value, bad = false, tone, label }: { value: number; bad?: boolean; tone?: string; label?: string }) {
  return <Dots on={(value / 100) * 20} of={20} bad={bad} tone={tone} label={label} />;
}

/** A book's parts as dots: done, being done, done by the backup model, or still to do. */
export function PartDots({ parts, tone }: { parts: PartState[]; tone: string }) {
  return (
    <span className="adm-parts" style={{ '--adm-dot': tone } as CSSProperties} aria-label={`${parts.filter((p) => p !== 'wait' && p !== 'now').length} of ${parts.length} parts done`}>
      {parts.map((p, i) => <i key={i} className={`is-${p}`} title={`Part ${i + 1}`} />)}
    </span>
  );
}

/** A book as a small cover: its first letter in Doto, on its colour. */
export function Monogram({ title, size = 'm' }: { title: string; size?: 's' | 'm' }) {
  const letter = title.replace(/^[^\p{L}\p{N}]+/u, '').charAt(0).toUpperCase();
  return (
    <span className={`adm-mono is-${size}`} style={{ background: toneOf(title), color: inkOf(title) }} aria-hidden="true">
      {letter}
    </span>
  );
}

/** Pill buttons in a row, one of them picked, like Personal and Shared. */
export function Seg<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: Array<{ v: T; label: ReactNode }>;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="adm-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.v} type="button" role="radio" aria-checked={value === o.v} onClick={() => onChange(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A number to step up or down, between `min` and `max`. */
export function Stepper({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange: (n: number) => void; label: string }) {
  return (
    <span className="adm-step" role="group" aria-label={label}>
      <button type="button" onClick={() => onChange(value - 1)} disabled={value <= min} aria-label={`Fewer: ${label}`}>−</button>
      <b>{value}</b>
      <button type="button" onClick={() => onChange(value + 1)} disabled={value >= max} aria-label={`More: ${label}`}>+</button>
    </span>
  );
}

/** An on or off switch, the library's own. */
export function Switch({ on, onChange, label, disabled = false }: { on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" className="switch" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)} />;
}
