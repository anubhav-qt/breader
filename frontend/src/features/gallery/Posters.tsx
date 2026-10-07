import { useCallback, useMemo, useState } from 'react';
import type { ShelfItem } from '../../data/useLibrary';
import { COVER, CoverCard } from './CoverCard';
import { byDate, type Entry } from './shelving';
import type { SectionProps } from './types';
import { useElementWidth } from './useElementWidth';

type Props = Omit<SectionProps, 'items' | 'indexBase'> & { books: ShelfItem[] };

/** Rows are this tall at most, a phone's lower; the covers in a row shrink a little to fill it exactly. */
const TALL = 250;
const PHONE_TALL = 156;

interface PosterRow {
  entries: Entry[];
  /** The covers' height in it. */
  h: number;
}

/**
 * Covers in rows, each at its own shape: as many as fit at the tallest a row can be, then all of
 * them shrunk together until they fill the row's width exactly. The last row stays at the tallest,
 * from the left, rather than blowing a few covers up.
 */
function rowsOf(entries: Entry[], ratioOf: (e: Entry) => number, width: number, tall: number, gap: number): PosterRow[] {
  const rows: PosterRow[] = [];
  let row: Entry[] = [];
  let sum = 0;
  for (const e of entries) {
    row.push(e);
    sum += ratioOf(e);
    const gaps = gap * (row.length - 1);
    if (sum * tall + gaps >= width) {
      rows.push({ entries: row, h: (width - gaps) / sum });
      row = [];
      sum = 0;
    }
  }
  if (row.length) rows.push({ entries: row, h: tall });
  return rows;
}

/** Every series as its cover, never cropped, in rows grouped by when it was last read. */
export function Posters({ books, now, enter, editingId, onOpen, onEdit, onFinish, onKeep }: Props) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  // Each cover's shape once it's loaded; a manga cover's usual one until then.
  const [ratios, setRatios] = useState<ReadonlyMap<string, number>>(() => new Map());
  const onRatio = useCallback((id: string, r: number) => {
    setRatios((m) => {
      const had = m.get(id);
      if (had !== undefined && Math.abs(had - r) < 0.01) return m;
      return new Map(m).set(id, r);
    });
  }, []);
  const ratioOf = (e: Entry) => ratios.get(e.book.id) ?? COVER;
  const groups = useMemo(() => byDate(books, now), [books, now]);
  const phone = width < 640;
  const tall = phone ? PHONE_TALL : TALL;
  const gap = phone ? 10 : 14;

  // The entrance follows the covers in order, group after group.
  let index = 0;
  return (
    <div ref={ref} className="posters">
      {width > 0 && groups.map((g) => {
        const layoutKey = g.entries.map((e) => e.key).join('|');
        return (
          <section key={g.key} className="poster-group" aria-label={g.name}>
            <header className="shelf-head">
              <h3 className="shelf-name"><span>{g.name}</span></h3>
              <span className="shelf-meta">{g.meta}</span>
            </header>
            {/* One run of covers, wrapping, each as wide as its row gives it: one moving to another row as shapes come in doesn't start over. */}
            <div className="poster-rows" style={{ columnGap: gap }}>
              {rowsOf(g.entries, ratioOf, width, tall, gap).flatMap((row) => row.entries.map((e) => {
                const r = ratioOf(e);
                // A hair narrower, so a row's rounding never pushes its last cover onto the next.
                const w = Math.floor(r * row.h * 100) / 100 - 0.01;
                return (
                  <CoverCard
                    key={e.key}
                    item={{ key: e.key, book: e.book }}
                    caption="under"
                    ratio={r}
                    index={index++}
                    enter={enter}
                    radius={10}
                    style={{ width: w }}
                    open={(e.book.key ?? e.book.id) === editingId}
                    layoutKey={layoutKey}
                    onRatio={onRatio}
                    onOpen={onOpen}
                    onEdit={onEdit}
                    onFinish={onFinish}
                    onKeep={onKeep}
                  />
                );
              }))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
