import type { Static, TSchema } from 'typebox';
import { runAgentLoopContinue, type AgentLoopConfig, type AgentMessage, type AgentTool, type StreamFn } from '../pi/pi-agent/src/index.ts';
import { streamSimple, toToolDeclaration, Type, type AssistantMessage, type Model } from '../pi/pi-ai/src/index.ts';
import { backoffS, jitter, log } from './balancer.ts';
import { geminiModels, geminiOpensAt, noHarness, proxy, THINKING } from './proxy.ts';

/*
 * The harness: a Gemini model on Antigravity (proxy.ts) working through a task with tools, on
 * pi's agent loop (ai/pi, forked from github.com/earendil-works/pi, as breader_writer does). The
 * NVIDIA models (balancer.ts) do the big reading; the harness does what needs looking around for,
 * searching the web and YouTube and deciding as it goes.
 *
 * It keeps to what the agent guides agree on:
 * - A plain loop, the tools' results the ground truth at every step, and a stopping condition: a
 *   budget of calls, and a finish tool that only ends the task when the task's own check agrees
 *   (Anthropic, "Building effective agents").
 * - Every tool call gets a result, and a tool that fails says what to do instead. Results are
 *   kept short, and old ones are cleared from the context once they're far behind: the task's
 *   state lives in its tools, which can always say it again (Anthropic, "Writing effective tools
 *   for agents" and "Effective context engineering for AI agents"; agents-best-practices).
 * - Every run ends with a reason, and every call is logged to the NIM calls' log: timings and
 *   tokens, never text.
 * - Failures wait the way the NIM balancer's do (and AWS's "Exponential backoff and jitter"): a
 *   failing model cools down, the wait doubling with each failure in a row up to a cap, with
 *   random jitter, and the next Gemini model takes the calls while Flash cools for long. When
 *   every Antigravity account is out of its 5-hour or weekly limit, the harness waits for the
 *   first to fill again, then carries on. A sign-in turned away stops the run at once, since
 *   waiting doesn't fix it.
 */

/** Tool results kept whole in each call; older ones are cleared. */
const KEPT_RESULTS = 24;
/** The longest result a tool hands back. */
const RESULT_CHARS = 20_000;
/** Reminders when the model stops without finishing. */
const NUDGES = 3;
/** Failed calls in a row before the run gives up. */
const FAILS = 10;
/** How long Flash may be cooling, and after how many failures in a row, before another model takes the calls. */
const WAIT_FOR_FIRST_S = 120;
const STRIKES_TO_FALL = 2;
/** First cooldown and cap, in seconds, for each kind of failure that waits. */
const COOL = { rate: [60, 1800], busy: [30, 600] } as const;
/** The longest wait before looking again. */
const LOOK_AGAIN_MS = 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round = (n: number) => Math.round(n * 10) / 10;

export interface Task {
  /** Who the model is and what it's for. */
  system: string;
  /** What to do, with everything it starts from. */
  brief: string;
  tools: AgentTool<any>[];
  /** Answered calls before the run gives up. */
  maxCalls: number;
  /** Why it isn't finished yet, or null when it is. Asked when the model calls finish. */
  unfinished: () => string | null;
  /** For the call log. */
  label: Record<string, unknown>;
}

/** What the harness thinks with: the models in order, and how to reach them. Tests make their own. */
export interface Brain {
  models: Array<Model<'google-generative-ai'>>;
  apiKey: string;
  stream: StreamFn;
  /** When an Antigravity account has Gemini to give again, or null when that can't be told. */
  opensAt: () => Promise<number | null>;
}

export async function brain(): Promise<Brain> {
  const p = proxy();
  if (!p) throw new Error(`The harness can’t run: ${noHarness()}.`);
  return {
    models: await geminiModels(p),
    apiKey: p.apiKey,
    stream: streamSimple,
    opensAt: () => geminiOpensAt(p),
  };
}

/** A tool whose answer is text. An error it throws goes back to the model, so its message should say what to do instead. */
export function tool<T extends TSchema>(name: string, description: string, parameters: T, run: (args: Static<T>) => Promise<string> | string): AgentTool<T> {
  return {
    name,
    label: name,
    description,
    parameters,
    execute: async (_id, args) => {
      let text = await run(args);
      if (text.length > RESULT_CHARS) text = `${text.slice(0, RESULT_CHARS)}\n(Cut at ${RESULT_CHARS} characters: ask for less at a time.)`;
      return { content: [{ type: 'text', text }], details: {} };
    },
  };
}

export type Failure = 'signIn' | 'rate' | 'busy' | 'bad';

