import { createPortal } from 'react-dom';
import type { ShelfItem } from '../../data/useLibrary';
import { Modal } from '../../components/Modal';
import { KeepSeries } from './KeepSeries';
import { cardAuthor } from './names';
import { finishedIn, numberOf, type Series } from './series';
import { CoverCard } from './CoverCard';

interface Props {
  series: Series;
  /** The name its cards go by, by book id. */
  authors: Map<string, string>;
  /** The covers without their titles and how far they're read (Settings, Only covers). */
  coversOnly: boolean;
  editingId?: string;
  onOpen: (book: ShelfItem, rect: DOMRect) => void;
  onEdit: (book: ShelfItem, anchor: HTMLElement) => void;
  onKeep?: (book: ShelfItem) => void;
  onKeepAll?: (books: ShelfItem[], series: string) => void;
  onClose: () => void;
}

/** A whole series, its books in order on cards all the same size. Opening one closes it. */
export function SeriesDialog({ series: s, authors, coversOnly, editingId, onOpen, onEdit, onKeep, onKeepAll, onClose }: Props) {
  const author = s.books.map((b) => authors.get(b.id)).find(Boolean) ?? cardAuthor(s.books[0].author).author;
  const n = s.books.length;
  const finished = finishedIn(s);
  return createPortal(
    <Modal title={s.name} onClose={onClose} width={880} className="sd">
      <p className="sd-meta">
        {author && <span>{author}</span>}
        <span>{n === 1 ? '1 book' : `${n} books`}</span>
        {/* No one's reading shows in someone's shared library. */}
        {onKeepAll ? <KeepSeries name={s.name} books={s.books} onKeepAll={onKeepAll} /> : <span>{finished === n ? 'All finished' : `${finished} finished`}</span>}
      </p>
      <div className="sd-grid">
        {s.books.map((b) => {
          const key = b.key ?? b.id;
          return (
            <CoverCard
              key={key}
              item={{ key, book: b, author: authors.get(b.id) }}
              words={!coversOnly}
              enter={false}
              className="sd-tile"
              number={numberOf(s, b)}
              open={key === editingId}
              onOpen={(book, rect) => { onClose(); onOpen(book, rect); }}
              onEdit={onEdit}
              onKeep={onKeep}
            />
          );
        })}
      </div>
    </Modal>,
    document.body,
  );
}
