import { useRef, useState } from 'react';
import { motion } from 'motion/react';
import { useShelfCover } from '../../data/shelf';
import type { ShelfItem } from '../../data/useLibrary';
import { springs } from '../../lib/springs';
import { cardNames, markFor } from './names';
import { chapterText, progressText } from './text';
import { Pick, Tools } from './Tools';
import type { GalleryItem } from './types';
import { bookVars } from './vars';
import './covers.css';

interface Props {
  item: GalleryItem;
  enter: boolean;
  /** Its title on it, over its foot, with a line for how far it's read; without, the cover alone. */
  words: boolean;
  /** A manga series: how far it's read goes by chapter. */
  manga?: boolean;
  /** The book's number in its series, for the mark on a drawn cover. */
  number?: number;
  /** A whole series as one card, standing on this book's cover: it opens the series. */
  stack?: Stack;
  /** Its edit popover is open. */
  open?: boolean;
  /** Picking books to change together: whether this one is ticked. */
  picked?: boolean;
  /** Changes when cards join or leave the section: only then do cards glide to their new places. */
  layoutKey?: string;
  className?: string;
  onOpen: (book: ShelfItem, rect: DOMRect) => void;
  onEdit: (book: ShelfItem, anchor: HTMLElement) => void;
  onKeep?: (book: ShelfItem) => void;
}

/** A whole series as one card: its name, how many books, how many finished. */
export interface Stack {
  name: string;
  count: number;
  finished: number;
}

/** How far it's read, from 0 to 1: a series by its finished books. */
function readOf(b: ShelfItem, stack?: Stack) {
  if (stack) return stack.finished / stack.count;
  return Math.min(b.progress, 1);
}

/** What a screen reader hears for the card. */
function labelOf(b: ShelfItem, manga: boolean, stack?: Stack) {
  if (stack) return `${stack.name}, a series of ${stack.count} books, ${stack.finished} finished`;
  if (manga) return `${b.title}, ${chapterText(b)}`;
  return `${b.title}, ${progressText(b)}`;
}

/**
 * A book or a manga series as its cover, the same everywhere but the books' bento. A book without
 * a cover (or whose cover won't load) gets one drawn in its colour, with its title on it as a
 * printed cover has. The cover opens it; the corner buttons (or a right-click) edit it.
 */
export function CoverCard({ item, enter, words, manga = false, number, stack, open = false, picked, layoutKey, className = '', onOpen, onEdit, onKeep }: Props) {
  const b = item.book;
  const moreRef = useRef<HTMLButtonElement>(null);
  const artRef = useRef<HTMLDivElement>(null);
  useShelfCover(artRef, b);
  const [broken, setBroken] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const n = cardNames(b, item.author);
  const drawn = !b.coverUrl || broken;
  const title = stack ? stack.name : n.title;
  const read = `${Math.round(readOf(b, stack) * 100)}%`;
  let vol = number;
  if (!manga) vol = number ?? n.vol;
  // A drawn cover keeps its title even with covers only: without it, the card would be a letter.
  const showTitle = words || drawn;

  let classes = `tile-slot cv ${className}`;
  if (drawn) classes += ' is-drawn';
  if (stack) classes += ' is-stack';
  if (picked) classes += ' is-picked';

  return (
    <motion.div
      className={classes}
      style={bookVars(b)}
      // The library's first appearance is there at once; a card added or put back later settles in place.
      initial={enter ? false : { opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.2 } }}
      transition={springs.smooth}
      layout="position"
      layoutDependency={layoutKey}
    >
      <div
        ref={artRef}
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
            <span className="cv-mark">{markFor(title, vol)}</span>
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
        {showTitle && (
          <span className="cv-words" aria-hidden="true">
            {words && <span className="cv-line"><span style={{ width: read }} /></span>}
            <span className="cv-title">{title}</span>
          </span>
        )}
        <button
          type="button"
          className="tile-hit"
          data-id={b.id}
          aria-label={labelOf(b, manga, stack)}
          aria-haspopup={stack && picked === undefined ? 'dialog' : undefined}
          aria-pressed={picked}
          onClick={(e) => onOpen(b, (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect())}
        />
        {/* A series' card opens the series; its books are edited there. While picking, it ticks them all. */}
        {!stack && <Tools book={b} open={open} picked={picked} moreRef={moreRef} onEdit={onEdit} onKeep={onKeep} />}
        {stack && picked !== undefined && <div className="tile-tools"><Pick on={picked} /></div>}
      </div>
    </motion.div>
  );
}
