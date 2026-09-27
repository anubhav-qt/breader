import type { SeriesLook } from './series';
import { Spines } from './Spines';
import { Tile, type TileProps } from './Tile';
import type { SectionProps } from './types';

type Props = TileProps & { look: SeriesLook; onSeries: SectionProps['onSeries'] };

/** A card on the bento or the wall: a book, or a whole series in the design being tried. */
export function Card({ look, onSeries, ...p }: Props) {
  const s = p.item.kind === 'series' ? p.item.series : undefined;
  if (!s) return <Tile {...p} />;
  if (look === 'spines') {
    return (
      <Spines
        ref={p.ref}
        series={s}
        index={p.index}
        enter={p.enter}
        className={p.className}
        style={p.style}
        radius={p.radius}
        open={p.open}
        layoutKey={p.layoutKey}
        onOpen={p.onOpen}
        onEdit={p.onEdit}
      />
    );
  }
  return <Tile {...p} series={s} onOpen={(_, rect) => onSeries(s, rect)} />;
}
