import type { CSSProperties } from 'react';
import type { ShelfItem } from '../../data/useLibrary';
import { IconMore } from '../../components/icons';
import { Modal } from '../../components/Modal';
import { finishedIn, numberOf, type Series } from './series';
import { progressText } from './text';
import { bookVars } from './vars';

interface Props {
  series: Series;
  onOpen: (book: ShelfItem, rect: DOMRect) => void;
  onEdit: (book: ShelfItem, anchor: HTMLElement) => void;
  onClose: () => void;
}

/** A stacked series, opened: its books in order, each with its colour filled as far as it's read. */
export function SeriesSheet({ series: s, onOpen, onEdit, onClose }: Props) {
  return (
    <Modal title={s.name} onClose={onClose} width={440}>
      <p className="ss-sub">{finishedIn(s)} of {s.books.length} finished</p>
      <ol className="ss-list">
        {s.books.map((b) => (
          <li key={b.id} className={`ss-item${b === s.lead ? ' is-next' : ''}`} style={{ ...bookVars(b), '--p': Math.min(1, b.progress) } as CSSProperties}>
            <button
              type="button"
              className="ss-row"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                onClose();
                onOpen(b, rect);
              }}
            >
              <span className="ss-num">{numberOf(s, b)}</span>
              <span className="ss-swatch" aria-hidden="true" />
              <span className="ss-text">
                <span className="ss-title">{b.title}</span>
                <span className="ss-meta">{progressText(b)}</span>
              </span>
            </button>
            <button type="button" className="ss-more" aria-label={`Edit ${b.title}`} aria-haspopup="dialog" title="Edit" onClick={(e) => onEdit(b, e.currentTarget)}>
              <IconMore />
            </button>
          </li>
        ))}
      </ol>
    </Modal>
  );
}
