import type { Ref } from 'react';
import type { ShelfItem } from '../../data/useLibrary';
import { IconAddBook, IconCheck, IconMore, IconStar } from '../../components/icons';
import { colorVars } from '../../data/colors';
import { Spark } from '../ai/AiStatus';
import { useCardProgress } from '../ai/progress';
import { stageText } from '../ai/words';
import { useRound } from '../design/round';

interface Props {
  book: ShelfItem;
  /** Its edit popover is open. */
  open: boolean;
  /** The edit button, which a right-click on the card opens the popover at too. */
  moreRef: Ref<HTMLButtonElement>;
  /** Picking books to act on together: whether this one is ticked. Absent otherwise. */
  picked?: boolean;
  onEdit: (book: ShelfItem, anchor: HTMLElement) => void;
  onKeep?: (book: ShelfItem) => void;
}

/**
 * A card's corner: keep (someone's shared book) or a tick once it's finished, the favourite star,
 * and the edit button, whose popover marks it finished. While picking, a tick takes the place of
 * the edit and keep buttons.
 */
export function Tools({ book: b, open, picked, moreRef, onEdit, onKeep }: Props) {
  const done = b.progress >= 1;
  // Someone else's book, in their shared library: theirs to change. It can only be read, or kept.
  const theirs = b.source === 'shelf';
  const keepable = !!onKeep && theirs && picked === undefined;
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
      {done && <span className="tile-fav tile-done is-on" title="Finished"><IconCheck /></span>}
      <CardSpark book={b} />
      {b.favorite && <span className="tile-fav" title="Favourite"><IconStar /></span>}
      {picked !== undefined && <Pick on={picked} />}
      {!theirs && picked === undefined && <button
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

/** While picking: the circle in a card's corner, ticked once the card is picked. */
export function Pick({ on }: { on: boolean }) {
  return (
    <span className={`tile-pick${on ? ' is-on' : ''}`} aria-hidden="true">
      {on && <IconCheck />}
    </span>
  );
}

/** Design C of this round: a spark in the corner of every book an AI reads along with, beating while it reads. */
function CardSpark({ book }: { book: ShelfItem }) {
  const { ai } = useRound();
  const on = ai === 'C' && !!book.ai && book.format !== 'CBZ';
  const p = useCardProgress(book.id, on);
  if (!on) return null;
  return (
    <span className="tile-fav tile-ai" style={colorVars(book.color)} title={`AI: ${stageText(p)}`}>
      <Spark p={p} />
    </span>
  );
}
