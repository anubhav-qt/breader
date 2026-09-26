import type { RefObject } from 'react';
import type { LoadedBook, TocItem } from '../../../books/types';
import type { Chapter } from '../chapters';
import type { Loc } from '../FlowView';
import type { ReaderSettings } from '../settings';

export type PanelName = 'toc' | 'look';

/** Everything the reader's controls get from the reader shell. */
export interface ChromeProps {
  book: LoadedBook;
  /** The reader's own name for the book, if they renamed it. */
  title?: string;
  loc: Loc | null;
  chapters: Chapter[];
  /** Index of the chapter holding the reader's place. */
  current: number;
  settings: ReaderSettings;
  update: (fn: (s: ReaderSettings) => ReaderSettings) => void;
  isPdf: boolean;
  panel: PanelName | null;
  lastPanel: PanelName;
  openPanel: (p: PanelName | null) => void;
  /** Width of the text on screen: one column, or both pages of a spread. Also --pw in CSS. */
  pageW: number;
  canRemove: boolean;
  onBack: () => void;
  onRemove: () => void;
  onGo: (item: TocItem) => void;
  /** A click on a progress track: the chapter there, or that exact spot when there are no chapters. */
  onPick: (fraction: number) => void;
  /** The reader's positioned area, for pointer maths and state classes. */
  body: RefObject<HTMLDivElement | null>;
  /** Going back to the library: anything that should leave first, leaves now. */
  closing: boolean;
}

export const toItem = (c: Chapter): TocItem => ({ title: c.title, section: c.section, anchor: c.anchor, level: 0 });
