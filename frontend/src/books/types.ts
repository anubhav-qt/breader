import type { PDFDocumentProxy } from 'pdfjs-dist';

/** CBZ: a manga or comic, its pages as pictures in a zip. */
export type Format = 'EPUB' | 'PDF' | 'TXT' | 'MD' | 'Text' | 'CBZ';

/** One chapter-sized chunk of a reflowable book, already sanitised. */
export interface Section {
  title: string;
  html: string;
  words: number;
}

export interface TocItem {
  title: string;
  section: number;
  anchor?: string;
  level: number;
}

export interface FlowBook {
  kind: 'flow';
  title: string;
  author: string;
  sections: Section[];
  toc: TocItem[];
  words: number;
  cover?: Blob;
  /** The series the file says it belongs to. */
  series?: { name: string; index?: number };
  /** What the file says it's about, as a shop shelves it: "Fiction / Fantasy / Epic". */
  subjects?: string[];
  cleanup?: () => void;
}

export interface PdfBook {
  kind: 'pdf';
  title: string;
  author: string;
  doc: PDFDocumentProxy;
  pages: number;
  toc: TocItem[];
  words: number;
  cleanup?: () => void;
}

/** A manga or comic: its pages are pictures, out of the file one at a time as they're read. */
export interface MangaBook {
  kind: 'manga';
  title: string;
  author: string;
  pages: number;
  /** Page i's picture. */
  page(i: number): Promise<Blob>;
  /** Page i's size in pixels from its file's first bytes, or null when they don't say. */
  size(i: number): Promise<{ w: number; h: number } | null>;
  toc: TocItem[];
  words: number;
  series?: { name: string; index?: number };
  subjects?: string[];
  cleanup?: () => void;
}

export type LoadedBook = FlowBook | PdfBook | MangaBook;

/** A place in a book: section, block (paragraph-level element) and character offset in that block. */
export interface Position {
  section: number;
  block: number;
  offset: number;
}

export interface BookRecord {
  id: string;
  title: string;
  author: string;
  format: Format;
  /**
   * file: stored in this browser. sample: bundled public-domain file. placeholder: preview data only.
   * shelf: a book in someone's shared library this reader hasn't started; starting it makes a copy here.
   * remote: a series read from a catalogue like MangaDex, through the laptop, by its url.
   */
  source: 'file' | 'sample' | 'placeholder' | 'shelf' | 'remote';
  /** A sample's bundled file, or a remote book's series (mangadex:<id>, and :<language> when not English). */
  url?: string;
  shared: boolean;
  /** Taken out of the reader's own books but left in their shared library. */
  sharedOnly?: boolean;
  addedAt: number;
  words: number;
  /** A palette key from data/colors.ts. */
  color: string;
  hasCover?: boolean;
  /** Seed reading state; the stored ReadState wins once the book has been opened. */
  progress: number;
  line: string;
  lastOpened: number;
  /** Server ids of the stored file and cover, once uploaded. */
  fileId?: string;
  coverId?: string;
  /** A copy of a book someone shared: the first book's id, however many copies away. Its file stays the sharer's. */
  origin?: string;
  /** The series its file names, and its number in it. */
  series?: string;
  seriesIndex?: number;
  /** The genres it was added with (shared genres.ts), joined by commas: the uploader's picks. */
  genre?: string;
}

/** Changes a reader makes to a book's card: name, colour, favourite. */
export interface BookEdit {
  title?: string;
  color?: string;
  favorite?: boolean;
  /** The reader's own series for it; '' takes it out of the one its file names. */
  series?: string;
  seriesIndex?: number;
  /** The reader's own genres for it; '' files it under none, whatever it was added with. */
  genre?: string;
  /** Lets an AI read along, for Revisit and 2 voices. */
  ai?: boolean;
}

export interface ReadState {
  pos?: Position;
  progress: number;
  line: string;
  lastOpened: number;
  words?: number;
  /** Words read so far: pages turned forward, not jumps. Only grows. */
  wordsRead?: number;
  /** How far the reader has really read, whatever page the book is open at (reader/mark.ts). */
  mark?: ReadMark;
}

/** The furthest place read on purpose. n counts the times the book has been read again. */
export interface ReadMark {
  pos: Position;
  progress: number;
  line: string;
  n?: number;
}