function statusIn(message: string): number | null {
  const patterns = [/^(\d{3})\b/, /"code":\s*(\d{3})/, /status(?: code)?:?\s*(\d{3})/i];
  for (const pattern of patterns) {
    const m = message.match(pattern);
    if (m) return Number(m[1]);
  }
  return null;
}

/** What kind of failure a failed call's message tells of. */
export function failureOf(message: string): Failure {
  if (/Server requested \d+s retry delay/.test(message)) return 'rate';
  if (/RESOURCE_EXHAUSTED|quota/i.test(message)) return 'rate';
  const status = statusIn(message);
  if (status === 401 || status === 403) return 'signIn';
  if (status === 429) return 'rate';
  if (status === null || status === 408 || status >= 500) return 'busy';
  return 'bad';
}

interface Cooling {
  strikes: number;
  until: number;
}

/** Each model's cooldown, shared by every run in the process: they all call the same accounts. */
const COOLING = new Map<string, Cooling>();

function coolingOf(id: string): Cooling {
  let c = COOLING.get(id);
  if (!c) {
    c = { strikes: 0, until: 0 };
    COOLING.set(id, c);
  }
  return c;
}

/** A model hit a limit or found the server busy: it cools, longer with each failure in a row. */
export function cool(id: string, kind: 'rate' | 'busy') {
  const c = coolingOf(id);
  c.strikes++;
  const [base, cap] = COOL[kind];
  c.until = Date.now() + backoffS(c.strikes, base, cap) * 1000;
}

/**
 * The model to call now, or how long to wait before looking again. Flash is worth waiting for a
 * while; after that, any Gemini model that isn't cooling takes the call. `skip`: models that
 * turned this run's requests away, and why.
 */
export function pick<M extends { id: string }>(models: M[], skip: Map<string, string>, now: number): M | number {
  const usable = models.filter((m) => !skip.has(m.id));
  if (!usable.length) throw new Error(`Every Gemini model turned the request away: ${[...skip.values()].join('; ')}`);
  const first = usable[0];
  const firstCooling = coolingOf(first.id);
  if (firstCooling.until <= now) return first;
  const left = firstCooling.until - now;
  const worthWaiting = left <= WAIT_FOR_FIRST_S * 1000 && firstCooling.strikes < STRIKES_TO_FALL;
  if (worthWaiting) return Math.min(left, LOOK_AGAIN_MS);
  let wait = left;
  for (const m of usable.slice(1)) {
    const until = coolingOf(m.id).until;
    if (until <= now) return m;
    wait = Math.min(wait, until - now);
  }
  return Math.min(wait, LOOK_AGAIN_MS);
}

async function choose<M extends { id: string }>(models: M[], skip: Map<string, string>): Promise<M> {
  for (;;) {
    const picked = pick(models, skip, Date.now());
    if (typeof picked !== 'number') return picked;
    await sleep(jitter(picked));
  }
}

let limitedUntil = 0;

/** When every Antigravity account is out of Gemini, until when, for the marker's live view; else 0. */
export const waitingForLimits = () => limitedUntil;

/** Waits for an Antigravity account with Gemini left, when none has any. True if it waited. */
async function waitForLimits(b: Brain): Promise<boolean> {
  let at: number | null = null;
  try {
    at = await b.opensAt();
  } catch {
    return false;
  }
  if (at === null) return false;
  const wait = at - Date.now();
  if (wait <= 0) return false;
  console.log(`    Every Antigravity account is out of Gemini until ${new Date(at).toISOString()}: waiting for it.`);
  limitedUntil = at;
  // A minute or so past the reset, so the accounts are surely open again.
  await sleep(wait + jitter(60_000));
  limitedUntil = 0;
  return true;
}

function systemFor(task: Task): string {
  return `${task.system}

# How you work

You work through tools, and their results are the ground truth: look before you decide, and check what you've done with the tools that show it. Think before each call. When a tool says something went wrong, it says what to do instead: do that, rather than the same call again. You have up to ${task.maxCalls} calls. When everything is done, call finish; if anything is still open, finish says what.`;
}

function reminder(task: Task): string {
  const why = task.unfinished();
  if (why) return `You stopped, but the task isn’t finished: ${why} Carry on with the tools, and call finish when it is.`;
  return 'Everything looks done: call finish with a line on what you did.';
}

/** The context as sent: tool results far behind are cleared, since the tools can say them again. */
export function clearOld(messages: AgentMessage[]): AgentMessage[] {
  const out = [...messages];
  let seen = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (m.role !== 'toolResult') continue;
    seen++;
    if (seen <= KEPT_RESULTS) continue;
    const text = `(Cleared to keep this short: call ${m.toolName} again if you need it.)`;
    out[i] = { ...m, content: [{ type: 'text', text }] };
  }
  return out;
}

