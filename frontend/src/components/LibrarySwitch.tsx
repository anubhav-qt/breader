import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { countOf, type Category } from '../books/category';
import { springs } from '../lib/springs';
import type { Tab } from './Header';
import { IconCaret } from './icons';
import './library-switch.css';

const TABS: Array<'mine' | 'shelf'> = ['mine', 'shelf'];

interface Props {
  category: Category;
  tab: Tab;
  counts: Record<'mine' | 'shelf', number>;
  /** The shared library the second one shows: the reader's own, or someone's from their list. */
  shelfName: string;
  onTab: (t: Tab) => void;
  /** The list of shared libraries (features/shared/LibraryMenu.tsx). */
  libraries: (close: () => void) => ReactNode;
}

/**
 * Between the reader's own library and the shared ones: two halves of a pill, in the header on
 * wide screens and floating at the bottom on phones, where a thumb reaches it.
 */
export function LibrarySwitch({ category, tab, counts, shelfName, onTab, libraries }: Props) {
  const [menu, setMenu] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const mine = category === 'manga' ? 'My manga' : 'My books';
  // With Browse open, neither is chosen: the reader's own keeps the Tab stop.
  let focusable: 'mine' | 'shelf' = 'mine';
  if (tab === 'shelf') focusable = 'shelf';
  const close = () => setMenu(false);

  useEffect(() => {
    if (!menu) return;
    const away = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setMenu(false); };
    const esc = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', esc);
    };
  }, [menu]);

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
    <div className="ls" ref={wrap}>
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
              // The shared one, chosen already, opens its list of libraries.
              onClick={() => (t === 'shelf' && tab === 'shelf' ? setMenu((m) => !m) : onTab(t))}
            >
              {tab === t && <motion.span className="ls-on" layoutId="ls-on" transition={springs.snappy} />}
              {t === 'shelf' && <span className="sr-only">Shared library: </span>}
              <span className="ls-name">{t === 'mine' ? mine : shelfName}</span>
              <span className="ls-count" aria-hidden="true">{counts[t]}</span>
              <span className="sr-only">, {countOf(counts[t], category)}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`ls-caret${menu ? ' is-open' : ''}`}
          aria-label="Shared libraries"
          aria-haspopup="dialog"
          aria-expanded={menu}
          title="Shared libraries"
          onClick={() => setMenu((m) => !m)}
        >
          <IconCaret />
        </button>
      </div>
      <AnimatePresence>{menu && libraries(close)}</AnimatePresence>
    </div>
  );
}
