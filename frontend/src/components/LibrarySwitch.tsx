import type { KeyboardEvent } from 'react';
import { motion } from 'motion/react';
import type { Category } from '../books/category';
import type { LibraryLabels } from '../data/labels';
import { springs } from '../lib/springs';
import type { Tab } from './Header';
import { countFor, HALVES, nameOf, type Half } from './halves';
import './library-switch.css';

const TABS = HALVES;

interface Props {
  category: Category;
  tab: Tab;
  /** Books or manga in the two libraries, and public libraries with any. */
  counts: Record<Half, number>;
  /** The names of the first two halves, the same for books and manga. */
  labels: LibraryLabels;
  onTab: (t: Tab) => void;
}

/**
 * Between the reader's own library, the shared ones and the public feed, at the start of the
 * header: three halves of one width, the first two carrying the reader's names for them, Personal
 * and Shared to start with. The pencil beside it (LibraryEdit) renames the one showing, or lists
 * the shared ones.
 */
export function LibrarySwitch({ category, tab, counts, labels, onTab }: Props) {
  // With Browse open, neither is chosen: the reader's own keeps the Tab stop.
  let focusable: Half = 'mine';
  if (tab === 'shelf') focusable = 'shelf';
  if (tab === 'public') focusable = 'public';

  // One Tab stop for both; the arrow keys switch between them.
  const onArrow = (e: KeyboardEvent) => {
    const i = TABS.indexOf(focusable);
    const moves: Record<string, number> = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 };
    const to = moves[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const next = TABS[(to + TABS.length) % TABS.length];
    onTab(next);
    document.getElementById(`tab-${next}`)?.focus();
  };

  return (
    <div className="lsw" role="tablist" aria-label="Library" onKeyDown={onArrow}>
      {TABS.map((t) => (
        <button
          key={t}
          id={`tab-${t}`}
          role="tab"
          type="button"
          className="lsw-tab"
          aria-selected={tab === t}
          aria-controls={`library-${category}-${t}`}
          tabIndex={focusable === t ? 0 : -1}
          onClick={() => onTab(t)}
        >
          {tab === t && <motion.span className="lsw-on" layoutId="lsw-on" transition={springs.snappy} />}
          {t === 'shelf' && <span className="sr-only">Shared library: </span>}
          <span className="lsw-name">{nameOf(t, labels)}</span>
          <span className="sr-only">, {countFor(t, counts[t], category)}</span>
        </button>
      ))}
    </div>
  );
}
