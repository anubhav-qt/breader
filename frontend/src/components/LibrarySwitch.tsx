import type { KeyboardEvent } from 'react';
import { motion } from 'motion/react';
import { countOf, type Category } from '../books/category';
import type { LibraryLabels } from '../data/labels';
import { springs } from '../lib/springs';
import type { Tab } from './Header';
import './library-switch.css';

const TABS: Array<'mine' | 'shelf'> = ['mine', 'shelf'];

interface Props {
  category: Category;
  tab: Tab;
  counts: Record<'mine' | 'shelf', number>;
  /** The names of the two halves, the same for books and manga. */
  labels: LibraryLabels;
  onTab: (t: Tab) => void;
}

/**
 * Between the reader's own library and the shared ones, at the start of the header: two halves of
 * one width, carrying the reader's names for them, Personal and Shared to start with. The pencil
 * beside it (LibraryEdit) renames the one showing, or lists the shared ones.
 */
export function LibrarySwitch({ category, tab, counts, labels, onTab }: Props) {
  // With Browse open, neither is chosen: the reader's own keeps the Tab stop.
  let focusable: 'mine' | 'shelf' = 'mine';
  if (tab === 'shelf') focusable = 'shelf';

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
          aria-controls={`library-${t}`}
          tabIndex={focusable === t ? 0 : -1}
          onClick={() => onTab(t)}
        >
          {tab === t && <motion.span className="lsw-on" layoutId="lsw-on" transition={springs.snappy} />}
          {t === 'shelf' && <span className="sr-only">Shared library: </span>}
          <span className="lsw-name">{labels[t]}</span>
          <span className="sr-only">, {countOf(counts[t], category)}</span>
        </button>
      ))}
    </div>
  );
}
