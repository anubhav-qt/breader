import { useRef, useState } from 'react';
import { motion } from 'motion/react';
import type { ShelfItem } from '../../data/useLibrary';
import { springs } from '../../lib/springs';
import { cardNames, markFor } from './names';
import { chapterText } from './text';
import { Tools } from './Tools';
import type { GalleryItem } from './types';
import { bookVars } from './vars';
import './covers.css';

interface Props {
  item: GalleryItem;
  index: number;
  enter: boolean;
  /** Its title on it, over its foot, with a line for how far it's read; without, the cover alone. */
  words: boolean;
  /** Its edit popover is open. */
  open?: boolean;
  /** Picking series to favourite or remove together: whether this one is ticked. */
  picked?: boolean;
  /** Changes when series join or leave the section: only then do cards glide to their new places. */
  layoutKey?: string;
  onOpen: (book: ShelfItem, rect: DOMRect) => void;
  onEdit: (book: ShelfItem, anchor: HTMLElement) => void;
  onKeep?: (book: ShelfItem) => void;
}

/**
 * A manga series as its cover. A series without a cover (or whose cover won't load) gets one drawn
 * in its colour. The cover opens it; the corner button (or a right-click) edits it, as on the
 * books' cards.
 */
export function CoverCard({ item, index, enter, words, open = false, picked, layoutKey, onOpen, onEdit, onKeep }: Props) {
  const b = item.book;
  const moreRef = useRef<HTMLButtonElement>(null);
  const [broken, setBroken] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const n = cardNames(b, item.author);
  const drawn = !b.coverUrl || broken;
  const read = `${Math.round(Math.min(b.progress, 1) * 100)}%`;

  return (
    <motion.div
      className={`tile-slot cv${drawn ? ' is-drawn' : ''}${picked ? ' is-picked' : ''}`}
      style={bookVars(b)}
      // The library's first appearance rises in; a series added or put back later settles in place.
      initial={enter ? { opacity: 0, y: 18 } : { opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.2 } }}
      transition={{ ...springs.smooth, delay: enter ? Math.min(index, 24) * 0.028 : 0 }}
      layout="position"
      layoutDependency={layoutKey}
    >
      <div
        className="cv-art"
        onContextMenu={(e) => {
          if (!moreRef.current) return;
          e.preventDefault();
          if (!open) onEdit(b, moreRef.current);
        }}
      >
        {drawn ? (
          <span className="cv-drawn" aria-hidden="true">
            <span className="cv-by">{n.author}</span>
            <span className="cv-mark">{markFor(n.title)}</span>
          </span>
        ) : (
          <img
            className={loaded ? 'is-loaded' : undefined}
            src={b.coverUrl}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onLoad={() => setLoaded(true)}
            onError={() => setBroken(true)}
          />
        )}
        {words && (
          <span className="cv-words" aria-hidden="true">
            <span className="cv-line"><span style={{ width: read }} /></span>
            <span className="cv-title">{n.title}</span>
          </span>
        )}
        <button
          type="button"
          className="tile-hit"
          data-id={b.id}
          aria-label={`${b.title}, ${chapterText(b)}`}
          aria-pressed={picked}
          onClick={(e) => onOpen(b, (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect())}
        />
        <Tools book={b} open={open} picked={picked} moreRef={moreRef} onEdit={onEdit} onKeep={onKeep} />
      </div>
    </motion.div>
  );
}
