import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { Category } from '../books/category';
import type { LibraryLabels } from '../data/labels';
import { springs } from '../lib/springs';
import type { Tab } from './Header';
import { IconCaret } from './icons';
import { countFor, HALVES, nameOf, type Half } from './halves';
import './library-switch.css';

interface Props {
  category: Category;
  tab: Tab;
  counts: Record<Half, number>;
  labels: LibraryLabels;
  onTab: (t: Tab) => void;
}

/**
 * The switch between libraries on phones, where three halves don't fit: one button with the
 * library showing, and a tap opens the other two to pick from. LibrarySwitch on wider screens.
 */
export function LibraryPick({ category, tab, counts, labels, onTab }: Props) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  // A tap anywhere else closes it; Escape too, back on its button.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);

  // With Browse open none is showing: the button says the reader's own, and all three are listed.
  let shown: Half = 'mine';
  if (tab === 'shelf') shown = 'shelf';
  if (tab === 'public') shown = 'public';
  const others = HALVES.filter((h) => h !== tab);

  // A double click opens it once: its second click would only close it again.
  const toggle = (e: MouseEvent<HTMLButtonElement>) => {
    if (e.detail > 1) return;
    setOpen(!open);
  };

  const pick = (h: Half) => {
    setOpen(false);
    onTab(h);
  };

  return (
    <div className="lpk" ref={wrap}>
      <button
        ref={button}
        type="button"
        className="lpk-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Library: ${nameOf(shown, labels)}`}
        onClick={toggle}
      >
        <span className="lpk-name">{nameOf(shown, labels)}</span>
        <IconCaret />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="lpk-menu"
            role="menu"
            aria-label="Library"
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, transition: { duration: 0.12 } }}
            transition={springs.snappy}
          >
            {others.map((h) => (
              <button key={h} type="button" role="menuitem" className="lpk-item" onClick={() => pick(h)}>
                <span className="lpk-name">{nameOf(h, labels)}</span>
                <span className="sr-only">, {countFor(h, counts[h], category)}</span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
