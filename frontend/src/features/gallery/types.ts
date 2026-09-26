import type { ShelfItem } from '../../data/useLibrary';

export interface GalleryItem {
  kind: 'book';
  key: string;
  book: ShelfItem;
}

export interface SectionProps {
  items: GalleryItem[];
  now: number;
  enter: boolean;
  /** Offsets the entrance stagger, so a lower section follows the one above it. */
  indexBase?: number;
  /** The book whose edit popover is open. */
  editingId?: string;
  onOpen: (book: ShelfItem, rect: DOMRect) => void;
  onEdit: (book: ShelfItem, anchor: HTMLElement) => void;
}
