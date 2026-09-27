import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { BookEdit } from '../../books/types';
import { canRemove } from '../../data/library';
import type { ShelfItem } from '../../data/useLibrary';
import { IconPlus } from '../../components/icons';
import { EditPopover } from './EditPopover';
import { Bento } from './layouts/Bento';
import { RECENT } from './layouts/slots';
import { Wall } from './layouts/Wall';
import { findSeries, type Series, type SeriesLook } from './series';
import { SeriesRows } from './SeriesRows';
import { SeriesSheet } from './SeriesSheet';
import { TitleHint } from './TitleHint';
import type { GalleryItem } from './types';
import './gallery.css';

interface Props {
  books: ShelfItem[];
  now: number;
  /** How series show, while the designs are compared. */
  look: SeriesLook;
  /** The id of the tab that labels this panel. */
  labelledBy: string;
  onOpen: (book: ShelfItem, rect: DOMRect) => void;
  onAdd: () => void;
  onEdit: (id: string, patch: BookEdit) => void;
  onRemove: (book: ShelfItem, fromKeyboard: boolean) => void;
}

/** The library: the most recent books as a bento block, everything else as a wall below it. */
export function Gallery({ books, now, look, labelledBy, onOpen, onAdd, onEdit, onRemove }: Props) {
  const first = useRef(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  useEffect(() => {
    const t = window.setTimeout(() => { first.current = false; }, 60);
    return () => window.clearTimeout(t);
  }, []);

  const series = useMemo(() => findSeries(books), [books]);
  const seriesNames = useMemo(() => [...new Set(books.flatMap((b) => (b.series ? [b.series] : [])))].sort(), [books]);
  const { recent, rest, rows } = useMemo(() => {
    const toItem = (b: ShelfItem): GalleryItem => ({ kind: 'book', key: b.key ?? b.id, book: b });
    if (look === 'rows') {
      // Recent as ever; each series gets a row of its own, and leaves the wall.
      const rows: Series[] = [];
      for (const b of books) {
        const s = series.get(b.id);
        if (s && !rows.includes(s)) rows.push(s);
      }
      return { recent: books.slice(0, RECENT).map(toItem), rest: books.slice(RECENT).filter((b) => !series.has(b.id)).map(toItem), rows };
    }
    // One card per series, where its latest book would stand.
    const items: GalleryItem[] = [];
    const placed = new Set<Series>();
    for (const b of books) {
      const s = series.get(b.id);
      if (!s) items.push(toItem(b));
      else if (!placed.has(s)) {
        placed.add(s);
        items.push({ kind: 'series', key: s.key, book: s.lead, series: s });
      }
    }
    return { recent: items.slice(0, RECENT), rest: items.slice(RECENT), rows: [] };
  }, [books, look, series]);

  // A stacked series opens to its books; kept by key, so it follows changes to the series.
  const [sheet, setSheet] = useState<string | null>(null);
  const openSeries = useCallback((s: Series) => setSheet(s.key), []);
  const sheetSeries = sheet ? [...series.values()].find((s) => s.key === sheet) : undefined;

  // Kept by card, so the popover stays open when editing a shared book adds it to the library.
  const openEdit = useCallback((b: ShelfItem, anchor: HTMLElement) => {
    const key = b.key ?? b.id;
    setEditing((cur) => (cur?.id === key ? null : { id: key, anchor }));
  }, []);
  const closeEdit = useCallback(() => setEditing(null), []);
  const editingBook = editing ? books.find((b) => (b.key ?? b.id) === editing.id) : undefined;

  const panel = { id: 'library', role: 'tabpanel', 'aria-labelledby': labelledBy } as const;

  if (!books.length) {
    return (
      <div {...panel} className="gallery is-empty">
        <button type="button" className="btn btn-primary gallery-add" onClick={onAdd}>
          <IconPlus /> Add a book
        </button>
      </div>
    );
  }

  const shared = { now, enter: first.current, editingId: editing?.id, look, onOpen, onEdit: openEdit, onSeries: openSeries };
  return (
    <motion.div {...panel} ref={scrollRef} className="gallery" layoutScroll>
      {/* "Recent" only means something when older books follow it. */}
      {rest.length + rows.length > 0 ? <div className="gallery-head"><span>Recent</span></div> : <div className="gallery-top" />}
      <Bento items={recent} {...shared} />
      {rows.length > 0 && <SeriesRows list={rows} now={now} enter={first.current} indexBase={RECENT} editingId={editing?.id} onOpen={onOpen} onEdit={openEdit} />}
      {rest.length > 0 && <Wall items={rest} indexBase={RECENT} {...shared} />}
      <AnimatePresence>
        {sheetSeries && <SeriesSheet key={sheetSeries.key} series={sheetSeries} onOpen={onOpen} onEdit={openEdit} onClose={() => setSheet(null)} />}
      </AnimatePresence>
      <AnimatePresence>
        {editing && editingBook && (
          <EditPopover
            key={editing.id}
            book={editingBook}
            seriesNames={seriesNames}
            anchor={editing.anchor}
            onChange={(patch) => onEdit(editing.id, patch)}
            onRemove={canRemove(editingBook) ? (fromKeyboard) => { setEditing(null); onRemove(editingBook, fromKeyboard); } : undefined}
            onClose={closeEdit}
          />
        )}
      </AnimatePresence>
      <TitleHint root={scrollRef} />
    </motion.div>
  );
}
