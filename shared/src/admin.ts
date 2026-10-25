import { z } from 'zod';

/*
 * What the admin page changes, kept in one row of admin_state (server/src/lib/admin.ts) and read
 * by whoever it's for: the AI marker's settings (ai/tools/marker.ts), the worker's jobs switched
 * off (server/src/worker.ts), and the marker's queue: books kept back by hand, books asked to go
 * next, and each reader's first book when the page picks it for them. Each is read afresh every few seconds, so a change takes hold without a restart.
 */

export const MARKER_TASKS = ['marks', 'music', 'notes'] as const;
export type MarkerTask = (typeof MARKER_TASKS)[number];

/** An NVIDIA model by its id there: "moonshotai/kimi-k2.6". */
const NIM_ID = /^[\w.-]+\/[\w.:-]+$/;
/** Antigravity's Gemini models, through CLIProxyAPI: "gemini-3.8-flash-high". */
const GEMINI_ID = /^gemini-[\w.-]+$/;

/** The models the page offered before it listed NVIDIA's, and theirs now. */
const OLD_FIRST: Record<string, string> = { 'kimi-k3': 'moonshotai/kimi-k2.6', nemotron: 'nvidia/nemotron-3-ultra-550b-a55b' };

/**
 * An NVIDIA model's name in CLIProxyAPI, which serves NVIDIA's models beside Antigravity's
 * (server/src/jobs/cliproxy.ts), so the harness can work with them: no slash, as it goes in a path.
 */
export const nimAlias = (id: string) => `nim-${id.replace(/\//g, '--')}`;

/*
 * The pipeline's stages that ask a model, each task's in order. Research is one stage for all
 * three: a book is researched once. Research and gathering the soundtrack work with tools (the
 * harness, ai/tools/harness.ts); the rest read the book and answer (the balancer).
 */
export const STAGES = {
  marks: ['research', 'marks.cast', 'marks.mark', 'marks.check', 'marks.redo', 'marks.settle', 'marks.voices'],
  music: ['research', 'music.gather', 'music.plan', 'music.score', 'music.check'],
  notes: ['research', 'notes.roster', 'notes.write', 'notes.check', 'notes.review'],
} as const;
export type Stage = (typeof STAGES)[MarkerTask][number];
export const ALL_STAGES: Stage[] = [...new Set(Object.values(STAGES).flat())];
/** Stages done with tools, on Gemini unless the page says otherwise. */
export const HARNESS_STAGES: readonly Stage[] = ['research', 'music.gather'];

/**
 * Who does a stage: NVIDIA or Gemini, and which model. No model is the usual order: NVIDIA's first
 * and second models (the marker's settings), or Gemini 3.8 Flash and then the newest.
 */
export interface StagePick {
  provider: 'nim' | 'gemini';
  model?: string;
}

/** The longest a failed book waits before it's tried again, in minutes, as the page offers them. */
export const RETRY_CAPS = [15, 60, 360] as const;
/** Books at once, for each task. */
export const AT_ONCE_MAX = 8;

export interface MarkerSettings {
  paused: boolean;
  tasks: Record<MarkerTask, boolean>;
  atOnce: Record<MarkerTask, number>;
  /** The NVIDIA model that marks and writes first, by its id there. */
  first: string;
  /** The one that steps in while the first is down. */
  second: string;
  /** Web research before marks, music and notes, on Antigravity. */
  research: boolean;
  /** A failed book waits 2 minutes, doubling each time, up to this many. */
  retryCapMinutes: number;
}

export const MARKER_DEFAULTS: MarkerSettings = {
  paused: false,
  tasks: { marks: true, music: true, notes: true },
  atOnce: { marks: 4, music: 2, notes: 2 },
  first: 'moonshotai/kimi-k2.6',
  second: 'nvidia/nemotron-3-ultra-550b-a55b',
  research: true,
  retryCapMinutes: 60,
};

export interface AdminState {
  marker: MarkerSettings;
  /** The worker's jobs switched off, by name. */
  jobsOff: string[];
  /** Books kept back from a task, by queueKey. */
  held: string[];
  /** Books asked to go next in their task, by queueKey, the latest asked first. */
  next: string[];
  /**
   * Each reader's first book as the page picked it, by library id: a file's SHA-256. It goes over
   * the reader's own pick (ai_first) for as long as the reader still has it waiting.
   */
  firstFor: Record<string, string>;
  /** Who does each stage for books to come, where the page picked. */
  stages: Partial<Record<Stage, StagePick>>;
  /** Who does each stage for one book, over `stages`, by its file's SHA-256. */
  stagesFor: Record<string, Partial<Record<Stage, StagePick>>>;
}

export const ADMIN_DEFAULTS: AdminState = { marker: MARKER_DEFAULTS, jobsOff: [], held: [], next: [], firstFor: {}, stages: {}, stagesFor: {} };

/** Books with stages of their own, at most: the oldest go first. */
export const STAGES_FOR_KEPT = 500;

/** Who does a stage for a book: its own pick, the page's for books to come, or null for the usual. */
export function stagePick(s: Pick<AdminState, 'stages' | 'stagesFor'>, stage: Stage, id?: string): StagePick | null {
  return (id ? s.stagesFor[id]?.[stage] : undefined) ?? s.stages[stage] ?? null;
}

