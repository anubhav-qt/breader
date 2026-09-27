import type { PDFDocumentProxy } from 'pdfjs-dist';

export type Format = 'EPUB' | 'PDF' | 'TXT' | 'MD' | 'Text';

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

export type LoadedBook = FlowBook | PdfBook;

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
   * shelf: a book on the Shared Library this reader hasn't started; starting it makes a copy here.
   */
  source: 'file' | 'sample' | 'placeholder' | 'shelf';
  url?: string;
  shared: boolean;
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
  /** A copy of a book on the Shared Library: that book's id. Its file stays the sharer's. */
  origin?: string;
  /** The series its file names, and its number in it. */
  series?: string;
  seriesIndex?: number;
}

/** Changes a reader makes to a book's card: name, colour, favourite. */
export interface BookEdit {
  title?: string;
  color?: string;
  favorite?: boolean;
  /** The reader's own series for it; '' takes it out of the one its file names. */
  series?: string;
  seriesIndex?: number;
}

export interface ReadState {
  pos?: Position;
  progress: number;
  line: string;
  lastOpened: number;
  words?: number;
}
