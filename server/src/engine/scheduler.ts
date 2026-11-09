/*
 * The scheduler (ADR 0002), in the API: which job runs next, and on which engine's worker. It knows
 * nothing of models' insides; a Runner reaches the engines (index.ts). So it's tested with a fake.
 *
 * - Two kinds of work, most urgent first: live reading, then panels. Audiobooks are made on
 *   readers' own devices, never here.
 * - Inside a kind, everyone waiting has a line, and the lines take turns, a job each.
 * - A reader's live sentences run one at a time, in order: the first then has the CPU to itself,
 *   and the next are still made well before it has been played.
 * - Live reading is kept fast. Workers on one machine slow each other (they share its memory), so
 *   panels take all but one worker, and a reader's first sentence starts at once.
 * - Each worker holds the models its jobs needed. A job goes to a free worker that holds its model,
 *   else to one with room to load it (letting go of what it used longest ago), else it waits. What's
 *   held on each engine stays under that engine's memory budget.
 * - An engine short of memory starts only live reading, and its free workers stop. With every
 *   engine short, panels waiting are turned away (the app finds those itself).
 * - With no engine up, live reading and panels are turned away at once.
 */

export type Kind = 'live' | 'panel';
export const KINDS: Kind[] = ['live', 'panel'];
/** How many lines' turns are kept once they're empty. */
const FORGET_AFTER = 1_000;

export interface Model {
  key: string;
  /** What a worker holding it uses, in MB. */
  mb: number;
}

/** What a worker is sent: the job, and the bytes it carries. */
export interface Payload {
  ask: unknown;
  bytes?: Uint8Array;
}

export interface Job {
  kind: Kind;
  /** Whose line it waits in. */
  who: string;
  model: Model | null;
  /** What the worker is sent. Made once a worker is free, so a job waiting holds nothing big. */
  body: () => Promise<Payload> | Payload;
}

export interface Runner {
  /** Runs a job on engine `host`'s worker `slot`, which first lets go of the models in `drop`. */
  run(host: number, slot: number, payload: Payload, drop: string[]): Promise<unknown>;
  /** Stops that worker, and what it holds. Started again by the next run. */
  stop(host: number, slot: number): void;
}

/** An engine as it says it is. */
export interface Host {
  workers: number;
  budgetMb: number;
  lowMb: number;
  freeMb: number;
  /** Changes when it starts again, its workers then holding nothing. */
  boot: string;
}

export interface Options {
  /** How many engines: each is down until `host()` says otherwise. */
  hosts: number;
  now?: () => number;
  /** Kept for live reading this long after a live job. */
  liveHoldMs?: number;
  /** A worker this long without a job stops. */
  idleMs?: number;
  /** Live jobs waiting beyond this many are turned away. */
  mostLive?: number;
  onLow?: (host: number, low: boolean, freeMb: number) => void;
}

export interface Stats {
  engines: Array<{ up: boolean; workers: number; started: number; busy: number; heldMb: number; budgetMb: number; freeMb: number; low: boolean; models: string[][] }>;
  waiting: Record<Kind, number>;
  /** Jobs done since start, by kind. */
  done: Record<Kind, number>;
}

interface Waiting {
  job: Job;
  resolve: (r: unknown) => void;
  reject: (e: Error) => void;
}

/** One line: someone's jobs, in the order they came. */
class Line {
  private readonly jobs: Waiting[] = [];

  get size() {
    return this.jobs.length;
  }

  push(w: Waiting) {
    this.jobs.push(w);
  }

  get head(): Waiting {
    return this.jobs[0];
  }

  shift(): Waiting {
    return this.jobs.shift()!;
  }

  all(): Waiting[] {
    return this.jobs;
  }
}

interface Slot {
  host: number;
  /** Its number on its engine. */
  n: number;
  busy: boolean;
  started: boolean;
  /** Models held, and when each was last used. */
  held: Map<string, { mb: number; used: number }>;
  /** When it last finished a job. */
  last: number;
  liveAt: number;
  /** The kind of job it runs now. */
  running: Kind | null;
}

interface Engine {
  info: Host | null;
  slots: Slot[];
  low: boolean;
}

export const busyError = (what: string) => Object.assign(new Error(what), { busy: true });
export const offError = (what: string) => Object.assign(new Error(what), { off: true });

export class Scheduler {
  private readonly engines: Engine[];
  /** Each kind's lines, in the order they take turns. */
  private readonly lines: Record<Kind, Map<string, Line>> = { live: new Map(), panel: new Map() };
  /** When each line last had a turn, counted in turns: the one that waited longest goes next. */
  private readonly served: Record<Kind, Map<string, number>> = { live: new Map(), panel: new Map() };
  private turn = 0;
  /** Readers with a live sentence running. */
  private readonly readingNow = new Set<string>();
  private readonly done: Record<Kind, number> = { live: 0, panel: 0 };
  private readonly runner: Runner;
  private readonly o: Options;
  private readonly now: () => number;
  private readonly liveHoldMs: number;
  private readonly idleMs: number;
  private readonly mostLive: number;

