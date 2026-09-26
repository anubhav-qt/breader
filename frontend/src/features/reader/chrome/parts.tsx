import type { CSSProperties } from 'react';
import { motion } from 'motion/react';
import { duration, minutesFor } from '../../../lib/format';
import { springs } from '../../../lib/springs';
import { numbered, pad2, type Chapter } from '../chapters';

const DIGITS = '0123456789'.split('');

/** A number whose digits roll to their new value, like a mechanical counter. */
export function Digits({ value, width }: { value: number; width: number }) {
  const s = String(Math.max(0, Math.round(value))).padStart(width, '0');
  return (
    <span className="dg" aria-label={String(Math.round(value))}>
      {s.split('').map((d, i) => (
        <span key={s.length - i} className="dg-slot" aria-hidden="true">
          <motion.span className="dg-strip" initial={false} animate={{ y: `${-Number(d) * 10}%` }} transition={springs.snappy}>
            {DIGITS.map((n) => <span key={n}>{n}</span>)}
          </motion.span>
        </span>
      ))}
    </span>
  );
}

/** Text that types itself in, one character per step, whenever it changes. Needs a monospaced face. */
export function Typed({ text, className = '' }: { text: string; className?: string }) {
  return <span key={text} className={`typed ${className}`} style={{ '--n': Math.max(1, text.length) } as CSSProperties}>{text}</span>;
}

/** The hover label on a progress track: the chapter's number, title and length. */
export function ChapterLabel({ chapters, i, f }: { chapters: Chapter[]; i: number; f: number }) {
  if (chapters.length < 3) return <span className="lbl"><b>{Math.round(f * 100)}%</b></span>;
  const c = chapters[i];
  return (
    <span className="lbl">
      {!numbered(c.title) && <b>{pad2(i + 1)}</b>}
      <span className="lbl-t">{c.title}</span>
      <em>{duration(minutesFor(c.words))}</em>
    </span>
  );
}
