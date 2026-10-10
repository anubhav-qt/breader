import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Static, TSchema } from 'typebox';
import { runAgentLoopContinue, type AgentLoopConfig, type AgentMessage, type AgentTool, type StreamFn } from '../pi/pi-agent/src/index.ts';
import { estimateContextTokens, estimateMessageTokens, streamSimple, toToolDeclaration, Type, type AssistantMessage, type Message, type Model, type UserMessage } from '../pi/pi-ai/src/index.ts';
import { backoffS, jitter, log } from './balancer.ts';
import { WORK } from './lib.ts';
import { geminiModels, geminiOpensAt, noHarness, proxy, THINKING } from './proxy.ts';

/*
 * The harness: a Gemini model on Antigravity (proxy.ts) working through a task with tools, on
 * pi's agent loop (ai/pi, forked from github.com/earendil-works/pi, as breader_writer does). The
 * NVIDIA models (balancer.ts) do the big reading; the harness does what needs looking around for,
 * searching the web and YouTube and deciding as it goes.
 *
 * Each series' job, its research or its soundtrack, is done in one chat that's kept for good, the
 * way breader_writer's Procreator plays a scene and Seelie (pde) keeps a chat:
 * - Every turn is saved to chats/<name>.jsonl in the work folder as soon as it ends, and what the
 *   tools find is saved by the tools as they go (each track, each section). A run that stops, for
 *   an error, an outage or a restart, loses nothing: the next run of the job opens the same chat
 *   and carries on from its last turn. A job asked again later (the next volume, a soundtrack a
 *   month old) is asked in the same chat too.
 * - No cap on calls or time: the chat goes on until the task's own check agrees it's finished.
 * - Every call sends the chat as it stands. It only grows at the end, so Gemini's cache covers all
 *   but the newest turn.
 * - Our own compaction, as Procreator's: past 400k tokens, the model first saves with its tools
 *   whatever it hasn't, then writes the work so far, and the chat goes on from a fresh brief, that
 *   summary and the latest turns word for word, cut only between turns. Everything before stays
 *   in the file.
 * - Every tool call gets a result, and a tool that fails says what to do instead (Anthropic,
 *   "Writing effective tools for agents"). Every call is logged to the NIM calls' log: timings
 *   and tokens, never text.
 * - Failures are waited out the way the NIM balancer's are (and AWS's "Exponential backoff and
 *   jitter"): a failing model cools down, the wait doubling with each failure in a row up to a
 *   cap, with random jitter, and the next Gemini model takes the calls while Flash cools for
 *   long. When every Antigravity account is out of its 5-hour or weekly limit, the harness waits
 *   for the first to fill again; with the proxy or the network down, it keeps looking until
 *   they're back. What waiting can't fix (a sign-in turned away, every model refusing) ends the
 *   run, and the next run picks the chat up again.
 */

/** How long Flash may be cooling, and after how many failures in a row, before another model takes the calls. */
const WAIT_FOR_FIRST_S = 120;
const STRIKES_TO_FALL = 2;
/** First cooldown and cap, in seconds, for each kind of failure that waits. */
const COOL = { rate: [60, 1800], busy: [30, 600] } as const;
/** The longest wait before looking again. */
const LOOK_AGAIN_MS = 60_000;
/** A chat is compacted past this many tokens, or sooner on a model whose window can't take that and an answer. */
export const COMPACT_AT = 400_000;
/** After a compaction, the latest turns kept word for word take up to this share of it. */
const KEEP_SHARE = 0.2;

const CHATS = join(WORK, 'chats');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round = (n: number) => Math.round(n * 10) / 10;

