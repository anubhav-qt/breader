import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react';
import { animate, motion, useMotionValue } from 'motion/react';
import type { ShelfItem } from '../../data/useLibrary';
import { springs } from '../../lib/springs';
import { IconMore, IconStar } from '../../components/icons';
import { blotsFor, maskFor, radiiFor } from './blots';
import { numberOf, type Series } from './series';
import { actionLabel, progressText, shortProgress, when } from './text';
import type { GalleryItem } from './types';
import { useSize } from './useSize';
import { bookVars } from './vars';

export type Variant = 'hero' | 'square' | 'wide' | 'tall' | 'small' | 'cover';

export interface TileProps {
  item: GalleryItem;
  variant: Variant;
  index: number;
  enter: boolean;
  now: number;
  /** Show the book's cover, when it has one and the card has room. Only the two most recent do. */
  art?: boolean;
  className?: string;
  style?: CSSProperties;
  radius?: string | number;
  /** Its edit popover is open. */
  open?: boolean;
  /** Changes when books join or leave the section: only then do cards glide to their new places. */
  layoutKey?: string;
  /** A whole series on one card, its other books peeking out behind (the stack design). */
  series?: Series;
  /** The book's number in its series, on a card in a series row. */
  number?: number;
  ref?: Ref<HTMLDivElement>;
  onOpen: (book: ShelfItem, rect: DOMRect) => void;
  onEdit: (book: ShelfItem, anchor: HTMLElement) => void;
}

/** Shrinks a card's title until its longest word fits on a line, so words never break. */
function fitTitle(tile: HTMLElement | null) {
  const titles = tile ? Array.from(tile.querySelectorAll<HTMLElement>('.t-title')) : [];
  if (!titles.length) return;
  titles.forEach((t) => t.style.removeProperty('font-size'));
  const t = titles[0];
  for (let i = 0; i < 3; i++) {
    const cs = getComputedStyle(t);
    const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const room = t.clientWidth - pad;
    const need = t.scrollWidth - pad;
    if (need <= room + 0.5 || room <= 0) return;
    const size = `${Math.floor(parseFloat(cs.fontSize) * (room / need) * 10) / 10}px`;
    titles.forEach((el) => el.style.setProperty('font-size', size));
  }
}

function setMask(el: HTMLElement | null, mask: string) {
  if (!el) return;
  el.style.setProperty('-webkit-mask-image', mask);
  el.style.setProperty('mask-image', mask);
}

/**
 * One book card. It starts in the page's own colour with a contrasting border; the book's colour
 * fills it in patches as it is read. The same content is drawn twice: once in page colours, once
 * in the book's colour and ink, masked to the patches, so text stays legible over both.
 *
 * A full-size button opens the book; the corner button (or a right-click) opens the edit popover.
 */
