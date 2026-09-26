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
import { TitleHint } from './TitleHint';
import type { GalleryItem } from './types';
import './gallery.css';

interface Props {
  books: ShelfItem[];
  now: number;
  /** The id of the tab that labels this panel. */
  labelledBy: string;
  onOpen: (book: ShelfItem, rect: DOMRect) => void;
  onAdd: () => void;
  onEdit: (id: string, patch: BookEdit) => void;
  onRemove: (book: ShelfItem, fromKeyboard: boolean) => void;
}

/** The library: the most recent books as a bento block, everything else as a wall below it. */
export function Gallery({ books, now, labelledBy, onOpen, onAdd, onEdit, onRemove }: Props) {
  const first = useRef(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  useEffect(() => {
    const t = window.setTimeout(() => { first.current = false; }, 60);
    return () => window.clearTimeout(t);
  }, []);

  const { recent, rest } = useMemo(() => {
    const toItem = (b: ShelfItem): GalleryItem => ({ kind: 'book', key: b.id, book: b });
    return { recent: books.slice(0, RECENT).map(toItem), rest: books.slice(RECENT).map(toItem) };
  }, [books]);

  const openEdit = useCallback((b: ShelfItem, anchor: HTMLElement) => {
    setEditing((cur) => (cur?.id === b.id ? null : { id: b.id, anchor }));
  }, []);
  const closeEdit = useCallback(() => setEditing(null), []);
  const editingBook = editing ? books.find((b) => b.id === editing.id) : undefined;

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

  const shared = { now, enter: first.current, editingId: editing?.id, onOpen, onEdit: openEdit };
  return (
    <motion.div {...panel} ref={scrollRef} className="gallery" layoutScroll>
      {/* "Recent" only means something when older books follow it. */}
      {rest.length > 0 ? <div className="gallery-head"><span>Recent</span></div> : <div className="gallery-top" />}
      <Bento items={recent} {...shared} />
      {rest.length > 0 && <Wall items={rest} indexBase={RECENT} {...shared} />}
      <AnimatePresence>
        {editing && editingBook && (
          <EditPopover
            key={editing.id}
            book={editingBook}
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
