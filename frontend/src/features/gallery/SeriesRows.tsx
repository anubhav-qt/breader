import { motion } from 'motion/react';
import type { ShelfItem } from '../../data/useLibrary';
import { finishedIn, numberOf, type Series } from './series';
import { ROW_H } from './layouts/Wall';
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

/** Covers as tall as the wall's rows beside them. */
const H = ROW_H;
const W = Math.round(ROW_H * 0.72);

/** Each series as a row of its books in order, sideways scrolling. */
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
                  item={{ key, book: b }}
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
