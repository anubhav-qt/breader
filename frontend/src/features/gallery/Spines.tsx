import type { CSSProperties, Ref } from 'react';
import { motion } from 'motion/react';
import type { ShelfItem } from '../../data/useLibrary';
import { springs } from '../../lib/springs';
import { IconMore } from '../../components/icons';
import { numberOf, type Series } from './series';
import { progressText, shortProgress } from './text';
import { bookVars } from './vars';

interface Props {
  series: Series;
  index: number;
  enter: boolean;
  className?: string;
  style?: CSSProperties;
  radius?: string | number;
  /** The edit popover of the book to read now is open. */
  open?: boolean;
  layoutKey?: string;
  ref?: Ref<HTMLDivElement>;
  onOpen: (book: ShelfItem, rect: DOMRect) => void;
  onEdit: (book: ShelfItem, anchor: HTMLElement) => void;
}

/**
 * A series as one card of spines in reading order. Each spine fills with its book's colour from
 * the bottom as it's read, so a finished series is a band of colour. The book to read now stands
 * open, with its title and line. Any spine opens its book; a right-click edits it.
 */
export function Spines({ series: s, index, enter, className = '', style, radius = 22, open = false, layoutKey, ref, onOpen, onEdit }: Props) {
  return (
    <motion.div
      ref={ref}
      className={`tile-slot ${className}`}
      style={{ ...style, borderRadius: radius }}
      initial={enter ? { opacity: 0, y: 18 } : { opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.2 } }}
      transition={{ ...springs.smooth, delay: enter ? Math.min(index, 24) * 0.028 : 0 }}
      layout="position"
      layoutDependency={layoutKey}
    >
      <div className="spines" role="group" aria-label={`${s.name}, ${s.books.length} books`}>
        {s.books.map((b) => {
          const lead = b === s.lead;
          const fill = Math.min(1, b.progress);
          const face = <SpineFace series={s} book={b} lead={lead} />;
          return (
            <div
              key={b.id}
              className={`spine${lead ? ' is-lead' : ''}`}
              style={bookVars(b)}
              onContextMenu={(e) => { e.preventDefault(); onEdit(b, e.currentTarget); }}
            >
              <div className="spine-face">{face}</div>
              {fill > 0 && (
                <div className="spine-face is-ink" aria-hidden="true" style={{ clipPath: `inset(${(1 - fill) * 100}% 0 0 0)` }}>{face}</div>
              )}
              <button
                type="button"
                className="tile-hit"
                data-id={b.id}
                aria-label={`${s.name} ${numberOf(s, b)}: ${b.title}, ${progressText(b)}`}
                onClick={(e) => onOpen(b, (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect())}
              />
              {lead && (
                <div className="tile-tools">
                  <button
                    type="button"
                    className="tile-more"
                    aria-label={`Edit ${b.title}`}
                    aria-haspopup="dialog"
                    aria-expanded={open}
                    title="Edit"
                    onClick={(e) => onEdit(b, e.currentTarget)}
                  >
                    <IconMore />
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </motion.div>
  );
}

function SpineFace({ series: s, book: b, lead }: { series: Series; book: ShelfItem; lead: boolean }) {
  if (!lead) {
    return (
      <>
        <span className="sp-num">{numberOf(s, b)}</span>
        <span className="sp-title">{b.title}</span>
      </>
    );
  }
  return (
    <>
      <span className="t-eyebrow">{s.name} · {numberOf(s, b)} of {s.books.length}</span>
      <span className="t-title">{b.title}</span>
      <span className="t-sub">
        <span className="t-author">{b.author}</span>
        <span className="t-meta">{shortProgress(b)}</span>
      </span>
      {b.line && <span className="t-line">{b.line}</span>}
    </>
  );
}
