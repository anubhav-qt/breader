import type { AiAccount } from '@breader/shared/accounts';
import type { Stage, StagePick } from '@breader/shared/admin';

export type { Stage, StagePick };

/*
 * What the admin page shows, as /admin/stream pushes it (server/src/routes/admin.ts): the server's
 * status, the AI marker's own report with the page's settings (ai/tools/marker.ts, Live) and the
 * AI accounts (shared/src/accounts.ts).
 */

export type Task = 'marks' | 'music' | 'notes';

export const TASK_NAMES: Record<Task, string> = { marks: 'Voice marks', music: 'Music', notes: 'Revisit notes' };

/** One step of a task, as the marker goes through it. */
export interface Step {
  key: string;
  name: string;
  /** What it does, in a sentence. */
  about: string;
  /** Done part by part: its parts show as dots. */
  parts?: boolean;
}

/** Every step of each task, in order (ai/tools/mark.ts, music.ts and notes.ts). */
export const STEPS: Record<Task, Step[]> = {
  marks: [
    { key: 'fetch', name: 'Fetching the book', about: 'Takes the book’s file from the file store and splits it into its parts.' },
    { key: 'research', name: 'Researching it on the web', about: 'Gemini, on an Antigravity account, looks up the book and its series: who’s in it, and how each of them talks.' },
    { key: 'cast', name: 'Reading the cast from the book', about: 'Lists everyone who speaks, by the names the book gives them as it goes.' },
    { key: 'mark', name: 'Marking who speaks, part by part', about: 'Every line gets its speaker. The first model marks the parts; the second takes one while the first is down.', parts: true },
    { key: 'check', name: 'Checking the marks', about: 'Looks for lines with no speaker or the wrong one, and fixes them, a round at a time.' },
    { key: 'redo', name: 'Marking again what the backup model did', about: 'The parts the second model marked go to the first again, so the whole book is marked the same way.', parts: true },
    { key: 'settle', name: 'Settling unsure lines', about: 'Lines the two models read differently are asked about twice more, and the answer that agrees wins.' },
    { key: 'voices', name: 'Casting the voices', about: 'Everyone gets a voice of each model, the same one they had in the series’ earlier books.' },
    { key: 'save', name: 'Saving', about: 'Packs the marks and puts them on the server, where readers’ phones fetch them.' },
  ],
  music: [
    { key: 'fetch', name: 'Fetching the book', about: 'Takes the book’s file from the file store and splits it into its parts.' },
    { key: 'research', name: 'Researching it on the web', about: 'Gemini, on an Antigravity account, looks up the book and its series, for the score to follow.' },
    { key: 'gather', name: 'Gathering the soundtrack', about: 'Gemini picks the series’ soundtrack once, from its first volume, and finds each track on YouTube.' },
    { key: 'plan', name: 'Planning the score', about: 'Decides where the music changes through the book: the moods, and which track carries each.' },
    { key: 'score', name: 'Scoring, part by part', about: 'Each part gets its cues: where a track starts, fades, or goes quiet.', parts: true },
    { key: 'check', name: 'Checking the score', about: 'Looks for cues that clash or tracks that can’t be played, and fixes them.' },
    { key: 'store', name: 'Keeping its tracks', about: 'Downloads the tracks the score plays and keeps them in the file store.' },
    { key: 'save', name: 'Saving', about: 'Puts the score into the book’s file on the server.' },
  ],
  notes: [
    { key: 'fetch', name: 'Fetching the book', about: 'Takes the book’s file from the server and the book from the file store, and checks they read the same.' },
    { key: 'research', name: 'Researching it on the web', about: 'Gemini, on an Antigravity account, looks up the book and its series, for the notes to lean on.' },
    { key: 'roster', name: 'Listing who’s who', about: 'Starts from the earlier volumes’ notes: everyone, and what’s already known about them.' },
    { key: 'write', name: 'Writing notes, part by part', about: 'The first model writes Revisit’s notes for each part, knowing only what the reader has read by then.', parts: true },
    { key: 'check', name: 'Checking the notes', about: 'Looks for anything said before the book says it, and for names that drift, and fixes them.' },
    { key: 'review', name: 'Reading them over', about: 'One last pass over the whole book’s notes, for what reads oddly next to the rest.' },
    { key: 'save', name: 'Saving', about: 'Puts the notes on the server, where Revisit reads them.' },
  ],
};

