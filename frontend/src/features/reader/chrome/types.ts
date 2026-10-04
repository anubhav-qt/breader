import type { RefObject } from 'react';
import type { RevisitResponse } from '@breader/shared/ai';
import type { LoadedBook, TocItem } from '../../../books/types';
import type { Chapter } from '../chapters';
import type { TalkView } from './Comments';
import type { Loc } from '../FlowView';
import type { Paragraph, Sentence } from '../narration';
import type { BarAsk } from '../focus';
import type { Block, Found } from '../search';
import type { Asleep } from '../sleep';
import type { ReaderSettings } from '../settings';

/** `revisit` is the drop up from the bottom line; `recap` the window it opens (chrome/Revisit.tsx). */
export type PanelName = 'toc' | 'look' | 'voice' | 'paras' | 'sleep' | 'find' | 'revisit' | 'recap' | 'comments';

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
  /**
   * Reading aloud, where the browser can. `listening` is an Immersive voice speaking. `toggle` is
   * play up top, `read` and `stop` the voice sheet's button; `hush` and `resume` pause it while a
   * word is asked about (SayAs).
   */
  narration: {
    playing: boolean;
    listening: boolean;
    toggle: () => void;
    read: () => void;
    stop: () => void;
    hush: () => void;
    resume: () => void;
  } | null;
  /**
   * Immersive on a book whose words can light up (pacing.ts): `running` while the light moves on
   * its own, `waiting` while Begin is on the bottom line. Begin (`choose`) numbers the paragraphs,
   * and `choosing`, the reader starts from the top of the page, or once `begun` (or a book read
   * before), carries on, or picks one by its number.
   */
  immersion: {
    running: boolean;
    waiting: boolean;
    choosing: boolean;
    begun: boolean;
    choose: () => void;
    cancel: () => void;
    fromTop: () => void;
    carryOn: () => void;
    /** The chapter's paragraphs while choosing, and the first one on screen. */
    paragraphs: Paragraph[];
    nowAt?: number;
    pick: (p: Paragraph) => void;
  } | null;
  /**
   * Focus mode: everything but the text hides until the mouse moves or a tap mid-page. `ask`: the
   * voice bar, left on its own, asking whether to hide too (focus.ts).
   */
  focus: { on: boolean; toggle: () => void; ask: BarAsk | null };
  /** Finding words in the book (search.ts): its text, read once (hearing how far it's got), and going to a match. */
  search: { read: (onRead?: (done: number, of: number) => void) => Promise<Block[]>; go: (f: Found) => void } | null;
  /** Did you sleep? What's being asked, going back to a checkpoint, and carrying on (sleep.ts). */
  sleep: { asked: Asleep; back: (s: Sentence) => void; awake: () => void } | null;
  /** Revisit, once an AI has read the book (ai.ts): how far the reader has really read, and the notes up to there. */
  revisit: { read: number; load: () => Promise<{ notes: RevisitResponse; offline: boolean }> } | null;
  /** 2 voices for this book: ready (an AI marked who says what), soon (its switch is on), or off. */
  two: 'ready' | 'soon' | 'off';
  /**
   * Comments on the book (comments.ts), for the speech bubble a PDF has in place of the tail:
   * `opens` says whether a chapter's thread is open to them yet, `at` is the thread the drop opens
   * on (BOOK_THREAD, or a chapter's first section; the chapter being read if not said).
   */
  talk: {
    view: TalkView;
    opens: (i: number) => boolean;
    at?: number;
    open: (section?: number) => void;
  };
}

export const toItem = (c: Chapter): TocItem => ({ title: c.title, section: c.section, anchor: c.anchor, level: 0 });
