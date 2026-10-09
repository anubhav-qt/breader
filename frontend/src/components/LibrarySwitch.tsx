import type { KeyboardEvent } from 'react';
import { motion } from 'motion/react';
import { countOf, type Category } from '../books/category';
import type { LibraryLabels } from '../data/labels';
import { springs } from '../lib/springs';
import type { PlusButton, Tab } from './Header';
import { IconPlus } from './icons';
import './library-switch.css';

const TABS: Array<'mine' | 'shelf'> = ['mine', 'shelf'];

interface Props {
  category: Category;
  tab: Tab;
  counts: Record<'mine' | 'shelf', number>;
  /** The names of the two halves, the same for books and manga. */
  labels: LibraryLabels;
  onTab: (t: Tab) => void;
  /** The + button at the end: Add book, or Browse, with its word on wide screens. */
  plus: PlusButton | null;
}

/**
 * Between the reader's own library and the shared ones: two halves of a pill, one width, carrying
 * the reader's names for them, Personal and Shared to start with, and the + button at the end. At
 * the header's end on wide screens and floating at the bottom on phones, where a thumb reaches it.
 * The library showing is named in the header's middle, with its dropdown (LibraryTitle).
 */
export function LibrarySwitch({ category, tab, counts, labels, onTab, plus }: Props) {
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
    <div className="ls">
      <div className="ls-seg">
        <div className="ls-tabs" role="tablist" aria-label="Library" onKeyDown={onArrow}>
          {TABS.map((t) => (
            <button
              key={t}
              id={`tab-${t}`}
              role="tab"
              type="button"
              className="ls-tab"
              aria-selected={tab === t}
              aria-controls={`library-${t}`}
              tabIndex={focusable === t ? 0 : -1}
              onClick={() => onTab(t)}
            >
              {tab === t && <motion.span className="ls-on" layoutId="ls-on" transition={springs.snappy} />}
              {t === 'shelf' && <span className="sr-only">Shared library: </span>}
              <span className="ls-name">{labels[t]}</span>
              <span className="sr-only">, {countOf(counts[t], category)}</span>
            </button>
          ))}
        </div>
        {plus && (
          <button type="button" className="ls-plus" aria-label={plus.label} aria-pressed={plus.pressed} onClick={plus.run}>
            <IconPlus />
            <span className="ls-plus-word">{plus.word}</span>
          </button>
        )}
      </div>
    </div>
  );
}
