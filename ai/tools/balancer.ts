import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { SHRINKS } from './kimi.ts';
import { chat, CallError, type Failure, type Judge, type Msg, type Reply } from './nim.ts';
import { WORK } from './lib.ts';

/*
 * A small load balancer for the marking calls, after spoin's (a ladder of models, strongest first,
 * each cooling down on its own), cut to what NVIDIA's free API actually does:
 *
 * - No published limits, no limit headers, no daily cap seen. Forums put it at 40 to 60 requests a
 *   minute per model, far more than a book needs (one call a part), so there's no minute window.
 * - The trouble is queues (minutes before the first token), "overloaded", 504s at 300 s, and
 *   outages that last hours (Kimi K3, 9 to 11 September 2026). So every failure cools its model
 *   down, doubling with each failure in a row, and a success resets it.
 * - Every wait has random jitter (half to one and a half times as long), so calls that failed
 *   together don't all come back at the same moment.
 * - The top model is worth waiting for. A weaker one only takes a call when the top one is cooling
 *   for longer than `waitForTopS`, or has failed `strikesToFall` times in a row. Primary rungs at
 *   the top are all "the top": equals, and the one with the fewest calls in flight takes the next.
 * - A model that says it isn't open to the key (401, 403, 404) is dropped for the run. A patient
 *   run (the marker, which never ends) asks it again an hour later instead.
 * - An empty answer or a refused request (another 4xx) is about one prompt, not the model. That
 *   call alone waits and asks again, and after EMPTY_TRIES empty answers, or one refusal, it asks
 *   again smaller, when the call comes in sizes: the book cut by a fifth, then two, then three
 *   (kimi.ts, context), keeping the parts nearest the one it's about. Kimi answers a smaller call
 *   it kept refusing whole often enough that this goes before any other model. Only at the
 *   smallest does it ask the next model on the ladder, which starts at full size again. When no
 *   model is left for it, the call fails.
 * - Every Balancer in a process shares each model's state (calls in flight, cooldown): they all
 *   call the same model with the same key.
 * - A `low` Balancer's calls wait while Balancer.holdLow is on. The marker turns it on while a book
 *   is being marked, so a new book's marks go before anyone's notes.
 *
 * Every call is logged to ai/work/_calls.jsonl (timings and token counts, never text), which is
 * how the numbers above get checked.
 */

export interface Rung {
  model: string;
  /** Short name for logs and the pack's "by". */
  name: string;
  extra?: Record<string, unknown>;
  maxTokens: number;
  /** Calls at once. */
  maxInFlight: number;
  /** One of the top models, sharing the calls with the others as an equal. */
  primary?: boolean;
}

export interface Options {
  /** How long the top models may be cooling before a weaker one takes the call. */
  waitForTopS: number;
  /** Failures in a row before a weaker one takes the call anyway. */
  strikesToFall: number;
  /** Tries for one call before it gives up. Infinity never does. */
  maxTries: number;
  /** A run that never ends: a model that refuses the key is asked again later, not dropped. */
  patient?: boolean;
  /** Calls that wait while Balancer.holdLow is on. */
  low?: boolean;
}

/** First cooldown and cap, in seconds, per kind of failure. */
const COOL: Record<Failure, [number, number]> = {
  rate: [60, 1800],
  busy: [60, 900],
  slow: [30, 600],
  empty: [0, 0],
  cut: [0, 0],
  bad: [0, 0],
  gone: [0, 0],
};

/** Empty answers one call takes from a model before it asks another, and the first wait between them. */
const EMPTY_TRIES = 3;
const EMPTY_WAIT_S = 20;
/** How long a patient run leaves a model that refused the key. */
const GONE_S = 3600;

interface State {
  name: string;
  inFlight: number;
  coolUntil: number;
  strikes: number;
  /** It refused the key: off for the run, or cooling until it's asked again when patient. */
  gone: boolean;
}

/** Each model's state, by model, shared by every Balancer in the process. */
const STATES = new Map<string, State>();

