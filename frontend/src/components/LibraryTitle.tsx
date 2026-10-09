import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence } from 'motion/react';
import { IconCaret } from './icons';
import './library-switch.css';

interface Props {
  /** The library showing: the reader's own, or a shared one. */
  name: string;
  /** What its dropdown is, for its tooltip. */
  label: string;
  /**
   * Its dropdown: the reader's own library, to rename (features/shared/OwnLibraryMenu.tsx), or
   * the list of shared libraries (features/shared/LibraryMenu.tsx).
   */
  menu: (close: () => void) => ReactNode;
}

/** The library showing, named in the middle of the header, with its dropdown. */
export function LibraryTitle({ name, label, menu }: Props) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  // A tap anywhere else, or Escape, closes it.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);

  return (
    <div className="lt" ref={wrap}>
      <button
        type="button"
        className={`lt-btn${open ? ' is-open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={label}
        onClick={() => setOpen(!open)}
      >
        <span className="lt-name">{name}</span>
        <IconCaret />
      </button>
      <AnimatePresence>{open && menu(() => setOpen(false))}</AnimatePresence>
    </div>
  );
}