/** Music scored somewhere else and uploaded here, going into its book. */
export const UPLOAD_STEPS: Step[] = [
  { key: 'read', name: 'Reading the uploaded music', about: 'Takes the upload from the file store and checks it fits the book’s file.' },
  { key: 'store', name: 'Keeping its tracks', about: 'Downloads the tracks the score plays and keeps them in the file store.' },
  { key: 'save', name: 'Saving', about: 'Puts the score into the book’s file on the server.' },
];

/** The steps a working book goes through. */
export function stepsFor(w: { task: Task; upload?: boolean }): Step[] {
  if (w.upload) return UPLOAD_STEPS;
  return STEPS[w.task];
}

/** A part of a book being worked on: done, being done, done by the backup model, or still to do. */
export type PartState = 'done' | 'now' | 'backup' | 'wait';

export interface LogLine {
  at: string;
  text: string;
  bad?: boolean;
}

export interface Working {
  /** The book file's SHA-256. */
  id: string;
  title: string;
  task: Task;
  /** Music uploaded from here, going in: UPLOAD_STEPS. */
  upload?: boolean;
  /** The step it's on, by its key in STEPS. */
  step: string;
  /** Steps it doesn't take this time, by key: research, while it's off. */
  skipped: string[];
  /** When it started the book, and the step it's on. */
  since: string;
  stepSince: string;
  /** Its parts, while a step goes part by part. */
  parts: PartState[];
  /** Who's doing the step: a model, and the account it's on. */
  model: string | null;
  account: string | null;
  /** Calls to the model waiting for an answer. */
  calls: number;
  /** What it did, newest first. */
  log: LogLine[];
}

export interface Waiting {
  id: string;
  title: string;
  task: Task;
  /** Why it's still waiting, when it isn't just its turn. */
  waitsFor?: string;
  failed?: { times: number; next: string; why: string };
  /** Kept back by hand until let go. */
  held?: boolean;
  /** The readers it's the first book of: it goes before every book that isn't one. */
  first?: string[];
}

/** A reader with more than one book waiting, and which goes first. */
export interface ReaderLine {
  /** Their library's id. */
  id: string;
  name: string;
  /** Their books with anything left, in the order they go. */
  books: Array<{ id: string; title: string }>;
  /** Their first book, and why: picked here, picked by them, or their only book that can go. */
  first: string | null;
  by: 'page' | 'reader' | 'only' | null;
  /** What was picked here, and what they picked, while it's still waiting. */
  page: string | null;
  picked: string | null;
}

/** What can be changed about the marker from here. */
export interface MarkerSettings {
  paused: boolean;
  /** Each task on or off. */
  tasks: Record<Task, boolean>;
  /** How many books at once, for each task. */
  atOnce: Record<Task, number>;
  /** The NVIDIA model that marks and writes first, by its id there; the second steps in while it's down. */
  first: string;
  second: string;
  /** Web research before marking and music, on Antigravity. */
  research: boolean;
  /** A failed book waits 2 minutes, doubling each time, up to this many. */
  retryCapMinutes: number;
}

export interface Marker {
  /** When it last said how it's doing. */
  at: string;
  books: number;
  finished: number;
  working: Working[];
  queue: Waiting[];
  /** Every Antigravity account is out of Gemini until then. */
  limitedUntil?: string;
  /** No Antigravity account at all, so music waits for one. */
  musicWaitsForAccount?: boolean;
  /** Readers with more than one book waiting (missing from a marker that doesn't say yet). */
  readers?: ReaderLine[];
  settings: MarkerSettings;
  /** Who does each stage for books to come, and for single books, where the page picked. */
  stages?: Partial<Record<Stage, StagePick>>;
  stagesFor?: Record<string, Partial<Record<Stage, StagePick>>>;
  /** NVIDIA's models as the marker last checked them (ai/tools/models.ts). */
  models?: Models | null;
}

/** One check of an NVIDIA model: did it answer, and how fast. */
export interface ModelCheck {
  at: string;
  ok: boolean;
  kind?: string;
  why?: string;
  /** Seconds to the first token. */
  firstS?: number;
  secs?: number;
  /** Tokens a second once it started. */
  tps?: number;
}