export interface Answer {
  reply: Reply;
  rung: Rung;
  tries: number;
}

/** A call that comes in sizes: the whole of it at level 0, smaller at each level up to SHRINKS. */
export type Sized = (level: number) => Msg[];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Half to one and a half times n. */
export const jitter = (n: number) => n * (0.5 + Math.random());
/** A wait after `strikes` failures in a row: `base` doubling with each, up to `cap`, with jitter. */
export const backoffS = (strikes: number, base: number, cap: number) => jitter(Math.min(cap, base * 2 ** (strikes - 1)));
const LOG = join(WORK, '_calls.jsonl');

export class Balancer {
  /** While on, a `low` Balancer's calls wait before asking. Calls already out finish. */
  static holdLow = false;

  /** The top rungs: the primary ones at the start of the ladder, or just the first. */
  private top: Rung[];

  constructor(
    public ladder: Rung[],
    private opts: Options = { waitForTopS: 300, strikesToFall: 3, maxTries: 12 },
  ) {
    for (const r of ladder) {
      if (!STATES.has(r.model)) STATES.set(r.model, { name: r.name, inFlight: 0, coolUntil: 0, strikes: 0, gone: false });
    }
    const lead = ladder.findIndex((r) => !r.primary);
    this.top = ladder.slice(0, lead < 0 ? ladder.length : Math.max(1, lead));
  }

  /** The models refusing the key, by name, until one of them answers again. */
  static refused(): string[] {
    return [...STATES.values()].filter((s) => s.gone).map((s) => s.name);
  }

  /** The rung to call now, or how long to wait before asking again. `skip`: models this call won't ask, and why. */
  private pick(now: number, skip: Map<string, string>): Rung | number {
    const st = (r: Rung) => STATES.get(r.model)!;
    const usable = (r: Rung) => {
      if (skip.has(r.model)) return false;
      if (st(r).gone && !this.opts.patient) return false;
      return true;
    };
    const top = this.top.filter(usable);
    const rest = this.ladder.slice(this.top.length).filter(usable);
    if (!top.length && !rest.length) {
      const why = this.ladder.map((r) => skip.get(r.model) ?? `${r.name} refuses the key`);
      throw new Error(`No model left to ask: ${why.join('; ')}.`);
    }

    const open = top.filter((r) => st(r).coolUntil <= now && st(r).inFlight < r.maxInFlight);
    if (open.length) return open.reduce((a, b) => (st(b).inFlight < st(a).inFlight ? b : a));
    let wait = Infinity;
    let worthWaiting = false;
    for (const r of top) {
      const s = st(r);
      const cooling = Math.max(0, s.coolUntil - now);
      // Busy with other calls isn't a failure: wait for it rather than fall.
      if (!cooling) { wait = Math.min(wait, 5000); worthWaiting = true; continue; }
      wait = Math.min(wait, cooling);
      if (cooling <= this.opts.waitForTopS * 1000 && s.strikes < this.opts.strikesToFall) worthWaiting = true;
    }
    if (!worthWaiting) {
      for (const r of rest) {
        const s = st(r);
        const cooling = Math.max(0, s.coolUntil - now);
        if (!cooling && s.inFlight < r.maxInFlight) return r;
        if (!cooling) { wait = Math.min(wait, 5000); break; }
        wait = Math.min(wait, cooling);
      }
    }
    return Math.min(wait, 60_000);
  }

  /** Waits for a model free for this call, and first, for a low call, until holdLow is off. */
  private async next(skip: Map<string, string>): Promise<Rung> {
    for (;;) {
      if (this.opts.low && Balancer.holdLow) {
        await sleep(jitter(10_000));
        continue;
      }
      const r = this.pick(Date.now(), skip);
      if (typeof r !== 'number') return r;
      await sleep(jitter(r));
    }
  }

