import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { chat, CallError, type Failure, type Msg, type Reply } from './nim.ts';
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
 * - The top model is worth waiting for. A weaker one only takes a call when the top one is cooling
 *   for longer than `waitForTopS`, or has failed `strikesToFall` times in a row.
 * - A model that says it isn't open to the key (401, 403, 404) is dropped for the run.
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
}

/** First cooldown and cap, in seconds, per kind of failure. */
const COOL: Record<Failure, [number, number]> = {
  rate: [60, 1800],
  busy: [60, 900],
  slow: [30, 600],
  cut: [0, 0],
  bad: [0, 0],
  gone: [0, 0],
};

interface State {
  inFlight: number;
  coolUntil: number;
  strikes: number;
  gone: boolean;
}

export interface Answer {
  reply: Reply;
  rung: Rung;
  tries: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LOG = join(WORK, '_calls.jsonl');

export class Balancer {
  private state = new Map<string, State>();

  constructor(
    public ladder: Rung[],
    private opts = { waitForTopS: 300, strikesToFall: 3, maxTries: 12 },
  ) {
    for (const r of ladder) this.state.set(r.model, { inFlight: 0, coolUntil: 0, strikes: 0, gone: false });
  }

  /** The rung to call now, or how long to wait before asking again. */
  private pick(now: number): Rung | number {
    let wait = Infinity;
    for (const [i, r] of this.ladder.entries()) {
      const s = this.state.get(r.model)!;
      if (s.gone) continue;
      const cooling = Math.max(0, s.coolUntil - now);
      if (!cooling && s.inFlight < r.maxInFlight) return r;
      // Busy with other calls isn't a failure: wait for it rather than fall.
      if (!cooling) { wait = Math.min(wait, 5000); break; }
      wait = Math.min(wait, cooling);
      const worthWaiting = cooling <= this.opts.waitForTopS * 1000 && s.strikes < this.opts.strikesToFall;
      if (i === 0 && worthWaiting) break;
    }
    if (wait === Infinity) throw new Error(`Every model is off for this run: ${this.ladder.map((r) => r.name).join(', ')}.`);
    return Math.min(wait, 60_000);
  }

  private fail(r: Rung, e: CallError) {
    const s = this.state.get(r.model)!;
    if (e.kind === 'gone') { s.gone = true; return; }
    const [base, cap] = COOL[e.kind];
    if (!base) return;
    // Calls already in flight when the model started cooling fail together: that's one strike.
    if (s.coolUntil > Date.now()) return;
    s.strikes++;
    const secs = e.retryAfterS ?? Math.min(cap, base * 2 ** (s.strikes - 1));
    s.coolUntil = Date.now() + secs * 1000;
  }

  /** One chat call on the best model free, retried across the ladder until it answers. */
  async chat(messages: Msg[], label: Record<string, unknown>): Promise<Answer> {
    let cuts = 0;
    for (let tries = 1; ; tries++) {
      let r: Rung | number;
      while (typeof (r = this.pick(Date.now())) === 'number') await sleep(r);
      const s = this.state.get(r.model)!;
      s.inFlight++;
      const at = new Date().toISOString();
      try {
        const reply = await chat(r.model, messages, { maxTokens: r.maxTokens, extra: r.extra });
        s.strikes = 0;
        s.coolUntil = 0;
        log({ at, ...label, model: r.name, ok: true, secs: round(reply.secs), firstS: round(reply.firstS), promptTokens: reply.promptTokens, outTokens: reply.outTokens, thinkChars: reply.thinkChars });
        return { reply, rung: r, tries };
      } catch (e) {
        if (!(e instanceof CallError)) throw e;
        log({ at, ...label, model: r.name, ok: false, kind: e.kind, why: e.message, secs: round((Date.now() - Date.parse(at)) / 1000) });
        console.log(`    ${r.name}: ${e.kind} (${e.message.slice(0, 90)})`);
        if (e.kind === 'bad') throw new Error(`${r.name} refused the request: ${e.message}`);
        if (e.kind === 'cut' && ++cuts >= 2) throw new Error(`${r.name} ran out of room twice: ${e.message}`);
        this.fail(r, e);
        if (tries >= this.opts.maxTries) throw new Error(`No answer after ${tries} tries; the last: ${r.name} ${e.message}`);
      } finally {
        s.inFlight--;
      }
    }
  }
}

const round = (n: number) => Math.round(n * 10) / 10;
function log(entry: Record<string, unknown>) {
  try { appendFileSync(LOG, `${JSON.stringify(entry)}\n`); } catch { /* logging never stops a run */ }
}