/** A book in one task's queue: its file's SHA-256 and the task. */
export const queueKey = (id: string, task: MarkerTask) => `${id}:${task}`;

const Task = z.enum(MARKER_TASKS);
const PerTask = <T extends z.ZodTypeAny>(t: T) => z.object({ marks: t, music: t, notes: t });

/** A change to the marker's settings, as the page sends it. */
export const MarkerPatch = z
  .object({
    paused: z.boolean(),
    tasks: PerTask(z.boolean()),
    atOnce: PerTask(z.number().int().min(1).max(AT_ONCE_MAX)),
    first: z.string().regex(NIM_ID),
    second: z.string().regex(NIM_ID),
    research: z.boolean(),
    retryCapMinutes: z.number().int().min(1).max(24 * 60),
  })
  .partial()
  .strict();

const PickSchema = z
  .object({ provider: z.enum(['nim', 'gemini']), model: z.string().max(200).optional() })
  .strict()
  .refine((p) => !p.model || (p.provider === 'nim' ? NIM_ID : GEMINI_ID).test(p.model), 'not a model of that provider');

/**
 * Who does which stages, from the page: for these books (`ids`), or for books to come (no ids). A
 * stage given null goes back to the usual.
 */
export const StagesAction = z.object({
  ids: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(STAGES_FOR_KEPT).optional(),
  picks: z.partialRecord(z.enum(ALL_STAGES as [Stage, ...Stage[]]), PickSchema.nullable()),
});
export type StagesAction = z.infer<typeof StagesAction>;

/** The page's stages changed as `a` says. */
export function withStages(s: AdminState, a: StagesAction): AdminState {
  const put = (into: Partial<Record<Stage, StagePick>>) => {
    const out = { ...into };
    for (const [k, v] of Object.entries(a.picks) as Array<[Stage, StagePick | null]>) {
      if (v) out[k] = v;
      else delete out[k];
    }
    return out;
  };
  if (!a.ids) return { ...s, stages: put(s.stages) };
  const stagesFor = { ...s.stagesFor };
  for (const id of a.ids) {
    const mine = put(stagesFor[id] ?? {});
    delete stagesFor[id];
    if (Object.keys(mine).length) stagesFor[id] = mine;
  }
  const ids = Object.keys(stagesFor);
  for (const id of ids.slice(0, Math.max(0, ids.length - STAGES_FOR_KEPT))) delete stagesFor[id];
  return { ...s, stagesFor };
}

/** What can be done to a book in the queue, or one being worked on. */
export const QueueAction = z.object({
  action: z.enum(['next', 'hold', 'retry', 'stop', 'redo']),
  id: z.string().regex(/^[0-9a-f]{64}$/),
  task: Task,
  /** For hold: kept back, or let go. */
  held: z.boolean().optional(),
});
export type QueueAction = z.infer<typeof QueueAction>;

/** A reader's first book picked from the page, or the page's pick taken back (id null). */
export const FirstAction = z.object({
  library: z.string().min(1).max(200),
  id: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
});
export type FirstAction = z.infer<typeof FirstAction>;

/** The row as it's kept, with anything missing or out of shape taken from the defaults. */
export function adminStateOf(raw: unknown): AdminState {
  const r = (raw ?? {}) as Partial<AdminState>;
  const m = { ...((r.marker ?? {}) as Partial<MarkerSettings>) };
  if (m.first && OLD_FIRST[m.first]) {
    m.first = OLD_FIRST[m.first];
    m.second = Object.values(OLD_FIRST).find((x) => x !== m.first);
  }
  const parsed = MarkerPatch.safeParse(m);
  const marker: MarkerSettings = { ...MARKER_DEFAULTS, ...(parsed.success ? parsed.data : {}) };
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const firstFor: Record<string, string> = {};
  if (r.firstFor && typeof r.firstFor === 'object') {
    for (const [lib, sha] of Object.entries(r.firstFor)) if (typeof sha === 'string') firstFor[lib] = sha;
  }
  const picks = (v: unknown) => {
    const out: Partial<Record<Stage, StagePick>> = {};
    if (!v || typeof v !== 'object') return out;
    for (const [k, p] of Object.entries(v)) {
      if (ALL_STAGES.includes(k as Stage) && PickSchema.safeParse(p).success) out[k as Stage] = p as StagePick;
    }
    return out;
  };
  const stagesFor: AdminState['stagesFor'] = {};
  if (r.stagesFor && typeof r.stagesFor === 'object') {
    for (const [id, v] of Object.entries(r.stagesFor)) {
      const mine = picks(v);
      if (Object.keys(mine).length) stagesFor[id] = mine;
    }
  }
  return { marker, jobsOff: strings(r.jobsOff), held: strings(r.held), next: strings(r.next), firstFor, stages: picks(r.stages), stagesFor };
}

/**
 * A task's books in the order they go: the ones asked to go next first, the latest asked at the
 * top, then the rest as they were.
 */
export function nextFirst<T>(books: T[], keyOf: (b: T) => string, next: string[]): T[] {
  const rank = (b: T) => {
    const i = next.indexOf(keyOf(b));
    if (i < 0) return Infinity;
    return i;
  };
  return books
    .map((b, i) => ({ b, i }))
    .sort((x, y) => {
      const a = rank(x.b);
      const b = rank(y.b);
      if (a !== b) return a - b;
      return x.i - y.i;
    })
    .map((x) => x.b);
}
