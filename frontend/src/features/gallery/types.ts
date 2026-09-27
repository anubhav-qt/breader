import type { ShelfItem } from '../../data/useLibrary';
import type { Series, SeriesLook } from './series';

export interface GalleryItem {
  kind: 'book' | 'series';
  key: string;
  /** The book on the card; a series card's is the one to read now. */
  book: ShelfItem;
  series?: Series;
}

export interface SectionProps {
  items: GalleryItem[];
  now: number;
  enter: boolean;
  /** Offsets the entrance stagger, so a lower section follows the one above it. */
  indexBase?: number;
  /** The book whose edit popover is open. */
  editingId?: string;
  look: SeriesLook;
  onOpen: (book: ShelfItem, rect: DOMRect) => void;
  onEdit: (book: ShelfItem, anchor: HTMLElement) => void;
  /** A series card that opens to its books (the stack design). */
  onSeries: (series: Series, rect: DOMRect) => void;
}
