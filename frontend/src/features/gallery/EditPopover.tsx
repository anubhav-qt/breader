import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import type { BookEdit } from '../../books/types';
import { BOOK_COLORS, colorVars } from '../../data/colors';
import type { ShelfItem } from '../../data/useLibrary';
import { springs } from '../../lib/springs';
import { IconCheck, IconClose, IconStar, IconTrash } from '../../components/icons';

interface Props {
  book: ShelfItem;
  /** Series already in the library, offered as the name is typed. */
  seriesNames: string[];
  anchor: HTMLElement;
  onChange: (patch: BookEdit) => void;
  /** Absent for books someone else shared: only they can take them off the shelf. */
  onRemove?: (fromKeyboard: boolean) => void;
  /** Puts the book on the Shared Library or takes it off. Only for the reader's own uploads. */
  onShare?: (shared: boolean) => void;
  onClose: () => void;
}

const WIDTH = 288;
const MARGIN = 12;
/** Swatches per row, as in .ep-swatches. Up and down arrows move a row. */
const COLS = 7;
const MOVES: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLS, ArrowUp: -COLS };

/**
 * A small popover beside the card's corner button: rename, put in a series, recolour, share,
 * favourite or remove.
 */
export function EditPopover({ book, seriesNames, anchor, onChange, onRemove, onShare, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [name, setName] = useState(book.title);
  const [series, setSeries] = useState(book.series ?? '');
  const [num, setNum] = useState(book.seriesIndex !== undefined ? String(book.seriesIndex) : '');
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const removing = useRef(false);

  useLayoutEffect(() => {
    const a = anchor.getBoundingClientRect();
    const h = ref.current?.offsetHeight ?? 300;
    const left = Math.max(MARGIN, Math.min(window.innerWidth - WIDTH - MARGIN, a.right - WIDTH));
    const below = a.bottom + 8;
    const above = below + h > window.innerHeight - MARGIN;
    setPos({ left, top: above ? Math.max(MARGIN, a.top - 8 - h) : below, above });
  }, [anchor]);

  const commitName = () => {
    if (removing.current) return;
    const t = name.trim();
    if (t && t !== book.title) onChange({ title: t });
    if (!t) setName(book.title);
  };
  // An empty name takes the book out of its series; an empty number leaves it unnumbered.
  const commitSeries = () => {
    if (removing.current) return;
    const s = series.trim();
    const n = num.trim() === '' ? undefined : Number(num.replace(',', '.'));
    const patch: BookEdit = {};
    if (s !== (book.series ?? '')) patch.series = s;
    if (n === undefined || (Number.isFinite(n) && n >= 0 && n <= 10_000)) {
      if (n !== book.seriesIndex) patch.seriesIndex = n;
    } else {
      setNum(book.seriesIndex !== undefined ? String(book.seriesIndex) : '');
    }
    if (Object.keys(patch).length) onChange(patch);
  };
  // A rename in progress is kept however the popover closes.
  const commitRef = useRef(() => { commitName(); commitSeries(); });
  commitRef.current = () => { commitName(); commitSeries(); };
  useEffect(() => () => commitRef.current(), []);

  // Focus moves in, so the keyboard carries on here; Escape hands it back to the corner button.
  useEffect(() => { ref.current?.focus({ preventScroll: true }); }, []);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node) || anchor.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      anchor.focus({ preventScroll: true });
      onClose();
    };
    const onScroll = () => onClose();
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onScroll);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onScroll);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [anchor, onClose]);

  // Tab cycles within the popover rather than leaving for the end of the page.
  const onTab = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !ref.current) return;
    const els = Array.from(ref.current.querySelectorAll<HTMLElement>('input, button:not([tabindex="-1"])'));
    const first = els[0];
    const last = els[els.length - 1];
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === ref.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
  };

  // The swatches are one stop for Tab; arrow keys move between them and pick as they go.
  const current = Math.max(0, BOOK_COLORS.findIndex((c) => c.key === book.color));
  const onSwatchKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const move = MOVES[e.key];
    if (!move) return;
    e.preventDefault();
    const n = BOOK_COLORS.length;
    const next = (current + move + n) % n;
    onChange({ color: BOOK_COLORS[next].key });
    (e.currentTarget.children[next] as HTMLElement | undefined)?.focus();
  };

  return createPortal(
    <motion.div
      ref={ref}
      className="ep"
      role="dialog"
      aria-label={`Edit ${book.title}`}
      tabIndex={-1}
      onKeyDown={onTab}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? 0, width: WIDTH, transformOrigin: pos?.above ? 'bottom right' : 'top right' }}
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: pos ? 1 : 0, scale: pos ? 1 : 0.96 }}
      exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.12 } }}
      transition={springs.snappy}
    >
      <div className="ep-head">
        <label className="ep-label" htmlFor="ep-name">Name</label>
        <button type="button" className="ep-x" onClick={onClose} aria-label="Close">
          <IconClose />
        </button>
      </div>
      <input
        id="ep-name"
        className="ep-input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commitName}
        onKeyDown={(e) => { if (e.key === 'Enter') { commitName(); (e.target as HTMLInputElement).blur(); } }}
        spellCheck={false}
        autoComplete="off"
      />
      <label className="ep-label" htmlFor="ep-series">Series</label>
      <div className="ep-series">
        <input
          id="ep-series"
          className="ep-input"
          value={series}
          list="ep-series-names"
          placeholder="None"
          onChange={(e) => setSeries(e.target.value)}
          onBlur={commitSeries}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          spellCheck={false}
          autoComplete="off"
        />
        <input
          className="ep-input ep-num"
          value={num}
          inputMode="decimal"
          placeholder="#"
          aria-label="Number in the series"
          onChange={(e) => setNum(e.target.value)}
          onBlur={commitSeries}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          autoComplete="off"
        />
        <datalist id="ep-series-names">
          {seriesNames.map((s) => <option key={s} value={s} />)}
        </datalist>
      </div>
      <div className="ep-label" id="ep-colour">Colour</div>
      <div className="ep-swatches" role="radiogroup" aria-labelledby="ep-colour" onKeyDown={onSwatchKey}>
        {BOOK_COLORS.map((c, i) => (
          <button
            key={c.key}
            type="button"
            role="radio"
            aria-checked={i === current}
            aria-label={c.label}
            title={c.label}
            tabIndex={i === current ? 0 : -1}
            className={`ep-sw${i === current ? ' is-on' : ''}`}
            style={colorVars(c.key)}
            onClick={() => onChange({ color: c.key })}
          >
            {i === current && <IconCheck />}
          </button>
        ))}
      </div>
      {onShare && (
        <div className="ep-share">
          <span className="ep-label" id="ep-share">On the Shared Library</span>
          <button type="button" className="ep-tg" role="switch" aria-checked={!!book.shared} aria-labelledby="ep-share" onClick={() => onShare(!book.shared)} />
        </div>
      )}
      <div className="ep-actions">
        <button
          type="button"
          className={`ep-act ep-fav${book.favorite ? ' is-on' : ''}`}
          aria-pressed={book.favorite}
          title={book.favorite ? 'Remove from favourites' : 'Add to favourites'}
          onClick={() => onChange({ favorite: !book.favorite })}
        >
          <IconStar />
          {book.favorite ? 'Favourited' : 'Favourite'}
        </button>
        {onRemove && (
          <button
            type="button"
            className="ep-act ep-remove"
            title="Remove from library"
            onClick={(e) => { removing.current = true; onRemove(e.detail === 0); }}
          >
            <IconTrash />
            Remove
          </button>
        )}
      </div>
    </motion.div>,
    document.body,
  );
}
