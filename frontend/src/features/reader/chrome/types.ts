import type { RefObject } from 'react';
import type { LoadedBook, TocItem } from '../../../books/types';
import type { Chapter } from '../chapters';
import type { Loc } from '../FlowView';
import type { Paragraph } from '../narration';
import type { ReaderSettings } from '../settings';

export type PanelName = 'toc' | 'look' | 'voice' | 'paras';

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
  /** Reading aloud, where the browser can: a tap on play, and the voice sheet's own button. `listening` is an Immersive voice speaking. */
  narration: { playing: boolean; listening: boolean; toggle: () => void; start: () => void; stop: () => void } | null;
  /**
   * Immersive on a book whose words can light up (pacing.ts): `running` while the light moves on
   * its own, `waiting` while nothing is lit yet. Begin (`choose`) numbers the paragraphs, and
   * `choosing`, the reader starts from the top of the page or picks one by its number.
   */
  immersion: {
    running: boolean;
    waiting: boolean;
    choosing: boolean;
    choose: () => void;
    cancel: () => void;
    fromTop: () => void;
    /** The chapter's paragraphs while choosing, and the first one on screen. */
    paragraphs: Paragraph[];
    nowAt?: number;
    pick: (p: Paragraph) => void;
  } | null;
  /** Focus mode: everything but the text hides until the mouse moves or a tap mid-page. */
  focus: { on: boolean; toggle: () => void };
}

export const toItem = (c: Chapter): TocItem => ({ title: c.title, section: c.section, anchor: c.anchor, level: 0 });