  constructor(runner: Runner, o: Options) {
    this.runner = runner;
    this.o = o;
    this.now = o.now ?? Date.now;
    this.liveHoldMs = o.liveHoldMs ?? 60_000;
    this.idleMs = o.idleMs ?? 10 * 60_000;
    this.mostLive = o.mostLive ?? 24;
    this.engines = Array.from({ length: o.hosts }, () => ({ info: null, slots: [], low: false }));
  }

  /** Jobs waiting of a kind, or in one line of it. */
  waiting(kind: Kind, who?: string): number {
    if (who !== undefined) return this.lines[kind].get(who)?.size ?? 0;
    let n = 0;
    for (const l of this.lines[kind].values()) n += l.size;
    return n;
  }

  private get up(): Engine[] {
    return this.engines.filter((e) => e.info);
  }

  /** No engine up, or every one short of memory. */
  get short(): boolean {
    return this.up.every((e) => e.low);
  }

  /**
   * What engine `h` says it is, or null when it can't be reached. A new size or a new start gives
   * it fresh workers; jobs running on the old ones finish or fail on their own.
   */
  host(h: number, info: Host | null) {
    const e = this.engines[h];
    const was = e.info;
    if (!info) {
      if (!was) return;
      e.info = null;
      e.slots = [];
      e.low = false;
      // Nowhere for live reading or panels to go: turned away now, not left waiting.
      if (!this.up.length) this.reject(['live', 'panel'], offError('No engine is running just now.'));
      return;
    }
    e.info = info;
    if (!was || was.boot !== info.boot || was.workers !== info.workers) {
      e.slots = Array.from({ length: Math.max(0, info.workers) }, (_, n) => ({ host: h, n, busy: false, started: false, held: new Map(), last: this.now(), liveAt: -Infinity, running: null }));
    }
    this.tick();
  }

  run(job: Job): Promise<unknown> {
    if (!this.up.length) return Promise.reject(offError('No engine is running just now.'));
    if (job.kind === 'live' && this.waiting('live') >= this.mostLive) return Promise.reject(busyError('The voice is busy.'));
    if (job.kind === 'panel' && this.short) return Promise.reject(busyError('The server is short of memory.'));
    return new Promise((resolve, reject) => {
      const lines = this.lines[job.kind];
      let line = lines.get(job.who);
      if (!line) {
        line = new Line();
        lines.set(job.who, line);
      }
      line.push({ job, resolve, reject });
      this.pump();
    });
  }

  private heldMb(e: Engine) {
    let mb = 0;
    for (const s of e.slots) for (const m of s.held.values()) mb += m.mb;
    return mb;
  }

  /**
   * How many workers of engine `e` panels may use just now. One worker is all it has, so it's
   * shared; else one is left for live reading.
   */
  private room(e: Engine): number {
    const n = e.slots.length;
    return n <= 1 ? n : n - 1;
  }

  /**
   * Where a job could run now, and what that worker lets go of first: a free worker holding its
   * model; else the free one that needs to let go of least (an empty one first) to stay in its
   * engine's budget.
   */
  private place(job: Job): { slot: Slot; drop: string[] } | null {
    const free: Slot[] = [];
    for (const e of this.up) {
      if (job.kind !== 'live') {
        if (e.low) continue;
        const others = e.slots.filter((s) => s.running && s.running !== 'live').length;
        if (others >= this.room(e)) continue;
      }
      for (const s of e.slots) if (!s.busy) free.push(s);
    }
    if (!free.length) return null;
    // Live reading to the workers that read live last (they hold the voice), the rest away from them.
    const older = (a: Slot, b: Slot) => (a.liveAt < b.liveAt ? -1 : a.liveAt > b.liveAt ? 1 : 0);
    free.sort(job.kind === 'live' ? (a, b) => older(b, a) : older);
    const m = job.model;
    if (!m) {
      // No model: a worker already running, the one holding least, so loaded ones stay for their work.
      const ready = free.filter((s) => s.started);
      const pool = ready.length ? ready : free;
      return { slot: pool.reduce((a, b) => (b.held.size < a.held.size ? b : a)), drop: [] };
    }
    const warm = free.find((s) => s.held.has(m.key));
    if (warm) return { slot: warm, drop: [] };
    let best: { slot: Slot; drop: string[]; mb: number } | null = null;
    for (const s of free) {
      const e = this.engines[s.host];
      const byAge = [...s.held.entries()].sort((a, b) => a[1].used - b[1].used);
      const drop: string[] = [];
      let total = this.heldMb(e);
      let freed = 0;
      // Let go of the oldest until it fits; a model on its own always fits, or nothing could run.
      while (total + m.mb > e.info!.budgetMb && total > 0 && byAge.length) {
        const [key, h] = byAge.shift()!;
        drop.push(key);
        total -= h.mb;
        freed += h.mb;
      }
      if (total + m.mb > e.info!.budgetMb && total > 0) continue;
      if (!best || freed < best.mb || (freed === best.mb && s.held.size < best.slot.held.size)) best = { slot: s, drop, mb: freed };
    }
    return best && { slot: best.slot, drop: best.drop };
  }