function logCall(label: Record<string, unknown>, m: AssistantMessage, startedAt: number) {
  const entry: Record<string, unknown> = {
    at: new Date(startedAt).toISOString(),
    ...label,
    model: m.model,
    ok: m.stopReason !== 'error',
    secs: round((Date.now() - startedAt) / 1000),
  };
  if (m.stopReason === 'error') {
    entry.why = (m.errorMessage ?? '').slice(0, 200);
  } else {
    entry.promptTokens = m.usage.input;
    entry.cachedTokens = m.usage.cacheRead;
    entry.outTokens = m.usage.output;
    entry.thinkTokens = m.usage.reasoning;
    entry.toolCalls = m.content.filter((c) => c.type === 'toolCall').length;
  }
  log(entry);
}

const noEvents = () => {};

/** Runs the task until it's finished. Returns finish's summary; throws with the reason when it can't finish. */
export async function runAgent(task: Task, given?: Brain): Promise<string> {
  let b = given;
  if (!b) b = await brain();
  const using = b;

  // Set by finish: an object, since the loop's callbacks read it as it changes.
  const outcome: { summary: string | null } = { summary: null };
  const finish = tool(
    'finish',
    'Ends the task, once everything it asks for is done. If anything is still open, the result says what, and you carry on.',
    Type.Object({ summary: Type.String({ description: 'A line or two on what you did.' }) }),
    (args) => {
      const why = task.unfinished();
      if (why) throw new Error(`Not finished yet: ${why}`);
      outcome.summary = args.summary;
      return 'Finished.';
    },
  );
  const tools = [...task.tools, finish];
  const messages: AgentMessage[] = [
    { role: 'system', content: systemFor(task), toolsAdded: tools.map(toToolDeclaration), timestamp: 0 },
    { role: 'user', content: task.brief, timestamp: Date.now() },
  ];

  const skip = new Map<string, string>();
  let answered = 0;
  let fails = 0;
  let nudges = 0;
  let startedAt = 0;

  const config: AgentLoopConfig = {
    model: using.models[0],
    reasoning: THINKING,
    apiKey: using.apiKey,
    // One quick try again for a blip; anything longer is this file's backoff.
    maxRetries: 1,
    toolExecution: 'sequential',
    convertToLlm: (all) => all,
    transformContext: async (all) => clearOld(all),
    prepareRequest: async () => {
      const model = await choose(using.models, skip);
      startedAt = Date.now();
      return { model };
    },
    finishTurn: (turn) => {
      const m = turn.message;
      logCall(task.label, m, startedAt);
      if (m.stopReason === 'error' || m.stopReason === 'aborted') return undefined;
      answered++;
      fails = 0;
      COOLING.delete(m.model);
      if (outcome.summary !== null) return { action: 'end' };
      if (answered >= task.maxCalls) return { action: 'end' };
      return undefined;
    },
    getFollowUpMessages: async () => {
      if (outcome.summary !== null) return [];
      if (answered >= task.maxCalls) return [];
      if (nudges >= NUDGES) return [];
      nudges++;
      return [{ role: 'user', content: reminder(task), timestamp: Date.now() }];
    },
  };

  for (;;) {
    const fresh = await runAgentLoopContinue({ messages, tools }, config, noEvents, undefined, using.stream);
    const last = fresh[fresh.length - 1];
    if (last && last.role === 'assistant' && last.stopReason === 'error') {
      // The failed answer goes; the run carries on from the message before it.
      messages.push(...fresh.slice(0, -1));
      fails++;
      const why = last.errorMessage ?? 'no reason given';
      const kind = failureOf(why);
      if (kind === 'signIn') throw new Error(`Antigravity turned the sign-in away (${why.slice(0, 200)}): connect the account again from the admin page.`);
      if (kind === 'bad') {
        skip.set(last.model, `${last.model}: ${why.slice(0, 200)}`);
        continue;
      }
      if (kind === 'rate') {
        const waited = await waitForLimits(using);
        if (waited) {
          fails = 0;
          continue;
        }
      }
      cool(last.model, kind);
      if (fails >= FAILS) throw new Error(`Gemini failed ${fails} times in a row; the last: ${why.slice(0, 200)}`);
      continue;
    }
    messages.push(...fresh);
    if (last && last.role === 'assistant' && last.stopReason === 'aborted') throw new Error('The run was stopped.');
    if (outcome.summary !== null) return outcome.summary;
    const open = task.unfinished() ?? 'it never called finish';
    if (answered >= task.maxCalls) throw new Error(`It used all ${task.maxCalls} calls without finishing: ${open}`);
    throw new Error(`It stopped without finishing, ${NUDGES} reminders on: ${open}`);
  }
}
