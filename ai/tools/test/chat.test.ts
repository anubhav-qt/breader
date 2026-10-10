import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AssistantMessage, Message, Model } from '../../pi/pi-ai/src/index.ts';
import type { Brain, Numbered, Task } from '../harness.ts';

/*
 * The harness's chats, with a pretend Gemini: each job is done in one chat kept in its file, a
 * run that fails is carried on by the next from where the chat stopped, a finished chat takes the
 * next job, and a chat past its limit is compacted, its older turns folding into a summary while
 * the file keeps them all.
 */

process.env.AI_WORK = mkdtempSync(join(tmpdir(), 'breader-ai-test-'));
const { COMPACT_AT, compactAt, keptFrom, runAgent, tool } = await import('../harness.ts');
const { createAssistantMessageEventStream, Type } = await import('../../pi/pi-ai/src/index.ts');

const NO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function model(contextWindow: number, maxTokens: number): Model<'google-generative-ai'> {
  return {
    id: 'gemini-pretend',
    name: 'gemini-pretend',
    api: 'google-generative-ai',
    provider: 'antigravity',
    baseUrl: 'http://pretend',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: true,
    contextWindow,
    maxTokens,
  };
}

/** What the pretend Gemini answers: some text, tool calls, or a failure. */
interface Reply {
  text?: string;
  calls?: Array<[string, Record<string, unknown>]>;
  error?: string;
}

let callIds = 0;

function answer(id: string, reply: Reply): AssistantMessage {
  const content: AssistantMessage['content'] = [];
  if (reply.text) content.push({ type: 'text', text: reply.text });
  for (const [name, args] of reply.calls ?? []) {
    callIds++;
    content.push({ type: 'toolCall', id: `call-${callIds}`, name, arguments: args as never });
  }
  let stopReason: AssistantMessage['stopReason'] = 'stop';
  if (content.some((c) => c.type === 'toolCall')) stopReason = 'toolUse';
  if (reply.error) stopReason = 'error';
  return {
    role: 'assistant',
    content,
    api: 'google-generative-ai',
    provider: 'antigravity',
    model: id,
    usage: NO_USAGE,
    stopReason,
    errorMessage: reply.error,
    timestamp: Date.now(),
  };
}

/** A pretend Gemini that answers each call with `say`, from what it was sent, and keeps what every call was sent. */
function pretend(say: (messages: Message[]) => Reply, m = model(1_000_000, 32_000)) {
  const calls: Message[][] = [];
  const brain: Brain = {
    models: [m],
    apiKey: 'none',
    opensAt: async () => null,
    stream: (used, context) => {
      calls.push([...context.messages]);
      const s = createAssistantMessageEventStream();
      const message = answer(used.id, say(context.messages));
      s.push({ type: 'start', partial: message });
      if (message.stopReason === 'error') {
        s.push({ type: 'error', reason: 'error', error: message });
      } else {
        s.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
      }
      return s;
    },
  };
  return { brain, calls };
}

/** A job putting books on a shelf: unfinished until the shelf has `wanted` books. */
function shelving(chat: string, ask: string, shelf: string[], wanted: number): Task {
  return {
    chat,
    ask,
    system: 'You put books on a shelf.',
    brief: () => `Put books on the shelf until it has ${wanted}. On it now: ${shelf.length}.`,
    tools: [
      tool('shelve', 'Puts a book on the shelf.', Type.Object({ book: Type.String() }), (args) => {
        shelf.push(args.book);
        return `On the shelf: ${shelf.length}.`;
      }),
    ],
    unfinished: () => {
      if (shelf.length < wanted) return `${wanted - shelf.length} still to shelve.`;
      return null;
    },
    label: { job: 'test' },
  };
}

function textOf(m: Message): string {
  if (typeof m.content === 'string') return m.content;
  const parts: string[] = [];
  for (const c of m.content) {
    if (c.type === 'text') parts.push(c.text);
  }
  return parts.join('\n');
}

function answers(messages: Message[]): AssistantMessage[] {
  const found: AssistantMessage[] = [];
  for (const m of messages) {
    if (m.role === 'assistant') found.push(m);
  }
  return found;
}

function calledFor(messages: Message[], name: string): Array<Record<string, unknown>> {
  const args: Array<Record<string, unknown>> = [];
  for (const m of answers(messages)) {
    for (const c of m.content) {
      if (c.type === 'toolCall' && c.name === name) args.push(c.arguments as Record<string, unknown>);
    }
  }
  return args;
}

function lastOf(messages: Message[]): Message {
  return messages[messages.length - 1];
}

/** The first message after the system's: the chat's head. */
function headOf(messages: Message[]): string {
  return textOf(messages[1]);
}

test('a chat is compacted at 400k, or sooner when the model’s window can’t take that and an answer', () => {
  assert.equal(compactAt(model(1_000_000, 32_000)), COMPACT_AT);
  assert.equal(COMPACT_AT, 400_000);
  assert.equal(compactAt(model(128_000, 16_000)), 112_000);
  // A model that can answer with most of its window gets half of it for the chat.
  assert.equal(compactAt(model(100_000, 80_000)), 50_000);
});

/** A chat's messages, numbered from 1: 'a' an answer, 'r' a tool's result, 'u' a user message, each `chars` long. */
function numbered(roles: string, chars: number): Numbered[] {
  const list: Numbered[] = [];
  let n = 0;
  for (const role of roles) {
    n++;
    const text = 'x'.repeat(chars);
    if (role === 'a') list.push({ n, message: answer('gemini-pretend', { text }) });
    if (role === 'r') {
      list.push({ n, message: { role: 'toolResult', toolCallId: 'c', toolName: 't', content: [{ type: 'text', text }], isError: false, timestamp: 0 } });
    }
    if (role === 'u') list.push({ n, message: { role: 'user', content: text, timestamp: 0 } });
  }
  return list;
}

