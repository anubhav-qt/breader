import { useMemo, type RefObject } from 'react';
import type { ShelfItem } from '../../data/useLibrary';
import { CoverCard } from './CoverCard';
import { Bento } from './layouts/Bento';
import { RECENT } from './layouts/slots';
import type { MangaLayout } from './mangaLayouts';
import { Posters } from './Posters';
import type { Series } from './series';
import { Row, Shelves } from './Shelves';
import type { Shelf, View } from './shelving';
import { Tile } from './Tile';
import type { GalleryItem, SectionProps } from './types';

/*
 * Manga's library, set out by its covers, which matter more for manga than for books, one of four
 * ways (mangaLayouts.ts).
 */

/** Series in the Recent row, after the one being read. */
const RECENT_ROW = 12;

/** Manga has no series of books, and no one's names to put on them. */
const NO_SERIES = new Map<string, Series>();
const NO_NAMES = new Map<string, string>();
const noSeries = () => {};

type Props = Omit<SectionProps, 'items' | 'indexBase'> & {
  layout: MangaLayout;
  books: ShelfItem[];
  /** Which library, for the view its shelves keep. */
  place: string;
  view: View;
  /** The library's scroller, which brings in more shelves. */
  root: RefObject<HTMLElement | null>;
};

export function MangaLibrary({ layout, books, place, view, root, ...shared }: Props) {
  const items = useMemo(() => books.map((b): GalleryItem => ({ key: b.key ?? b.id, book: b })), [books]);

  if (layout === 'wall') {
    return (
      <section className="cv-wall" aria-label="Your manga">
        {items.map((item, i) => (
          <CoverCard
            key={item.key}
            item={item}
            caption="under"
            index={i}
            enter={shared.enter}
            open={(item.book.key ?? item.book.id) === shared.editingId}
            onOpen={shared.onOpen}
            onEdit={shared.onEdit}
            onFinish={shared.onFinish}
            onKeep={shared.onKeep}
          />
        ))}
      </section>
    );
  }

  if (layout === 'posters') return <Posters books={books} {...shared} />;

  // The rest: what's on top, then every series again by genre or date once there's more than that.
  const top = layout === 'bento' ? RECENT : 1 + RECENT_ROW;
  const more = books.length > top;
  const shelves = more && (
    <Shelves
      books={books}
      stacks={NO_SERIES}
      series={NO_SERIES}
      authors={NO_NAMES}
      place={place}
      initial={view}
      views={['genre', 'date']}
      root={root}
      indexBase={top}
      onSeries={noSeries}
      covers={layout === 'bento' ? 'over' : 'under'}
      {...shared}
    />
  );

  if (layout === 'bento') {
    return (
      <>
        <section className="recent" aria-label="Recent">
          {more ? <div className="gallery-head"><span>Recent</span></div> : <div className="gallery-top" />}
          <Bento items={items.slice(0, RECENT)} covers {...shared} />
        </section>
        {shelves}
      </>
    );
  }

  // The series being read, big, then the others read lately in a row of covers.
  const [reading, ...rest] = items;
  const recent: Shelf = {
    key: 'recent',
    name: 'Recent',
    meta: '',
    entries: rest.slice(0, RECENT_ROW).map((it) => ({ key: it.key, book: it.book })),
  };
  return (
    <>
      <section className="mg-top" aria-label="Reading now">
        <div className="gallery-top" />
        <Tile
          item={reading}
          variant="hero"
          manga
          art
          index={0}
          enter={shared.enter}
          now={shared.now}
          radius={26}
          className="mg-hero"
          open={(reading.book.key ?? reading.book.id) === shared.editingId}
          onOpen={shared.onOpen}
          onEdit={shared.onEdit}
          onFinish={shared.onFinish}
          onKeep={shared.onKeep}
        />
      </section>
      {recent.entries.length > 0 && (
        <div className="mg-recent">
          <Row shelf={recent} index={0} authors={NO_NAMES} indexBase={1} onSeries={noSeries} covers="under" {...shared} />
        </div>
      )}
      {shelves}
    </>
  );
}
