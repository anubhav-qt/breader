import { useState } from 'react';
import { IconEye } from '../../components/icons';
import type { ShelfItem } from '../../data/useLibrary';
import { readLocal, writeLocal } from '../../lib/store';
import { CoverCard } from './CoverCard';
import { Tile } from './Tile';
import type { SectionProps } from './types';

/*
 * Manga's library, by its covers, which matter more for manga than for books: the series being
 * read, big, then every other one as its cover, the one read last first.
 */

/** Only the covers, without their titles: off until the reader turns it on, then kept on this device. */
const COVERS_ONLY = 'breader.manga.coversOnly.v1';

type Props = Omit<SectionProps, 'items' | 'indexBase'> & { books: ShelfItem[] };

export function MangaLibrary({ books, ...shared }: Props) {
  const [coversOnly, setCoversOnly] = useState(() => readLocal<unknown>(COVERS_ONLY, false) === true);
  const [reading, ...rest] = books;
  // Only when series join or leave the wall do its covers glide to their new places.
  const layoutKey = rest.map((b) => b.key ?? b.id).join('|');

  const flip = () => {
    const next = !coversOnly;
    setCoversOnly(next);
    writeLocal(COVERS_ONLY, next);
  };

  return (
    <>
      <section className="mg-top" aria-label="Reading now">
        <div className="gallery-top" />
        <Tile
          item={{ key: reading.key ?? reading.id, book: reading }}
          variant="hero"
          manga
          art
          index={0}
          enter={shared.enter}
          now={shared.now}
          radius={26}
          className="mg-hero"
          open={(reading.key ?? reading.id) === shared.editingId}
          onOpen={shared.onOpen}
          onEdit={shared.onEdit}
          onFinish={shared.onFinish}
          onKeep={shared.onKeep}
        />
      </section>
      {rest.length > 0 && (
        <section className="mg-wall" aria-label="Your manga">
          <div className="mg-tools">
            <button
              type="button"
              className="mg-eye"
              aria-label="Only covers"
              aria-pressed={coversOnly}
              title={coversOnly ? 'Show the titles' : 'Only the covers'}
              onClick={flip}
            >
              <IconEye />
            </button>
          </div>
          <div className="cv-wall">
            {rest.map((b, i) => (
              <CoverCard
                key={b.key ?? b.id}
                item={{ key: b.key ?? b.id, book: b }}
                words={!coversOnly}
                // The entrance follows the covers in order, after the one being read.
                index={i + 1}
                enter={shared.enter}
                open={(b.key ?? b.id) === shared.editingId}
                layoutKey={layoutKey}
                onOpen={shared.onOpen}
                onEdit={shared.onEdit}
                onFinish={shared.onFinish}
                onKeep={shared.onKeep}
              />
            ))}
          </div>
        </section>
      )}
    </>
  );
}
