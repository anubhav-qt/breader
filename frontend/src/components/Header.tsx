import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { springs } from '../lib/springs';
import { IconCaret, IconKey, IconPlus } from './icons';
import { Logo } from './Logo';
import './header.css';

export type Tab = 'mine' | 'shelf';

interface Props {
  tab: Tab;
  counts: Record<Tab, number>;
  /** The shared library the second tab shows: the reader's own, or someone's from their list. */
  shelfName: string;
  /** False while the open tab is empty: the empty library has its own centred Add button. */
  canAdd: boolean;
  onTab: (t: Tab) => void;
  onAdd: () => void;
  onKey: () => void;
  /** The list of shared libraries, under the second tab (features/shared/LibraryMenu.tsx). */
  libraries: (close: () => void) => ReactNode;
  /** Log in, or the account's menu. */
  account: ReactNode;
}

const TABS: Tab[] = ['mine', 'shelf'];

export function Header({ tab, counts, shelfName, canAdd, onTab, onAdd, onKey, libraries, account }: Props) {
  const [menu, setMenu] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const label = (t: Tab) => (t === 'mine' ? 'My books' : shelfName);

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

  // One Tab stop for both tabs; the arrow keys switch between them.
  const onArrow = (e: KeyboardEvent) => {
    const i = TABS.indexOf(tab);
    const moves: Record<string, number> = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 };
    const to = moves[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const next = TABS[(to + TABS.length) % TABS.length];
    onTab(next);
    document.getElementById(`tab-${next}`)?.focus();
  };

  return (
    <header className="hdr">
      <Logo />
      <div className="tabs-wrap" ref={wrap}>
        <nav className="tabs" role="tablist" aria-label="Library" onKeyDown={onArrow}>
          {TABS.map((t) => (
            <button
              key={t}
              id={`tab-${t}`}
              role="tab"
              type="button"
              className="tab"
              aria-selected={tab === t}
              aria-controls={`library-${t}`}
              tabIndex={tab === t ? 0 : -1}
              // The shared tab, chosen already, opens its list of libraries.
              onClick={() => (t === 'shelf' && tab === 'shelf' ? setMenu((m) => !m) : onTab(t))}
            >
              {t === 'shelf' && <span className="sr-only">Shared library: </span>}
              <span className="tab-name">{label(t)}</span>
              <span className="tab-count" aria-hidden="true">{counts[t]}</span>
              <span className="sr-only">, {counts[t]} {counts[t] === 1 ? 'book' : 'books'}</span>
              {tab === t && <motion.span className="tab-line" layoutId="tab-line" transition={springs.snappy} />}
            </button>
          ))}
        </nav>
        <button
          type="button"
          className={`tab-caret${menu ? ' is-open' : ''}`}
          aria-label="Shared libraries"
          aria-haspopup="dialog"
          aria-expanded={menu}
          title="Shared libraries"
          onClick={() => setMenu((m) => !m)}
        >
          <IconCaret />
        </button>
        <AnimatePresence>{menu && libraries(() => setMenu(false))}</AnimatePresence>
      </div>
      <div className="hdr-actions">
        {/* Not animated: a fading copy would sit beside the empty library's own Add button,
            and on phones that fade can stall and leave both on screen. */}
        {canAdd && (
          <button type="button" className="btn btn-primary" onClick={onAdd} aria-label="Add book">
            <IconPlus /> <span className="hdr-label">Add book</span>
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={onKey} title="Library key" aria-label="Library key">
          <IconKey /> <span className="hdr-label">Key</span>
        </button>
        {account}
      </div>
    </header>
  );
}
