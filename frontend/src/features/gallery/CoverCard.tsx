import { useRef, useState, type CSSProperties } from 'react';
import { motion } from 'motion/react';
import type { ShelfItem } from '../../data/useLibrary';
import { springs } from '../../lib/springs';
import { cardNames, markFor } from './names';
import { chapterText } from './text';
import { Tools } from './Tools';
import type { GalleryItem } from './types';
import { bookVars } from './vars';
import './covers.css';

/** The title and chapter under the cover, or on it, over its foot. */
export type Caption = 'under' | 'over';

/** A manga cover's usual shape, width over height, as Browse shows them. */
export const COVER = 1 / 1.42;

interface Props {
  item: GalleryItem;
  index: number;
  enter: boolean;
  caption: Caption;
  /**
   * The cover's shape, width over height, when its caption is under it: a manga cover's usual one
   * unless it's given. With the caption on it, the cover fills the card whatever its shape.
   */
  ratio?: number;
  className?: string;
  style?: CSSProperties;
  radius?: string | number;
  /** Its edit popover is open. */
  open?: boolean;
  /** Changes when series join or leave the section: only then do cards glide to their new places. */
  layoutKey?: string;
  /** The cover's own shape, once its picture has loaded. */
  onRatio?: (id: string, ratio: number) => void;
  onOpen: (book: ShelfItem, rect: DOMRect) => void;
  onEdit: (book: ShelfItem, anchor: HTMLElement) => void;
  onFinish?: (book: ShelfItem, finished: boolean) => void;
  onKeep?: (book: ShelfItem) => void;
}

/**
 * A manga series as its cover, with its title and the chapter the reader is on. A series without a
 * cover (or whose cover won't load) gets one drawn in its colour. The cover opens it; the corner
 * button (or a right-click) edits it, as on the books' cards.
 */
export function CoverCard({ item, index, enter, caption, ratio = COVER, className = '', style, radius = '6px 14px 14px 6px', open = false, layoutKey, onRatio, onOpen, onEdit, onFinish, onKeep }: Props) {
  const b = item.book;
  const moreRef = useRef<HTMLButtonElement>(null);
  const artRef = useRef<HTMLDivElement>(null);
  const [broken, setBroken] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const n = cardNames(b, item.author);
  const chapter = chapterText(b);
  const drawn = !b.coverUrl || broken;
  const openIt = () => {
    if (artRef.current) onOpen(b, artRef.current.getBoundingClientRect());
  };

  const words = (
    <>
      <span className="cv-title">{n.title}</span>
      <span className="cv-ch">{chapter}</span>
    </>
  );

  return (
    <motion.div
      className={`tile-slot cv cv-${caption}${drawn ? ' is-drawn' : ''} ${className}`}
      style={{ ...style, ...bookVars(b) }}
      // The library's first appearance rises in; a series added or put back later settles in place.
      initial={enter ? { opacity: 0, y: 18 } : { opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.2 } }}
      transition={{ ...springs.smooth, delay: enter ? Math.min(index, 24) * 0.028 : 0 }}
      layout="position"
      layoutDependency={layoutKey}
    >
      <div
        ref={artRef}
        className="cv-art"
        style={{ borderRadius: radius, ...(caption === 'under' ? { aspectRatio: ratio } : null) }}
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
            onLoad={(e) => {
              setLoaded(true);
              const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
              if (w && h && onRatio) onRatio(b.id, w / h);
            }}
            onError={() => setBroken(true)}
          />
        )}
        {caption === 'over' && <span className="cv-words" aria-hidden="true">{words}</span>}
        <button
          type="button"
          className="tile-hit"
          data-id={b.id}
          aria-label={`${b.title}, ${chapter}`}
          onClick={(e) => onOpen(b, (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect())}
        />
        <Tools book={b} open={open} moreRef={moreRef} onEdit={onEdit} onFinish={onFinish} onKeep={onKeep} />
      </div>
      {/* The cover's button says all this; the words under it open the series too, for a pointer. */}
      {caption === 'under' && <div className="cv-cap" aria-hidden="true" onClick={openIt}>{words}</div>}
    </motion.div>
  );
}
