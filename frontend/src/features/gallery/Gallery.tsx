import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { BookEdit } from '../../books/types';
import { canRemove, canShare } from '../../data/library';
import type { ShelfItem } from '../../data/useLibrary';
import { IconPlus } from '../../components/icons';
import { EditPopover } from './EditPopover';
import { Bento } from './layouts/Bento';
import { RECENT } from './layouts/slots';
import { MangaLibrary } from './MangaLibrary';
import { cardAuthor, cardAuthors } from './names';
import { findSeries, seriesAuthors, type Series, type SeriesName } from './series';
import { SeriesDialog } from './SeriesDialog';
import { Shelves } from './Shelves';
import type { View } from './shelving';
import { TitleHint } from './TitleHint';
import type { GalleryItem } from './types';
import './gallery.css';

interface Props {
  books: ShelfItem[];
  /** Every series in either library, offered as a series name is typed. */
  seriesNames: SeriesName[];
  now: number;
  /** Which library, for the view below Recent it keeps. */
  place: string;
  /** The view below Recent until the reader picks one. */
  view: View;
  /** Manga: set out by its covers (MangaLibrary), and no series anywhere, not even in a card's menu. */
  manga?: boolean;
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
  /** Absent in the shared libraries, where no one's reading shows. */
  onFinish?: (book: ShelfItem, finished: boolean) => void;
  /** Someone's shared library: puts one of its books in the reader's own. */
  onKeep?: (book: ShelfItem) => void;
  /** Someone's shared library: puts these books of a series in the reader's own at once. */
  onKeepAll?: (books: ShelfItem[], series: string) => void;
  /** A series from MangaDex: its sheet, for its chapters and their language. */
  onChapters?: (book: ShelfItem) => void;
  /** What an empty library says, in place of its Add button. */
  empty?: ReactNode;
}

/** The cards rise in and their colour grows only the first time a library appears after the page loads. */
let entered = false;

/**
 * The library: the most recent books as a bento block, one card per book, whether or not it's in a
 * series. Below it, every book again, by genre, series or date (Shelves).
 */
export function Gallery({ books, seriesNames, place, view, manga = false, now, id, labelledBy, hidden = false, onOpen, onAdd, onEdit, onRemove, onShare, onFinish, onKeep, onKeepAll, onChapters, empty }: Props) {
  const first = useRef(!entered);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const [showing, setShowing] = useState<string | null>(null);
  useEffect(() => {
    const t = window.setTimeout(() => { first.current = false; entered = true; }, 60);
    return () => window.clearTimeout(t);
  }, []);
  useEffect(() => {
    if (!hidden) return;
    setEditing(null);
    setShowing(null);
  }, [hidden]);

  const series = useMemo(() => {
    if (manga) return new Map<string, Series>();
    return findSeries(books, 1);
  }, [books, manga]);
  const stacks = useMemo(() => new Map([...series].filter(([, s]) => s.books.length > 1)), [series]);
  // A series' cards all go by the name most of its books give first.
  const authors = useMemo(() => seriesAuthors(stacks, (raw) => cardAuthor(raw).author, cardAuthors), [stacks]);
  const recent = useMemo(
    () => books.slice(0, RECENT).map((b): GalleryItem => ({ key: b.key ?? b.id, book: b, author: authors.get(b.id) })),
    [books, authors],
  );
  // The series whose dialog is open, as it is now: edits made in it show at once.
  const open = showing ? [...series.values()].find((s) => s.key === showing) : undefined;
  const openSeries = useCallback((s: { key: string }) => { setEditing(null); setShowing(s.key); }, []);
  const closeSeries = useCallback(() => setShowing(null), []);

  // Kept by card, so the popover stays open when editing a shared book adds it to the library.
  const openEdit = useCallback((b: ShelfItem, anchor: HTMLElement) => {
    const key = b.key ?? b.id;
    setEditing((cur) => (cur?.id === key ? null : { id: key, anchor }));
  }, []);
  const closeEdit = useCallback(() => setEditing(null), []);
  const editingBook = editing ? books.find((b) => (b.key ?? b.id) === editing.id) : undefined;
  // The rest of its series in the reader's library: a genre can go on all of them. Shared books not
  // started are left be, since editing one adds it to the library.
  const editingOthers = editingBook ? series.get(editingBook.id)?.books.filter((b) => b !== editingBook && b.source !== 'shelf') : undefined;

  const panel = { id, role: 'tabpanel', 'aria-labelledby': labelledBy, hidden } as const;

  if (!books.length) {
    return (
      <div {...panel} className="gallery is-empty">
        {empty ?? (
          <button type="button" className="btn btn-primary gallery-add" onClick={onAdd}>
            <IconPlus /> Add a book
          </button>
        )}
      </div>
    );
  }

  const shared = { now, enter: first.current, editingId: editing?.id, onOpen, onEdit: openEdit, onFinish, onKeep };
  // Shelves below only add something once there's more than Recent holds, or a series to show.
  const more = books.length > RECENT || stacks.size > 0;
  return (
    <motion.div {...panel} ref={scrollRef} className="gallery" layoutScroll>
      {manga && <MangaLibrary books={books} {...shared} />}
      {!manga && (
        <section className="recent" aria-label="Recent">
          {/* "Recent" only means something when more books follow it. */}
          {more ? <div className="gallery-head"><span>Recent</span></div> : <div className="gallery-top" />}
          <Bento items={recent} {...shared} />
        </section>
      )}
      {!manga && more && (
        <Shelves
          books={books}
          stacks={stacks}
          series={series}
          authors={authors}
          place={place}
          initial={view}
          root={scrollRef}
          indexBase={RECENT}
          onSeries={openSeries}
          onKeepAll={onKeepAll}
          {...shared}
        />
      )}
      <AnimatePresence>
        {editing && editingBook && (
          <EditPopover
            key={editing.id}
            book={editingBook}
            seriesNames={seriesNames}
            noSeries={manga}
            anchor={editing.anchor}
            others={editingOthers}
            // By the book's own id: a started shared book's card goes by the sharer's, its copy by its own.
            onChange={(patch) => onEdit(editingBook.id, patch)}
            onChangeOther={(b, patch) => onEdit(b.id, patch)}
            onRemove={canRemove(editingBook) ? (fromKeyboard) => { setEditing(null); onRemove(editingBook, fromKeyboard); } : undefined}
            onShare={canShare(editingBook) ? (shared) => onShare(editingBook, shared) : undefined}
            // A shared book not started has no reading of the reader's own to finish.
            onFinish={onFinish && editingBook.source !== 'shelf' ? (finished) => onFinish(editingBook, finished) : undefined}
            onChapters={onChapters && editingBook.source === 'remote' ? () => { setEditing(null); onChapters(editingBook); } : undefined}
            onClose={closeEdit}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {open && (
          <SeriesDialog
            key={open.key}
            series={open}
            authors={authors}
            now={now}
            editingId={editing?.id}
            onOpen={onOpen}
            onEdit={openEdit}
            onFinish={onFinish}
            onKeep={onKeep}
            onKeepAll={onKeepAll}
            onClose={closeSeries}
          />
        )}
      </AnimatePresence>
      <TitleHint root={scrollRef} />
    </motion.div>
  );
}
