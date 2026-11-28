import { useRef, useState } from 'react';
import { genreIds, genreName } from '@breader/shared/genres';
import { IconCheck, IconPlus } from '../../components/icons';
import { Modal } from '../../components/Modal';
import type { ShelfItem } from '../../data/useLibrary';
import { duration, minutesFor } from '../../lib/format';
import { cardNames, markFor } from '../gallery/names';
import { bookVars } from '../gallery/vars';
import '../gallery/covers.css';
import '../manga/manga.css';
import './publicBook.css';

interface Props {
  /** The book as its row shows it. */
  book: ShelfItem;
  /** The library its row is. */
  from: string;
  /** The reader's own copy, if they have one: how far they are decides Read or Carry on. */
  mine?: ShelfItem;
  /** The name of the reader's own books, Personal or as they named it. */
  personal: string;
  onRead: (rect: DOMRect) => void;
  onAddTo: () => void;
  onClose: () => void;
}

/** What the book is, in one line: its series and number, how long it takes, the library it's in. */
function metaOf(b: ShelfItem, from: string): string[] {
  const parts: string[] = [];
  if (b.series) {
    let series = b.series;
    if (b.seriesIndex) series = `${b.series}, book ${b.seriesIndex}`;
    parts.push(series);
  }
  // Too short to take a minute: nothing to say about how long.
  if (minutesFor(b.words) >= 1) parts.push(duration(minutesFor(b.words)));
  parts.push(from);
  return parts;
}

/**
 * A book from a Public row: its cover and what it is, as a manga's page opens. Read
 * opens it; Add to puts it in any library the reader may change. A manga series opens its own page.
 */
export function PublicBook({ book: b, from, mine, personal, onRead, onAddTo, onClose }: Props) {
  const coverRef = useRef<HTMLDivElement>(null);
  // A cover that won't load: the drawn one instead, as on its card.
  const [broken, setBroken] = useState(false);
  const drawn = !b.coverUrl || broken;
  const n = cardNames(b);
  const genres = genreIds(b.genre).map((id) => genreName(id) ?? id);
  let readLabel = 'Read';
  if (mine && mine.progress > 0) readLabel = 'Carry on';
  const inPersonal = !!mine && !mine.sharedOnly;

  const read = () => {
    const rect = coverRef.current?.getBoundingClientRect() ?? new DOMRect();
    onRead(rect);
  };

  return (
    <Modal title={b.title} onClose={onClose} width={680} className="pb">
      <div className="mds-top pb-top">
        <div className="mds-cover pb-cover" ref={coverRef}>
          {drawn ? (
            <span className="cv is-drawn pb-drawn" style={bookVars(b)} aria-hidden="true">
              <span className="cv-art">
                <span className="cv-drawn">
                  <span className="cv-by">{n.author}</span>
                  <span className="cv-mark">{markFor(n.title, n.vol)}</span>
                </span>
                <span className="cv-words"><span className="cv-title">{n.title}</span></span>
              </span>
            </span>
          ) : (
            <img src={b.coverUrl} alt="" draggable={false} onError={() => setBroken(true)} />
          )}
        </div>
        <div className="mds-info">
          <h1 className="mds-title">{n.title}</h1>
          {n.author && <p className="mds-by">{n.author}</p>}
          <p className="mds-meta">{metaOf(b, from).join(' · ')}</p>
          {genres.length > 0 && (
            <div className="mds-tags">
              {genres.map((g) => <span key={g} className="chip">{g}</span>)}
            </div>
          )}
        </div>
        <div className="mds-actions">
          <button type="button" className="btn btn-primary" onClick={read}>{readLabel}</button>
          <button type="button" className="btn btn-quiet" onClick={onAddTo}><IconPlus /><span> Add to</span></button>
          {inPersonal && <span className="mds-in"><IconCheck /><span>{` In ${personal}`}</span></span>}
        </div>
      </div>
    </Modal>
  );
}
