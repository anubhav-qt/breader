import type { Ref } from 'react';
import type { ShelfItem } from '../../data/useLibrary';
import { IconAddBook, IconCheck, IconMore, IconStar } from '../../components/icons';

interface Props {
  book: ShelfItem;
  /** Its edit popover is open. */
  open: boolean;
  /** The edit button, which a right-click on the card opens the popover at too. */
  moreRef: Ref<HTMLButtonElement>;
  onEdit: (book: ShelfItem, anchor: HTMLElement) => void;
  onFinish?: (book: ShelfItem, finished: boolean) => void;
  onKeep?: (book: ShelfItem) => void;
}

/**
 * A card's corner: keep (someone's shared book) or the finished tick, the favourite star, and the
 * edit button.
 */
export function Tools({ book: b, open, moreRef, onEdit, onFinish, onKeep }: Props) {
  const done = b.progress >= 1;
  // Someone else's book, in their shared library: theirs to change. It can only be read, or kept.
  const theirs = b.source === 'shelf';
  const finishable = !!onFinish && !theirs;
  const keepable = !!onKeep && theirs;
  return (
    <div className="tile-tools">
      {keepable && (
        <button
          type="button"
          className={`tile-fav tile-keep${b.kept ? ' is-on' : ''}`}
          aria-pressed={!!b.kept}
          aria-label={b.kept ? `${b.title} is in your library` : `Add ${b.title} to your library`}
          title={b.kept ? 'In your library' : 'Add to my library'}
          onClick={() => { if (!b.kept) onKeep!(b); }}
        >
          {b.kept ? <IconCheck /> : <IconAddBook />}
        </button>
      )}
      {finishable ? (
        <button
          type="button"
          className={`tile-fav tile-done${done ? ' is-on' : ''}`}
          aria-pressed={done}
          aria-label={done ? `${b.title} is finished` : `Mark ${b.title} as finished`}
          title={done ? 'Finished. Tap if it isn’t after all' : 'Mark as finished'}
          onClick={() => onFinish!(b, !done)}
        >
          <IconCheck />
        </button>
      ) : done && <span className="tile-fav tile-done is-on" title="Finished"><IconCheck /></span>}
      {b.favorite && <span className="tile-fav" title="Favourite"><IconStar /></span>}
      {!theirs && <button
        ref={moreRef}
        type="button"
        className="tile-more"
        aria-label={`Edit ${b.title}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Edit"
        onClick={(e) => onEdit(b, e.currentTarget)}
      >
        <IconMore />
      </button>}
    </div>
  );
}