export interface Task {
  /** The chat it's done in, one for each series and job: chats/<chat>.jsonl. */
  chat: string;
  /** What's asked of the chat this time, such as the volume to research. Asked again once it's finished. */
  ask: string;
  /** Who the model is and what it's for. */
  system: string;
  /** What to do, with everything it starts from as things stand. Built again after a compaction. */
  brief: () => string;
  tools: AgentTool<any>[];
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
      const text = await run(args);
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

You work through tools, and their results are the ground truth: look before you decide, and check what you've done with the tools that show it. Think before each call. When a tool says something went wrong, it says what to do instead: do that, rather than the same call again. Take as many calls as the work needs. When everything is done, call finish; if anything is still open, finish says what. This chat is kept and goes on from one job to the next: when a new one is asked, it's the one to do.`;
}

function reminder(task: Task): string {
  const why = task.unfinished();
  if (why) return `You stopped, but the task isn’t finished: ${why} Carry on with the tools, and call finish when it is.`;
  return 'Everything looks done: call finish with a line on what you did.';
}

const COMPACT = `This chat is getting long, so it's about to be cut short: everything before your latest turns will leave it. First save with your tools anything you've found that isn't saved yet. Then answer with the work so far, for yourself to carry on from: what's done and saved, what you were in the middle of, what's left, and what you've learned that the tools don't show, such as searches that found nothing and uploads to pass over. Plain lines, and nothing else.`;

/** A line of a chat's file. */
type Entry =
  /** A job asked of the chat, from the next segment or message on. */
  | { kind: 'ask'; ask: string }
  /** A part of the chat opens: its head, then the chat's messages from number `from` on. */
  | { kind: 'segment'; at: number; head: string; from: number }
  | { kind: 'message'; n: number; message: AgentMessage }
  /** A compaction at work: kept for the record, never sent again. */
  | { kind: 'fold'; message: AgentMessage }
  | { kind: 'finished'; ask: string; summary: string };

/** A message in the chat, with its number. */
export interface Numbered {
  n: number;
  message: AgentMessage;
}

/** A chat as its file keeps it: the segment it's in, its messages, and the job it's on. */
class Chat {
  private readonly file: string;
  private segment: { at: number; head: string; from: number } | null = null;
  private readonly messages: Numbered[] = [];
  /** The job it's on, or null when it has none open. */
  open: string | null = null;

  constructor(name: string) {
    this.file = join(CHATS, `${name}.jsonl`);
    if (!existsSync(this.file)) return;
    const text = readFileSync(this.file, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let entry: Entry;
      try {
        entry = JSON.parse(line) as Entry;
      } catch {
        // A line cut short by a stop mid-write.
        continue;
      }
      this.take(entry);
    }
    // What comes next starts on a line of its own, after a line cut short.
    if (text && !text.endsWith('\n')) appendFileSync(this.file, '\n');
  }

  private take(entry: Entry) {
    if (entry.kind === 'ask') this.open = entry.ask;
    if (entry.kind === 'segment') this.segment = { at: entry.at, head: entry.head, from: entry.from };
    if (entry.kind === 'message') this.messages.push({ n: entry.n, message: entry.message });
    if (entry.kind === 'finished') this.open = null;
  }

