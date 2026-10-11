import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence } from 'motion/react';
import { IconPencil } from './icons';
import './library-switch.css';

interface Props {
  /** What its dropdown is, for its tooltip. */
  label: string;
  /**
   * Its dropdown: the reader's own library, to rename (features/shared/OwnLibraryMenu.tsx), or
   * the list of shared libraries, to pick, rename or add one (features/shared/LibraryMenu.tsx).
   */
  menu: (close: () => void) => ReactNode;
}

/** The pencil beside the switch between libraries, with the dropdown of the library showing. */
export function LibraryEdit({ label, menu }: Props) {
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
    <div className="le" ref={wrap}>
      <button
        type="button"
        className={`btn btn-ghost hdr-icon le-btn${open ? ' is-open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen(!open)}
      >
        <IconPencil />
      </button>
      <AnimatePresence>{open && menu(() => setOpen(false))}</AnimatePresence>
    </div>
  );
}