test('with fewer than two answers there’s nothing to fold', () => {
  assert.equal(keptFrom(numbered('ar', 4000), 1_000_000), null);
  assert.equal(keptFrom([], 1_000_000), null);
});

test('the latest turn is kept however big it is, and the oldest always folds', () => {
  const sent = numbered('ararar', 4000);
  assert.equal(keptFrom(sent, 10), 5);
  assert.equal(keptFrom(sent, 1_000_000), 3);
});

test('newer turns are kept word for word while they fit', () => {
  // Each turn is 2,000 tokens: two fit in 4,500, three don't.
  assert.equal(keptFrom(numbered('arararar', 4000), 4_500), 5);
});

test('a cut falls only before an answer, so a message from us goes with the turn before it', () => {
  assert.equal(keptFrom(numbered('aruar', 40), 0), 4);
});

test('a run that fails is carried on by the next from where its chat stopped, losing nothing', async () => {
  const shelf: string[] = [];
  let made = 0;
  const first = pretend(() => {
    made++;
    if (made === 1) return { calls: [['shelve', { book: 'first' }]] };
    return { error: '401 Unauthorized' };
  });
  await assert.rejects(runAgent(shelving('resume', 'shelf', shelf, 2), first.brain), /turned the sign-in away.*The chat is kept/s);
  assert.deepEqual(shelf, ['first']);
  // And a power cut mid-write left a line cut short.
  appendFileSync(join(process.env.AI_WORK!, 'chats', 'resume.jsonl'), '{"kind":"message","n":3,"mess');

  const second = pretend((messages) => {
    if (calledFor(messages, 'shelve').length < 2) return { calls: [['shelve', { book: 'second' }]] };
    return { calls: [['finish', { summary: 'Shelved.' }]] };
  });
  const summary = await runAgent(shelving('resume', 'shelf', shelf, 2), second.brain);
  assert.equal(summary, 'Shelved.');
  assert.deepEqual(shelf, ['first', 'second'], 'the book shelved before the failure isn’t shelved again');
  // The same chat: its first brief, and the call made before the failure.
  const sent = second.calls[0];
  assert.match(headOf(sent), /On it now: 0\./);
  assert.deepEqual(calledFor(sent, 'shelve'), [{ book: 'first' }]);
});

/** How many books the latest brief in the chat asks for. */
function wantedIn(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const found = textOf(m).match(/until it has (\d+)/);
    if (found) return Number(found[1]);
  }
  return 0;
}

test('a finished chat takes the next job, asked at its end', async () => {
  const shelf: string[] = [];
  const gemini = pretend((messages) => {
    if (shelf.length < wantedIn(messages)) return { calls: [['shelve', { book: `book ${shelf.length + 1}` }]] };
    return { calls: [['finish', { summary: `Shelf at ${shelf.length}.` }]] };
  });

  assert.equal(await runAgent(shelving('jobs', 'volume 1', shelf, 1), gemini.brain), 'Shelf at 1.');
  const before = gemini.calls.length;
  assert.equal(await runAgent(shelving('jobs', 'volume 2', shelf, 2), gemini.brain), 'Shelf at 2.');

  // The second job's first call has the first job's chat, then its brief at the end.
  const sent = gemini.calls[before];
  assert.match(headOf(sent), /until it has 1\./);
  assert.equal(calledFor(sent, 'finish').length, 1);
  assert.equal(lastOf(sent).role, 'user');
  assert.match(textOf(lastOf(sent)), /until it has 2\. On it now: 1\./);
});

test('a chat past its limit is compacted: what folds leaves what’s sent, the file keeps it all', async () => {
  const dusty = 'dust '.repeat(800);
  let looked = 0;
  const task: Task = {
    chat: 'compact',
    ask: 'look',
    system: 'You look around.',
    brief: () => `Look around. Looked so far: ${looked}.`,
    tools: [
      tool('look', 'Looks around.', Type.Object({}), () => {
        looked++;
        return dusty;
      }),
    ],
    unfinished: () => null,
    label: { job: 'test' },
  };
  // Compacted past 3,600 tokens; each look's result is about 1,000.
  const gemini = pretend((messages) => {
    const last = lastOf(messages);
    if (last.role === 'user' && /about to be cut short/.test(textOf(last))) return { text: 'Looked four times.' };
    if (/# The work so far/.test(headOf(messages))) return { calls: [['finish', { summary: 'Done looking.' }]] };
    return { calls: [['look', {}]] };
  }, model(4_000, 400));

  assert.equal(await runAgent(task, gemini.brain), 'Done looking.');
  assert.equal(looked, 4);

  const asked = gemini.calls.filter((sent) => /about to be cut short/.test(textOf(lastOf(sent))));
  assert.equal(asked.length, 1, 'the model is asked once for the work so far');
  assert.equal(calledFor(asked[0], 'look').length, 4, 'with every turn in view');

  const after = gemini.calls[gemini.calls.length - 1];
  assert.match(headOf(after), /Looked so far: 4\.\n\n# The work so far\n\nLooked four times\./);
  assert.equal(calledFor(after, 'look').length, 1, 'only the latest turn is kept word for word');

  const file = readFileSync(join(process.env.AI_WORK!, 'chats', 'compact.jsonl'), 'utf8');
  assert.equal(file.match(/"name":"look"/g)?.length, 4, 'the file keeps every turn');
  assert.match(file, /"kind":"fold"/);
  assert.match(file, /"kind":"finished","ask":"look","summary":"Done looking\."/);
});