  private write(entries: Entry[]) {
    mkdirSync(CHATS, { recursive: true });
    appendFileSync(this.file, entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
    for (const e of entries) this.take(e);
  }

  private next(): number {
    const last = this.messages[this.messages.length - 1];
    if (!last) return 1;
    return last.n + 1;
  }

  isNew(): boolean {
    return this.segment === null;
  }

  /** How many messages it has kept, in all its segments. */
  size(): number {
    return this.messages.length;
  }

  /** The chat's first job, with its brief as the head. */
  start(ask: string, brief: string) {
    this.write([{ kind: 'ask', ask }, { kind: 'segment', at: Date.now(), head: brief, from: this.next() }]);
  }

  /** Another job, asked at the end of the chat. */
  ask(ask: string, brief: string) {
    const message: UserMessage = { role: 'user', content: brief, timestamp: Date.now() };
    this.write([{ kind: 'ask', ask }, { kind: 'message', n: this.next(), message }]);
  }

  add(messages: AgentMessage[]) {
    const entries: Entry[] = [];
    let n = this.next();
    for (const message of messages) {
      entries.push({ kind: 'message', n, message });
      n++;
    }
    this.write(entries);
  }

  fold(messages: AgentMessage[]) {
    this.write(messages.map((message) => ({ kind: 'fold', message })));
  }

  /** A new segment: a fresh head, then the messages from number `from` on. */
  cut(from: number, head: string) {
    this.write([{ kind: 'segment', at: Date.now(), head, from }]);
  }

  finish(ask: string, summary: string) {
    this.write([{ kind: 'finished', ask, summary }]);
  }

  /** The segment's head, as the model is sent it. Its time is the segment's, so token counts from before it aren't trusted. */
  head(): UserMessage {
    if (!this.segment) throw new Error('The chat hasn’t started.');
    return { role: 'user', content: this.segment.head, timestamp: this.segment.at };
  }

  /** The messages sent after the head. */
  sent(): Numbered[] {
    if (!this.segment) return [];
    const from = this.segment.from;
    return this.messages.filter((m) => m.n >= from);
  }
}

/** Where a model's chats are compacted. */
export function compactAt(model: { contextWindow: number; maxTokens: number }): number {
  let room = model.contextWindow - model.maxTokens;
  if (room < model.contextWindow / 2) {
    // A model that can answer with most of its window gets half of it for the chat.
    room = Math.floor(model.contextWindow / 2);
  }
  return Math.min(COMPACT_AT, room);
}

function tokensIn(sent: Numbered[], from: number, to: number): number {
  let tokens = 0;
  for (let i = from; i < to; i++) tokens += estimateMessageTokens(sent[i].message as Message);
  return tokens;
}

/**
 * Where a compaction cuts: the number of the first message kept word for word, or null when
 * there's no turn before the latest to fold. A cut falls only before one of the model's answers,
 * so an answer and its tool results stay together. The newest turns are kept while they fit in
 * `keep` tokens, the latest always, and the oldest always folds.
 */
export function keptFrom(sent: Numbered[], keep: number): number | null {
  const starts: number[] = [];
  for (let i = 0; i < sent.length; i++) {
    if (sent[i].message.role === 'assistant') starts.push(i);
  }
  if (starts.length < 2) return null;
  let first = starts.length - 1;
  let tokens = tokensIn(sent, starts[first], sent.length);
  while (first > 1) {
    const older = tokensIn(sent, starts[first - 1], starts[first]);
    if (tokens + older > keep) break;
    tokens += older;
    first--;
  }
  return sent[starts[first]].n;
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

function answerIn(messages: AgentMessage[]): AssistantMessage | null {
  for (const m of messages) {
    if (m.role === 'assistant') return m;
  }
  return null;
}

function textOf(m: AssistantMessage): string {
  const parts: string[] = [];
  for (const c of m.content) {
    if (c.type === 'text') parts.push(c.text);
  }
  return parts.join('\n').trim();
}

function asksTools(m: AssistantMessage): boolean {
  return m.content.some((c) => c.type === 'toolCall');
}

const noEvents = () => {};

/**
 * Runs the task in its chat until it's finished, carrying on from wherever the chat stopped.
 * Returns finish's summary; throws only for what waiting can't fix, with the chat kept.
 */
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
  const system: AgentMessage = { role: 'system', content: systemFor(task), toolsAdded: tools.map(toToolDeclaration), timestamp: 0 };

  const chat = new Chat(task.chat);
  if (chat.isNew()) {
    chat.start(task.ask, task.brief());
  } else if (chat.open !== task.ask) {
    chat.ask(task.ask, task.brief());
  } else {
    console.log(`    ${task.chat}: carrying on its chat, ${chat.size()} messages in`);
  }

  const skip = new Map<string, string>();
  let startedAt = 0;
  const config: AgentLoopConfig = {
    model: using.models[0],
    reasoning: THINKING,
    apiKey: using.apiKey,
    // One quick try again for a blip; anything longer is this file's backoff.
    maxRetries: 1,
    toolExecution: 'sequential',
    convertToLlm: (all) => all,
    prepareRequest: async () => {
      const model = await choose(using.models, skip);
      startedAt = Date.now();
      return { model };
    },
    // One turn at a time: the run keeps it, and looks at the chat's size, before the next.
    finishTurn: (turn) => {
      const m = turn.message;
      logCall(task.label, m, startedAt);
      if (m.stopReason !== 'error' && m.stopReason !== 'aborted') COOLING.delete(m.model);
      return { action: 'end' };
    },
  };

  /** What a failed call calls for: a wait, another model, or the end of the run when waiting can't fix it. */
  async function afterFailure(m: AssistantMessage) {
    const why = m.errorMessage ?? 'no reason given';
    const kind = failureOf(why);
    if (kind === 'signIn') {
      throw new Error(`Antigravity turned the sign-in away (${why.slice(0, 200)}): connect the account again from the admin page. The chat is kept, and the next run carries on from it.`);
    }
    if (kind === 'bad') {
      skip.set(m.model, `${m.model}: ${why.slice(0, 200)}`);
      return;
    }
    if (kind === 'rate') {
      const waited = await waitForLimits(using);
      if (waited) return;
    }
    cool(m.model, kind);
  }

  /** One call, and the tool calls in its answer run: the answer and their results. A failed call is waited out and made again. */
  async function turn(messages: AgentMessage[]): Promise<AgentMessage[]> {
    for (;;) {
      const fresh = await runAgentLoopContinue({ messages: [...messages], tools }, config, noEvents, undefined, using.stream);
      const answer = answerIn(fresh);
      if (answer && answer.stopReason === 'error') {
        await afterFailure(answer);
        continue;
      }
      if (answer && answer.stopReason === 'aborted') throw new Error('The run was stopped.');
      return fresh;
    }
  }

  /**
   * Compacts the chat: the model saves what isn't saved, then writes the work so far, and a new
   * segment starts with a fresh brief, that summary and the latest turns. False when there's
   * nothing older than the latest turn to fold.
   */
  async function compact(messages: AgentMessage[], tokens: number): Promise<boolean> {
    const from = keptFrom(chat.sent(), Math.floor(compactAt(using.models[0]) * KEEP_SHARE));
    if (from === null) return false;
    const ask: UserMessage = { role: 'user', content: COMPACT, timestamp: Date.now() };
    const folding = [...messages, ask];
    chat.fold([ask]);
    let summary = '';
    for (;;) {
      const fresh = await turn(folding);
      chat.fold(fresh);
      folding.push(...fresh);
      if (outcome.summary !== null) return true;
      const answer = answerIn(fresh);
      if (answer && !asksTools(answer)) {
        summary = textOf(answer);
        break;
      }
    }
    // What the tools saved is in the brief, so a fold with no summary still loses nothing that matters.
    let head = task.brief();
    if (summary) head = `${head}\n\n# The work so far\n\n${summary}`;
    chat.cut(from, head);
    console.log(`    ${task.chat}: compacted at about ${Math.round(tokens / 1000)}k tokens`);
    return true;
  }

  for (;;) {
    const sent = chat.sent().map((m) => m.message);
    const messages = [system, chat.head(), ...sent];
    const tokens = estimateContextTokens(messages as Message[]).tokens;
    if (tokens > compactAt(using.models[0])) {
      const folded = await compact(messages, tokens);
      if (outcome.summary !== null) break;
      if (folded) continue;
    }
    const last = messages[messages.length - 1];
    if (last.role === 'assistant') {
      // It stopped without finishing.
      chat.add([{ role: 'user', content: reminder(task), timestamp: Date.now() }]);
      continue;
    }
    chat.add(await turn(messages));
    if (outcome.summary !== null) break;
  }
  let summary = '';
  if (outcome.summary !== null) summary = outcome.summary;
  chat.finish(task.ask, summary);
  return summary;
}
