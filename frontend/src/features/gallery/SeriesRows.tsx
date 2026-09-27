import { motion } from 'motion/react';
import type { ShelfItem } from '../../data/useLibrary';
import { finishedIn, numberOf, type Series } from './series';
import { Tile } from './Tile';

interface Props {
  list: Series[];
  now: number;
  enter: boolean;
  indexBase: number;
  editingId?: string;
  onOpen: (book: ShelfItem, rect: DOMRect) => void;
  onEdit: (book: ShelfItem, anchor: HTMLElement) => void;
}

const H = 270;
const W = 196;

/** Each series as a row of its books in order, below Recent (the rows design). */
export function SeriesRows({ list, now, enter, indexBase, editingId, onOpen, onEdit }: Props) {
  return (
    <div className="srows">
      {list.map((s, j) => (
        <section key={s.key} className="wall-group">
          <header className="wall-head">
            <span>{s.name}</span>
            <span className="wall-count">{finishedIn(s)} of {s.books.length} finished</span>
          </header>
          <motion.div className="srow" layoutScroll>
            {s.books.map((b, k) => {
              const key = b.key ?? b.id;
              return (
                <Tile
                  key={key}
                  item={{ kind: 'book', key, book: b }}
                  variant="cover"
                  index={indexBase + j * 3 + k}
                  enter={enter}
                  now={now}
                  radius="8px 18px 18px 8px"
                  className="srow-tile"
                  style={{ width: W, height: H }}
                  number={numberOf(s, b)}
                  open={key === editingId}
                  onOpen={onOpen}
                  onEdit={onEdit}
                />
              );
            })}
          </motion.div>
        </section>
      ))}
    </div>
  );
}
