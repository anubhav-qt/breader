import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { BookEdit } from '../../books/types';
import { canRemove, canShare } from '../../data/library';
import type { ShelfItem } from '../../data/useLibrary';
import { IconPlus } from '../../components/icons';
import { EditPopover } from './EditPopover';
import { Bento } from './layouts/Bento';
import { RECENT } from './layouts/slots';
import { Wall } from './layouts/Wall';
import { findSeries, type Series, type SeriesName } from './series';
import { SeriesRows } from './SeriesRows';
import { TitleHint } from './TitleHint';
import type { GalleryItem } from './types';
import './gallery.css';

interface Props {
  books: ShelfItem[];
  /** Every series in either library, offered as a series name is typed. */
  seriesNames: SeriesName[];
  now: number;
  /** The panel's id, and the id of the tab that labels it. */
  id: string;
  labelledBy: string;
  /** The other tab is showing: this one waits as it was, scrolled where it was. */
  hidden?: boolean;
  onOpen: (book: ShelfItem, rect: DOMRect) => void;
  onAdd: () => void;
  onEdit: (id: string, patch: BookEdit) => void;
  onRemove: (book: ShelfItem, fromKeyboard: boolean) => void;
  onShare: (book: ShelfItem, shared: boolean) => void;
}

/** The cards rise in and their colour grows only the first time a library appears after the page loads. */
let entered = false;

/**
 * The library: the most recent books as a bento block, one card per book, whether or not it's in a
 * series. Below it, side by side, a row per series and everything else as a wall by time.
 */
export function Gallery({ books, seriesNames, now, id, labelledBy, hidden = false, onOpen, onAdd, onEdit, onRemove, onShare }: Props) {
  const first = useRef(!entered);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  useEffect(() => {
    const t = window.setTimeout(() => { first.current = false; entered = true; }, 60);
    return () => window.clearTimeout(t);
  }, []);
  useEffect(() => { if (hidden) setEditing(null); }, [hidden]);

  const series = useMemo(() => findSeries(books), [books]);
  const { recent, rest, rows } = useMemo(() => {
    const toItem = (b: ShelfItem): GalleryItem => ({ key: b.key ?? b.id, book: b });
    const rows: Series[] = [];
    for (const b of books) {
      const s = series.get(b.id);
      if (s && !rows.includes(s)) rows.push(s);
    }
    // Series books have their rows, so the wall leaves them out.
    return { recent: books.slice(0, RECENT).map(toItem), rest: books.slice(RECENT).filter((b) => !series.has(b.id)).map(toItem), rows };
  }, [books, series]);

  // Kept by card, so the popover stays open when editing a shared book adds it to the library.
  const openEdit = useCallback((b: ShelfItem, anchor: HTMLElement) => {
    const key = b.key ?? b.id;
    setEditing((cur) => (cur?.id === key ? null : { id: key, anchor }));
  }, []);
  const closeEdit = useCallback(() => setEditing(null), []);
  const editingBook = editing ? books.find((b) => (b.key ?? b.id) === editing.id) : undefined;

  const panel = { id, role: 'tabpanel', 'aria-labelledby': labelledBy, hidden } as const;

  if (!books.length) {
    return (
      <div {...panel} className="gallery is-empty">
        <button type="button" className="btn btn-primary gallery-add" onClick={onAdd}>
          <IconPlus /> Add a book
        </button>
      </div>
    );
  }

  const shared = { now, enter: first.current, editingId: editing?.id, onOpen, onEdit: openEdit };
  return (
    <motion.div {...panel} ref={scrollRef} className="gallery" layoutScroll>
      {/* "Recent" only means something when older books follow it. */}
      {rest.length + rows.length > 0 ? <div className="gallery-head"><span>Recent</span></div> : <div className="gallery-top" />}
      <Bento items={recent} {...shared} />
      {rows.length + rest.length > 0 && (
        <div className={`halves${rows.length && rest.length ? ' is-split' : ''}`}>
          {rows.length > 0 && <SeriesRows list={rows} now={now} enter={first.current} indexBase={RECENT} editingId={editing?.id} onOpen={onOpen} onEdit={openEdit} />}
          {rest.length > 0 && <Wall items={rest} indexBase={RECENT} {...shared} />}
        </div>
      )}
      <AnimatePresence>
        {editing && editingBook && (
          <EditPopover
            key={editing.id}
            book={editingBook}
            seriesNames={seriesNames}
            anchor={editing.anchor}
            onChange={(patch) => onEdit(editing.id, patch)}
            onRemove={canRemove(editingBook) ? (fromKeyboard) => { setEditing(null); onRemove(editingBook, fromKeyboard); } : undefined}
            onShare={canShare(editingBook) ? (shared) => onShare(editingBook, shared) : undefined}
            onClose={closeEdit}
          />
        )}
      </AnimatePresence>
      <TitleHint root={scrollRef} />
    </motion.div>
  );
}