  /** Starts every job that can start now. */
  private pump() {
    for (;;) {
      let started = false;
      for (const kind of KINDS) {
        // The lines in turn, the one served longest ago (or never) first: the first whose next job
        // has a place goes.
        const served = this.served[kind];
        const order = [...this.lines[kind]].sort((a, b) => (served.get(a[0]) ?? -1) - (served.get(b[0]) ?? -1));
        for (const [who, line] of order) {
          // A reader's live sentences one at a time.
          if (kind === 'live' && this.readingNow.has(who)) continue;
          const at = this.place(line.head.job);
          if (!at) continue;
          const w = line.shift();
          if (!line.size) this.lines[kind].delete(who);
          // Moved to the end, so the list runs from served longest ago to just now.
          served.delete(who);
          served.set(who, ++this.turn);
          this.start(at.slot, at.drop, w);
          started = true;
          break;
        }
        if (started) break;
      }
      if (!started) return;
    }
  }

  private start(slot: Slot, drop: string[], w: Waiting) {
    const { job } = w;
    slot.busy = true;
    slot.started = true;
    for (const key of drop) slot.held.delete(key);
    if (job.model) slot.held.set(job.model.key, { mb: job.model.mb, used: this.now() });
    slot.running = job.kind;
    if (job.kind === 'live') {
      slot.liveAt = this.now();
      this.readingNow.add(job.who);
    }
    void (async () => {
      try {
        const payload = await job.body();
        const r = await this.runner.run(slot.host, slot.n, payload, drop);
        this.done[job.kind]++;
        w.resolve(r);
      } catch (err) {
        // A worker that stopped lost what it held.
        if ((err as { stopped?: boolean }).stopped) {
          slot.held.clear();
          slot.started = false;
        }
        w.reject(err instanceof Error ? err : new Error(String(err)));
      } finally {
        slot.busy = false;
        slot.running = null;
        if (job.kind === 'live') this.readingNow.delete(job.who);
        slot.last = this.now();
        if (job.model) {
          const h = slot.held.get(job.model.key);
          if (h) h.used = this.now();
        }
        this.pump();
      }
    })();
  }

  private reject(kinds: Kind[], err: Error) {
    for (const kind of kinds) {
      for (const line of this.lines[kind].values()) for (const w of line.all()) w.reject(err);
      this.lines[kind].clear();
    }
  }

  /** Every few seconds, after each engine's memory is read: who's short, and workers quiet too long. */
  tick() {
    const wasShort = this.short;
    for (const [h, e] of this.engines.entries()) {
      if (!e.info) continue;
      const low = e.info.freeMb < e.info.lowMb;
      if (low !== e.low) {
        e.low = low;
        this.o.onLow?.(h, low, e.info.freeMb);
      }
    }
    if (this.short && !wasShort && this.up.length) this.reject(['panel'], busyError('The server is short of memory.'));
    // Forget turns of lines long empty, oldest first, so the list stays small.
    for (const kind of KINDS) {
      const served = this.served[kind];
      for (const who of served.keys()) {
        if (served.size <= FORGET_AFTER) break;
        if (!this.lines[kind].has(who)) served.delete(who);
      }
    }
    // Short of memory, a worker that read live lately stays, so the next sentence needn't load.
    const lately = this.now() - this.liveHoldMs;
    for (const e of this.up) {
      for (const s of e.slots) {
        if (s.busy || !s.started) continue;
        if ((e.low && s.liveAt <= lately) || this.now() - s.last >= this.idleMs) this.stopSlot(s);
      }
    }
    this.pump();
  }

  private stopSlot(s: Slot) {
    this.runner.stop(s.host, s.n);
    s.held.clear();
    s.started = false;
  }

  stats(): Stats {
    return {
      engines: this.engines.map((e) => ({
        up: !!e.info,
        workers: e.slots.length,
        started: e.slots.filter((s) => s.started).length,
        busy: e.slots.filter((s) => s.busy).length,
        heldMb: this.heldMb(e),
        budgetMb: e.info?.budgetMb ?? 0,
        freeMb: Math.round(e.info?.freeMb ?? 0),
        low: e.low,
        models: e.slots.map((s) => [...s.held.keys()]),
      })),
      waiting: { live: this.waiting('live'), panel: this.waiting('panel') },
      done: { ...this.done },
    };
  }

  /** Stops every worker; what's waiting fails. */
  close() {
    this.reject(KINDS, new Error('The engine stopped.'));
    for (const e of this.engines) for (const s of e.slots) if (s.started) this.stopSlot(s);
  }
}