  private cool(r: Rung, e: CallError) {
    const s = STATES.get(r.model)!;
    if (e.kind === 'gone') {
      s.gone = true;
      if (this.opts.patient) s.coolUntil = Date.now() + jitter(GONE_S) * 1000;
      return;
    }
    const [base, cap] = COOL[e.kind];
    if (!base) return;
    // Calls already in flight when the model started cooling fail together: that's one strike.
    if (s.coolUntil > Date.now()) return;
    s.strikes++;
    let secs: number;
    if (e.retryAfterS) secs = e.retryAfterS + Math.random() * 10;
    else secs = backoffS(s.strikes, base, cap);
    s.coolUntil = Date.now() + secs * 1000;
  }

  /**
   * One chat call on the best model free, retried across the ladder until it answers. A call
   * given in sizes is asked again smaller when a model keeps refusing it. `judge` checks the
   * answer as it comes in (nim.ts): one it finds no good counts as a refusal.
   */
  async chat(request: Msg[] | Sized, label: Record<string, unknown>, judge?: Judge): Promise<Answer> {
    let sized: Sized;
    if (typeof request === 'function') sized = request;
    else sized = () => request;
    const smallest = typeof request === 'function' ? SHRINKS : 0;
    let cuts = 0;
    const skip = new Map<string, string>();
    const empties = new Map<string, number>();
    // How small each model is asked: each starts at full size.
    const levels = new Map<string, number>();
    for (let tries = 1; ; tries++) {
      const r = await this.next(skip);
      const s = STATES.get(r.model)!;
      const level = levels.get(r.model) ?? 0;
      s.inFlight++;
      const at = new Date().toISOString();
      let pause = 0;
      try {
        const reply = await chat(r.model, sized(level), { maxTokens: r.maxTokens, extra: r.extra, judge });
        s.strikes = 0;
        s.coolUntil = 0;
        s.gone = false;
        log({ at, ...label, model: r.name, ok: true, level, secs: round(reply.secs), firstS: round(reply.firstS), promptTokens: reply.promptTokens, outTokens: reply.outTokens, thinkChars: reply.thinkChars });
        return { reply, rung: r, tries };
      } catch (e) {
        if (!(e instanceof CallError)) throw e;
        log({ at, ...label, model: r.name, ok: false, level, kind: e.kind, why: e.message, secs: round((Date.now() - Date.parse(at)) / 1000) });
        console.log(`    ${r.name}: ${e.kind} (${e.message.slice(0, 90)})`);
        if (e.kind === 'bad' || e.kind === 'empty') {
          let why = `${r.name} refused it (${e.message.slice(0, 120)})`;
          let refused = true;
          if (e.kind === 'empty') {
            const n = (empties.get(r.model) ?? 0) + 1;
            empties.set(r.model, n);
            why = `${r.name} answered it empty ${n} times`;
            if (n < EMPTY_TRIES) {
              refused = false;
              pause = jitter(EMPTY_WAIT_S * 2 ** (n - 1)) * 1000;
            }
          }
          if (refused && level < smallest) {
            levels.set(r.model, level + 1);
            empties.delete(r.model);
            console.log(`    ${r.name}: asking again a size smaller (${level + 1} of ${smallest})`);
          } else if (refused) {
            skip.set(r.model, why);
          }
        } else if (e.kind === 'cut') {
          cuts++;
          if (cuts >= 2) throw new Error(`${r.name} ran out of room twice: ${e.message}`);
        } else {
          this.cool(r, e);
        }
        if (tries >= this.opts.maxTries) throw new Error(`No answer after ${tries} tries; the last: ${r.name} ${e.message}`);
      } finally {
        s.inFlight--;
      }
      if (pause) await sleep(pause);
    }
  }
}

const round = (n: number) => Math.round(n * 10) / 10;
/** One line in the call log: timings and token counts, never text. */
export function log(entry: Record<string, unknown>) {
  try { appendFileSync(LOG, `${JSON.stringify(entry)}\n`); } catch { /* logging never stops a run */ }
}
