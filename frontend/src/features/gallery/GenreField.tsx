import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { GENRES, UNSET_GENRE, genreName } from '@breader/shared/genres';
import { springs } from '../../lib/springs';
import { IconCheck, IconChevron, IconClose } from '../../components/icons';
import './genre.css';

interface Props {
  id?: string;
  /** The genre it's filed under; undefined or '' for unset. */
  value?: string;
  /** Whose pick it came with, marked in the list: "Sharer’s pick" on a copy of a shared book. */
  added?: { id?: string; label: string };
  /** The field's own look: the dialog's or the popover's input. */
  className?: string;
  onPick: (genre: string) => void;
}

/** Unset first, then every genre. '' is unset. */
const CHOICES = [{ id: '', name: UNSET_GENRE }, ...GENRES];

/** A field that shows a book's genre and opens the list of genres to pick another. */
export function GenreField({ id, value, added, className = '', onPick }: Props) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const name = genreName(value);
  const close = () => {
    setOpen(false);
    button.current?.focus({ preventScroll: true });
  };
  return (
    <>
      <button
        ref={button}
        id={id}
        type="button"
        className={`genre-field ${className}${name ? '' : ' is-unset'}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span>{name ?? UNSET_GENRE}</span>
        <IconChevron aria-hidden="true" />
      </button>
      <AnimatePresence>
        {open && <GenrePicker value={name ? value : ''} added={added} onPick={(g) => { close(); onPick(g); }} onClose={close} />}
      </AnimatePresence>
    </>
  );
}

/**
 * The list of genres, over whatever opened it: the add dialog or a card's popover. It takes Escape
 * and Tab for itself, so neither reaches the dialog or popover underneath.
 */
function GenrePicker({ value, added, onPick, onClose }: { value?: string; added?: Props['added']; onPick: (g: string) => void; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const on = grid.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? grid.current?.querySelector<HTMLElement>('button');
    on?.focus({ preventScroll: true });
    on?.scrollIntoView({ block: 'nearest' });
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      closeRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const els = Array.from(panel.current?.querySelectorAll<HTMLElement>('button') ?? []);
    const at = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Tab') {
      e.preventDefault();
      els[(at + (e.shiftKey ? -1 : 1) + els.length) % els.length]?.focus();
      return;
    }
    // Arrows move through the grid, a row at a time up and down.
    const choices = Array.from(grid.current?.children ?? []) as HTMLElement[];
    const i = choices.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const cols = grid.current ? getComputedStyle(grid.current).gridTemplateColumns.split(' ').length : 1;
    const move = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
    if (!move) return;
    e.preventDefault();
    choices[Math.max(0, Math.min(choices.length - 1, i + move))]?.focus();
  };

  return createPortal(
    <div className="gp-root">
      <motion.div className="gp-scrim" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} />
      <motion.div
        ref={panel}
        className="gp"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gp-title"
        onKeyDown={onKeyDown}
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 4, transition: { duration: 0.14 } }}
        transition={springs.snappy}
      >
        <div className="gp-head">
          <h2 className="gp-title" id="gp-title">Genre</h2>
          <button type="button" className="gp-x" onClick={onClose} aria-label="Close">
            <IconClose />
          </button>
        </div>
        <div ref={grid} className="gp-grid" role="radiogroup" aria-labelledby="gp-title">
          {CHOICES.map((g) => {
            const on = g.id === (value ?? '');
            const theirs = added && g.id === (added.id ?? '') && !!added.id;
            return (
              <button
                key={g.id || 'unset'}
                type="button"
                role="radio"
                aria-checked={on}
                className={`gp-choice${on ? ' is-on' : ''}${g.id ? '' : ' is-unset'}`}
                onClick={() => onPick(g.id)}
              >
                <span className="gp-name">{g.name}</span>
                {theirs && <span className="gp-tag">{added.label}</span>}
                {on && <IconCheck aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}
