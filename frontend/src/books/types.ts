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
  /** file: stored in this browser. sample: bundled public-domain file. placeholder: preview data only. */
  source: 'file' | 'sample' | 'placeholder';
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
}

/** Changes a reader makes to a book's card: name, colour, favourite. */
export interface BookEdit {
  title?: string;
  color?: string;
  favorite?: boolean;
}

export interface ReadState {
  pos?: Position;
  progress: number;
  line: string;
  lastOpened: number;
  words?: number;
}
