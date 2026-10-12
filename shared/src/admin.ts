import { z } from 'zod';

/*
 * What the admin page changes, kept in one row of admin_state (server/src/lib/admin.ts) and read
 * by whoever it's for: the AI marker's settings (ai/tools/marker.ts), the worker's jobs switched
 * off (server/src/worker.ts), and the marker's queue, books kept back by hand and books asked to
 * go next. Each is read afresh every few seconds, so a change takes hold without a restart.
 */

export const MARKER_TASKS = ['marks', 'music', 'notes'] as const;
export type MarkerTask = (typeof MARKER_TASKS)[number];

export const FIRST_MODELS = ['kimi-k3', 'nemotron'] as const;
export type FirstModel = (typeof FIRST_MODELS)[number];

/** The longest a failed book waits before it's tried again, in minutes, as the page offers them. */
export const RETRY_CAPS = [15, 60, 360] as const;
/** Books at once, for each task. */
export const AT_ONCE_MAX = 8;

export interface MarkerSettings {
  paused: boolean;
  tasks: Record<MarkerTask, boolean>;
  atOnce: Record<MarkerTask, number>;
  /** The model that marks and writes first; the other is the backup. */
  first: FirstModel;
  /** Web research before marks, music and notes, on Antigravity. */
  research: boolean;
  /** A failed book waits 2 minutes, doubling each time, up to this many. */
  retryCapMinutes: number;
}

export const MARKER_DEFAULTS: MarkerSettings = {
  paused: false,
  tasks: { marks: true, music: true, notes: true },
  atOnce: { marks: 4, music: 2, notes: 2 },
  first: 'kimi-k3',
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
}

export const ADMIN_DEFAULTS: AdminState = { marker: MARKER_DEFAULTS, jobsOff: [], held: [], next: [] };

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
    first: z.enum(FIRST_MODELS),
    research: z.boolean(),
    retryCapMinutes: z.number().int().min(1).max(24 * 60),
  })
  .partial()
  .strict();

/** What can be done to a book in the queue, or one being worked on. */
export const QueueAction = z.object({
  action: z.enum(['next', 'hold', 'retry', 'stop', 'redo']),
  id: z.string().regex(/^[0-9a-f]{64}$/),
  task: Task,
  /** For hold: kept back, or let go. */
  held: z.boolean().optional(),
});
export type QueueAction = z.infer<typeof QueueAction>;

/** The row as it's kept, with anything missing or out of shape taken from the defaults. */
export function adminStateOf(raw: unknown): AdminState {
  const r = (raw ?? {}) as Partial<AdminState>;
  const m = (r.marker ?? {}) as Partial<MarkerSettings>;
  const parsed = MarkerPatch.safeParse({ ...m });
  const marker: MarkerSettings = { ...MARKER_DEFAULTS, ...(parsed.success ? parsed.data : {}) };
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return { marker, jobsOff: strings(r.jobsOff), held: strings(r.held), next: strings(r.next) };
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
