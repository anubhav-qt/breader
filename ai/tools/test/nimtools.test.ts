import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

/*
 * NVIDIA's models in the harness, without NVIDIA: how pi's chat and tools read to NVIDIA, how a
 * streamed answer adds up, and what comes back on a call, a failure and a broken answer.
 */

process.env.AI_WORK = mkdtempSync(join(tmpdir(), 'breader-ai-test-'));
// No proxy here, only the NVIDIA key.
delete process.env.CLIPROXY_URL;
process.env.NVIDIA_NIM_API_KEY = 'nv-test-key';
const { nimMessages, nimModel, nimStream, nimTools } = await import('../nimtools.ts');
const { brain, routed } = await import('../harness.ts');
const { noHarness } = await import('../proxy.ts');
const { Type, toToolDeclaration } = await import('../../pi/pi-ai/src/index.ts');

const search = { name: 'web_search', description: 'Searches the web.', parameters: Type.Object({ query: Type.String() }) };

/** A chat with a system line and its tool, a question, a call, its result and a word after. */
function chat() {
  return {
    messages: [
      { role: 'system', content: 'You research books.', toolsAdded: [toToolDeclaration(search)], timestamp: 0 },
      { role: 'user', content: [{ type: 'text', text: 'Who wrote it?' }], timestamp: 1 },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'I should search.' },
          { type: 'text', text: 'Searching.' },
          { type: 'toolCall', id: 'call_1', name: 'web_search', arguments: { query: 'author' } },
        ],
        api: 'google-generative-ai',
        provider: 'nvidia',
        model: 'nim-x',
        usage: {},
        stopReason: 'toolUse',
        timestamp: 2,
      },
      { role: 'toolResult', toolCallId: 'call_1', toolName: 'web_search', content: [{ type: 'text', text: 'Results.' }], isError: false, timestamp: 3 },
    ],
  } as never;
}

/** A fetch that answers once with these stream lines, keeping what was sent. */
function streaming(lines: unknown[], status = 200) {
  const sent: Array<{ url: string; body: Record<string, unknown>; auth: string }> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).authorization });
    if (status !== 200) return new Response('{"detail":"no"}', { status });
    const text = lines.map((l) => `data: ${typeof l === 'string' ? l : JSON.stringify(l)}\n\n`).join('');
    return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
  return { sent, fetcher };
}

const model = nimModel('nvidia/nemotron-3.5-super-vl-120b-a12b');

test('an NVIDIA model goes by its alias in the harness and its own id at NVIDIA', () => {
  assert.equal(model.id, 'nim-nvidia--nemotron-3.5-super-vl-120b-a12b');
  assert.equal(model.name, 'nvidia/nemotron-3.5-super-vl-120b-a12b');
  assert.equal(model.provider, 'nvidia');
});

test('pi’s chat reads to NVIDIA as OpenAI’s messages, without the thinking', () => {
  assert.deepEqual(nimMessages(chat()), [
    { role: 'system', content: 'You research books.' },
    { role: 'user', content: 'Who wrote it?' },
    { role: 'assistant', content: 'Searching.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"author"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'Results.' },
  ]);
});

test('the chat’s tools go as functions with their JSON schema', () => {
  const tools = nimTools(chat());
  assert.equal(tools.length, 1);
  assert.equal(tools[0].type, 'function');
  assert.equal(tools[0].function.name, 'web_search');
  assert.equal(tools[0].function.parameters.type, 'object');
  assert.deepEqual(Object.keys(tools[0].function.parameters.properties), ['query']);
});

test('a streamed call adds up to one tool call, with the thinking and usage', async () => {
  const { sent, fetcher } = streaming([
    { choices: [{ delta: { reasoning_content: 'Let me ' } }] },
    { choices: [{ delta: { reasoning_content: 'look.' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c9', function: { name: 'web_', arguments: '{"que' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'search', arguments: 'ry":"Holo"}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 } } },
    '[DONE]',
  ]);
  const message = await nimStream(model, chat(), undefined, fetcher, 'nv-key').result();
  assert.equal(message.stopReason, 'toolUse');
  assert.deepEqual(message.content, [
    { type: 'thinking', thinking: 'Let me look.' },
    { type: 'toolCall', id: 'c9', name: 'web_search', arguments: { query: 'Holo' } },
  ]);
  assert.equal(message.usage.input, 60);
  assert.equal(message.usage.cacheRead, 40);
  assert.equal(message.usage.output, 20);
  assert.equal(sent[0].url, 'https://integrate.api.nvidia.com/v1/chat/completions');
  assert.equal(sent[0].auth, 'Bearer nv-key');
  assert.equal(sent[0].body.model, 'nvidia/nemotron-3.5-super-vl-120b-a12b');
  assert.equal(sent[0].body.stream, true);
  assert.deepEqual(sent[0].body.chat_template_kwargs, { enable_thinking: true });
  assert.equal((sent[0].body.tools as unknown[]).length, 1);
});

test('a plain answer stops as one', async () => {
  const { fetcher } = streaming([{ choices: [{ delta: { content: 'Isuna ' } }] }, { choices: [{ delta: { content: 'Hasekura.' }, finish_reason: 'stop' }] }]);
  const message = await nimStream(model, chat(), undefined, fetcher, 'k').result();
  assert.equal(message.stopReason, 'stop');
  assert.deepEqual(message.content, [{ type: 'text', text: 'Isuna Hasekura.' }]);
});

test('NVIDIA saying no is an error that starts with its status, as the harness reads it', async () => {
  const { fetcher } = streaming([], 429);
  const message = await nimStream(model, chat(), undefined, fetcher, 'k').result();
  assert.equal(message.stopReason, 'error');
  assert.match(message.errorMessage ?? '', /^429 from NVIDIA/);
});

test('an answer cut off before its finish, a broken stream and arguments that aren’t JSON are errors', async () => {
  const cut = streaming([{ choices: [{ delta: { content: 'Isu' } }] }]);
  assert.match((await nimStream(model, chat(), undefined, cut.fetcher, 'k').result()).errorMessage ?? '', /ended without a finish/);
  const broken = streaming([{ error: { message: 'overloaded' } }]);
  assert.match((await nimStream(model, chat(), undefined, broken.fetcher, 'k').result()).errorMessage ?? '', /stream broke: overloaded/);
  const muddled = streaming([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'web_search', arguments: '{nope' } }] }, finish_reason: 'tool_calls' }] }]);
  assert.match((await nimStream(model, chat(), undefined, muddled.fetcher, 'k').result()).errorMessage ?? '', /weren’t JSON/);
});

test('with the NVIDIA key and no proxy, the harness runs on NVIDIA’s first and second alone', async () => {
  assert.equal(noHarness(), null);
  const b = await brain();
  assert.deepEqual(b.models.map((m) => m.name), ['nvidia/nemotron-3.5-super-vl-120b-a12b', 'nvidia/nemotron-3-ultra-550b-a55b']);
  assert.equal(b.models[0].provider, 'nvidia');
  assert.equal(await b.opensAt(), null);
});

test('a task with no stage pick keeps the brain as it is', async () => {
  const b = await brain();
  assert.equal(routed(b, { other: true }), b);
});
