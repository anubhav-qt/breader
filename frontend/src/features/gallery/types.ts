import type { ShelfItem } from '../../data/useLibrary';

export interface GalleryItem {
  key: string;
  book: ShelfItem;
  /** The name its series goes by, when its file credits someone else first. */
  author?: string;
}

export interface SectionProps {
  items: GalleryItem[];
  now: number;
  enter: boolean;
  /** The book whose edit popover is open. */
  editingId?: string;
  /** Picking books to favourite or remove together: the ones ticked. Absent while not picking. */
  picked?: ReadonlySet<string>;
  onOpen: (book: ShelfItem, rect: DOMRect) => void;
  onEdit: (book: ShelfItem, anchor: HTMLElement) => void;
  /** Puts a book from someone's shared library in the reader's own, without opening it. */
  onKeep?: (book: ShelfItem) => void;
}
