import { useMemo } from 'react';
import { AnimatePresence } from 'motion/react';
import { useElementWidth } from '../useElementWidth';
import { Tile, type Variant } from '../Tile';
import type { GalleryItem, SectionProps } from '../types';

const GAP = 14;
const ROW_H = 236;
/** The shapes a card can take, so rows mix portraits, squares and panoramas. */
const ASPECTS = [0.68, 1.55, 1, 0.68, 2.15, 1.3, 0.68, 1.55, 1];

/** Each book keeps one shape, so the wall doesn't reshape every card as books come and go. */
function aspectFor(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return ASPECTS[Math.abs(h) % ASPECTS.length];
}

function variantFor(a: number): Variant {
  if (a < 0.8) return 'cover';
  if (a < 1.8) return 'square';
  return 'wide';
}

/**
 * Justified rows: each row closes where its height lands closest to ROW_H, then scales to fill
 * the width exactly. The last row keeps the target height.
 */
function justify(aspects: number[], width: number) {
  const out: Array<{ w: number; h: number }> = [];
  const place = (row: number[], h: number, fill: boolean) => {
    const gaps = GAP * (row.length - 1);
    let used = 0;
    row.forEach((j, k) => {
      const w = fill && k === row.length - 1 ? width - gaps - used : Math.floor(aspects[j] * h);
      used += w;
      out[j] = { w, h };
    });
  };
  let row: number[] = [];
  let sum = 0;
  aspects.forEach((a, i) => {
    const hWith = (width - GAP * row.length) / (sum + a);
    if (row.length && hWith < ROW_H) {
      const hWithout = (width - GAP * (row.length - 1)) / sum;
      if (hWithout - ROW_H < ROW_H - hWith) {
        place(row, hWithout, true);
        row = [i];
        sum = a;
        return;
      }
      row.push(i);
      place(row, hWith, true);
      row = [];
      sum = 0;
      return;
    }
    row.push(i);
    sum += a;
  });
  if (row.length) place(row, ROW_H, false);
  return out;
}

const DAY = 86_400_000;

/** Coarser groups than the timeline's, so rows have enough books to justify. */
function wallGroup(t: number, now: number): string {
  const d = new Date(t);
  const n = new Date(now);
  const days = (now - t) / DAY;
  if (days < 7) return 'This week';
  if (days < 14) return 'Last week';
  if (d.getFullYear() === n.getFullYear()) {
    return d.getMonth() === n.getMonth() ? 'Earlier this month' : d.toLocaleDateString('en-GB', { month: 'long' });
  }
  return String(d.getFullYear());
}

export function Wall({ items, now, enter, indexBase = 0, editingId, onOpen, onEdit }: SectionProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>();

  const groups = useMemo(() => {
    const out: Array<{ label: string; items: Array<{ item: GalleryItem; i: number }> }> = [];
    items.forEach((item, i) => {
      const label = wallGroup(item.book.lastOpened, now);
      if (!out.length || out[out.length - 1].label !== label) out.push({ label, items: [] });
      out[out.length - 1].items.push({ item, i });
    });
    return out;
  }, [items, now]);
  const layoutKey = items.map((it) => it.key).join('|');

  return (
    <div ref={ref} className="wall">
      {width > 0 && groups.map((g) => {
        const aspects = g.items.map(({ item }) => aspectFor(item.key));
        const sizes = justify(aspects, width - 1);
        const books = g.items.length;
        return (
          <section key={g.label} className="wall-group">
            <header className="wall-head">
              <span>{g.label}</span>
              <span className="wall-count">{books} {books === 1 ? 'book' : 'books'}</span>
            </header>
            <div className="wall-rows">
              <AnimatePresence mode="popLayout" initial={false}>
                {g.items.map(({ item, i }, k) => (
                  <Tile
                    key={item.key}
                    item={item}
                    variant={variantFor(aspects[k])}
                    index={indexBase + i}
                    enter={enter}
                    now={now}
                    radius={aspects[k] < 0.8 ? '8px 18px 18px 8px' : 20}
                    className="wall-tile"
                    style={{ width: sizes[k].w, height: sizes[k].h }}
                    open={item.key === editingId}
                    layoutKey={layoutKey}
                    onOpen={onOpen}
                    onEdit={onEdit}
                  />
                ))}
              </AnimatePresence>
            </div>
          </section>
        );
      })}
    </div>
  );
}
