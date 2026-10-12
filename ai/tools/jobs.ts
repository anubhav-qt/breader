import { AsyncLocalStorage } from 'node:async_hooks';

/*
 * What each book the marker is working on is doing right now, for the admin page: the calls it has
 * out, the model and account they're on, the parts being done, and what it printed. Every call for
 * a book is made inside its job (marker.ts, start), so the balancer and the harness find it without
 * being told.
 *
 * The admin page can pause the marker, or one of its tasks: calls wait before they're asked
 * (whilePaused), and the ones out finish. It can stop a book: its job's signal aborts, so calls
 * waiting give up and calls out are cut off (Stopped).
 */

export interface LogLine {
  at: string;
  text: string;
  bad?: boolean;
}

export interface JobCtx {
  key: string;
  title: string;
  /** Its task, which the admin page can pause by itself. */
  group: string;
  controller: AbortController;
  /** Calls out now, and how many of them for each part. */
  calls: number;
  parts: Map<number, number>;
  /** Who the last call went to. */
  model: string | null;
  account: string | null;
  /** What it printed, oldest first. */
  log: LogLine[];
}

/** How many lines of each job's log are kept. */
export const LOG_KEPT = 40;
const PAUSED_LOOK_MS = 2_000;

const store = new AsyncLocalStorage<JobCtx>();

export function newJob(key: string, title: string, group: string): JobCtx {
  return { key, title, group, controller: new AbortController(), calls: 0, parts: new Map(), model: null, account: null, log: [] };
}

/** Runs `fn` as the job's: every call it makes, however deep, counts as the job's. */
export const runIn = <T>(job: JobCtx, fn: () => Promise<T>): Promise<T> => store.run(job, fn);
export const current = () => store.getStore();

/** Thrown in a job the admin page stopped. */
export class Stopped extends Error {
  constructor() {
    super('stopped from the admin page');
  }
}

/** Throws when the job this runs in was stopped. */
export function stopIfStopped() {
  if (current()?.controller.signal.aborted) throw new Stopped();
}

/** The admin page's pause: everything, or some tasks by themselves. */
export const pauses = { all: false, groups: new Set<string>() };

export function paused(group: string | undefined): boolean {
  if (pauses.all) return true;
  if (!group) return false;
  return pauses.groups.has(group);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits while the job's task is paused, and gives up when it's stopped. */
export async function whilePaused() {
  for (;;) {
    stopIfStopped();
    if (!paused(current()?.group)) return;
    await sleep(PAUSED_LOOK_MS);
  }
}

/** Counts a call out for the job, for part `part` when it's one part's: gives back how to say it's back. */
export function callOut(model: string, account: string, part: number | null): () => void {
  const job = current();
  if (!job) return () => {};
  job.calls++;
  job.model = model;
  job.account = account;
  if (part !== null) job.parts.set(part, (job.parts.get(part) ?? 0) + 1);
  return () => {
    job.calls--;
    if (part === null) return;
    const n = (job.parts.get(part) ?? 1) - 1;
    if (n > 0) job.parts.set(part, n);
    else job.parts.delete(part);
  };
}

/** The part a call is about, from its label (mark.ts part, music.ts music, notes.ts notes), or null. */
export function partOf(label: Record<string, unknown>): number | null {
  for (const k of ['part', 'music', 'notes']) {
    const v = label[k];
    if (typeof v === 'number') return v;
  }
  return null;
}

const TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} /;
const BAD = /fail|no answer|refus|error|couldn|can’t|can't|stopped|garbled|out of room/i;

/** A line printed while a job runs, into its log: without the time and the book's title, which the page shows already. */
export function note(job: JobCtx, line: string) {
  let text = line.replace(TIME, '').trim();
  if (text.startsWith(`${job.title}: `)) text = text.slice(job.title.length + 2);
  if (!text) return;
  const entry: LogLine = { at: new Date().toISOString(), text: text.slice(0, 300) };
  if (BAD.test(text)) entry.bad = true;
  job.log.push(entry);
  if (job.log.length > LOG_KEPT) job.log.splice(0, job.log.length - LOG_KEPT);
}