export interface ModelLine {
  id: string;
  seenAt: string;
  goneAt?: string;
  noChat?: boolean;
  /** Newest first. */
  checks: ModelCheck[];
}

export interface Models {
  firstListAt: string | null;
  listedAt: string | null;
  sweptAt: string | null;
  checking: string | null;
  models: ModelLine[];
  /** Antigravity's Gemini models, newest first. */
  gemini?: string[];
}

/** The stages that ask a model, each task's in order, with what they're called here. */
export const STAGES: Record<Task, Stage[]> = {
  marks: ['research', 'marks.cast', 'marks.mark', 'marks.check', 'marks.redo', 'marks.settle', 'marks.voices'],
  music: ['research', 'music.gather', 'music.plan', 'music.score', 'music.check'],
  notes: ['research', 'notes.roster', 'notes.write', 'notes.check', 'notes.review'],
};
/** Stages done with tools: Gemini's unless picked otherwise. */
export const TOOL_STAGES: Stage[] = ['research', 'music.gather'];

/** A stage's step, as STEPS names it. */
export function stageStep(stage: Stage): Step {
  if (stage === 'research') return STEPS.marks[1];
  const [task, key] = stage.split('.') as [Task, string];
  return STEPS[task].find((s) => s.key === key)!;
}

export interface Job {
  name: string;
  last_ok_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  /** Running right now. */
  running: boolean;
  /** Switched off from here. */
  off: boolean;
}

export interface Status {
  server: { role: 'laptop' | 'fallback'; release: string; uptimeSeconds: number; sentry: boolean };
  request: { ip: string; from: string; headers: Record<string, string> };
  supabase: { bytes: number; freeBytes: number; timeline: string | null } | null;
  feed: { rows: number; unread: number; oldest_unread: number | null; ack: number | null } | null;
  copy: { lag: number | null; loaded_at: string | null; down?: boolean } | null;
  libraries: { total: number; key_only: number; active_week: number; expiring: number; retired: number } | null;
  books: { books: number; removed: number } | null;
  files: { byStatus: Array<{ status: string; files: number; bytes: number; unused: number }>; freeBytes: number };
  jobs: Job[];
}

/** Everything the page shows, as the server last pushed it. */
export interface Snapshot {
  status: Status;
  marker: Marker | null;
  accounts: AiAccount[] | null;
}

/** How the page is hearing from the server: live, getting there, or turned away for its token. */
export type Link = 'live' | 'connecting' | 'denied';

/** What the page can ask of the server. */
export interface Admin {
  /**
   * Calls `on` with everything now, and again each time anything changes, `link` as the stream
   * comes and goes, and `error` when a button's request fails. Gives back a way to stop.
   */
  watch: (on: (s: Snapshot) => void, link?: (l: Link) => void, error?: (message: string) => void) => () => void;
  settings: (patch: Partial<MarkerSettings>) => void;
  /** Who does these stages: for these books, or (no ids) for books to come. Null puts a stage back to the usual. */
  stages: (picks: Partial<Record<Stage, StagePick | null>>, ids?: string[]) => void;
  /** NVIDIA's models checked now: all of them, or one. */
  checkModels: (id?: string) => void;
  /** A waiting book: next in line, kept back or let go, or tried again now. */
  next: (id: string, task: Task) => void;
  hold: (id: string, task: Task, held: boolean) => void;
  retry: (id: string, task: Task) => void;
  /** A working book: back to the queue, kept back, or its step from the start. */
  stop: (id: string, task: Task) => void;
  redoStep: (id: string, task: Task) => void;
  /** A reader's first book picked here, or (null) left to them. */
  first: (library: string, id: string | null) => void;
  runJob: (name: string) => void;
  jobOn: (name: string, on: boolean) => void;
  /** An account used before the others, or no more. */
  useFirst: (id: string) => void;
  removeAccount: (id: string) => Promise<void>;
  startSignIn: (kind: string) => Promise<{ url: string; state: string }>;
  finishSignIn: (state: string, address: string) => Promise<void>;
  uploadMusic: (text: string) => Promise<string>;
}