export function Tile({ item, variant, index, enter, now, art = false, className = '', style, radius = 22, open = false, layoutKey, series, number, ref: slotRef, onOpen, onEdit }: TileProps) {
  const b = item.book;
  // A stack names its series where the author would be; a card in a series row, its number.
  const tag = series
    ? { byline: `${series.name} · ${numberOf(series, b)} of ${series.books.length}` }
    : { meta: number !== undefined ? `Book ${number}` : undefined };
  const behind = series ? series.books.filter((x) => x !== b).slice(0, 2) : [];
  const [ref, size] = useSize<HTMLDivElement>();
  const inkRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const done = b.progress >= 1;
  const blots = useMemo(() => blotsFor(b.id), [b.id]);
  const radii = useMemo(() => radiiFor(blots, done ? 1 : b.progress, size.w, size.h), [blots, done, b.progress, size.w, size.h]);
  const radiiRef = useRef(radii);
  radiiRef.current = radii;
  // The cover keeps its own proportions, so it is never cropped.
  const [artRatio, setArtRatio] = useState(2 / 3);

  // Blots grow in from nothing when the library first appears.
  const grow = useMotionValue(enter ? 0 : 1);
  useEffect(() => {
    if (!enter) return;
    const run = animate(grow, 1, { ...springs.smooth, delay: 0.3 + Math.min(index, 24) * 0.03 });
    return () => run.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const apply = (k: number) => setMask(inkRef.current, done && k > 0.995 ? 'none' : maskFor(blots, radiiRef.current, k));
  useEffect(() => grow.on('change', apply));
  useLayoutEffect(() => { apply(grow.get()); });

  const hasArt = art && !!b.coverUrl && (variant === 'hero' || variant === 'square');
  const started = b.progress > 0;
  useLayoutEffect(() => fitTitle(ref.current), [ref, size.w, size.h, b.title, variant, hasArt, artRatio, started]);
  useEffect(() => {
    let live = true;
    void document.fonts.ready.then(() => { if (live) fitTitle(ref.current); });
    return () => { live = false; };
  }, [ref]);

  return (
    <motion.div
      ref={slotRef}
      className={`tile-slot ${className}`}
      style={{ ...style, borderRadius: radius }}
      // The library's first appearance rises in; a book added or put back later settles in place.
      initial={enter ? { opacity: 0, y: 18 } : { opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.2 } }}
      transition={{ ...springs.smooth, delay: enter ? Math.min(index, 24) * 0.028 : 0 }}
      layout="position"
      layoutDependency={layoutKey}
    >
      {/* Its other books, finished ones in their colour, peek out above the card. */}
      {behind.map((x, k) => (
        <span key={x.id} className={`tile-behind is-${k}${x.progress >= 1 ? ' is-read' : ''}`} style={bookVars(x)} aria-hidden="true" />
      ))}
      <div
        ref={ref}
        className={`tile tile-${variant}${hasArt ? ' has-art' : ''}`}
        style={{ ...bookVars(b), ...(hasArt ? { '--art-ratio': artRatio } : null) } as CSSProperties}
        onContextMenu={(e) => {
          if (!moreRef.current) return;
          e.preventDefault();
          if (!open) onEdit(b, moreRef.current);
        }}
      >
        <div className="tile-face"><TileContent book={b} variant={variant} now={now} {...tag} /></div>
        {started && (
          <div ref={inkRef} className="tile-face is-ink" aria-hidden="true">
            <TileContent book={b} variant={variant} now={now} {...tag} />
          </div>
        )}
        <button
          type="button"
          className="tile-hit"
          data-id={b.id}
          aria-label={series ? `${series.name}, ${series.books.length} books. Next: ${b.title}, ${progressText(b)}` : `${b.title}, ${progressText(b)}`}
          onClick={(e) => onOpen(b, (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect())}
        />
        {hasArt && (
          <span className="tile-art">
            <img
              src={b.coverUrl}
              alt=""
              draggable={false}
              onLoad={(e) => {
                const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
                if (w && h) setArtRatio(w / h);
              }}
            />
          </span>
        )}
        <div className="tile-tools">
          {b.favorite && <span className="tile-fav" title="Favourite"><IconStar /></span>}
          <button
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
          </button>
        </div>
      </div>
    </motion.div>
  );
}

/**
 * Every card that is wide enough ends on the same thing: the line where the reader stopped (the
 * opening line for a new book), in one style. CSS hides it on cards too narrow or short for it.
 */
const Line = ({ book }: { book: ShelfItem }) => (book.line ? <span className="t-line">{book.line}</span> : null);

function TileContent({ book: b, variant, now, byline, meta }: { book: ShelfItem; variant: Variant; now: number; byline?: string; meta?: string }): ReactNode {
  const title = <span className="t-title">{b.title}</span>;
  const top = when(b, now);
  const by = byline ?? b.author;
  const short = meta ? `${meta} · ${shortProgress(b)}` : shortProgress(b);
  const push = <span className="t-title t-push">{b.title}</span>;
  switch (variant) {
    case 'hero':
      return (
        <>
          <span className="t-eyebrow">{top}</span>
          {title}
          <span className="t-author">{by}</span>
          <Line book={b} />
          <span className="t-foot">
            <span className="t-meta">{progressText(b)}</span>
            <span className="t-cta">{actionLabel(b)} ›</span>
          </span>
        </>
      );
    case 'square':
      return (
        <>
          <span className="t-eyebrow">{top}</span>
          {title}
          <span className="t-sub">
            <span className="t-author">{by}</span>
            <span className="t-meta">{short}</span>
          </span>
          <Line book={b} />
        </>
      );
    case 'wide':
      return (
        <>
          <span className="t-col">
            <span className="t-eyebrow">{top}</span>
            {title}
            <span className="t-sub">
              <span className="t-author">{by}</span>
              <span className="t-meta">{short}</span>
            </span>
          </span>
          <Line book={b} />
        </>
      );
    // Narrow cards keep the top for progress, beside the corner button, and set the title below.
    case 'tall':
      return (
        <>
          <span className="t-big">{shortProgress(b)}</span>
          {push}
          <span className="t-author">{by}</span>
          <Line book={b} />
        </>
      );
    case 'small':
      return (
        <>
          <span className="t-meta">{short}</span>
          {push}
          <Line book={b} />
        </>
      );
    case 'cover':
      return (
        <>
          <span className="t-meta">{short}</span>
          {push}
          <span className="t-author">{by}</span>
          <Line book={b} />
        </>
      );
  }
}
