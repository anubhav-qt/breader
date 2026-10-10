import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CallError, chat } from '../nim.ts';

/*
 * A call asks for as long an answer as the model can give. Kimi K3 counts the prompt in its limit
 * too, so a call that asks for all of it is asked again for what the prompt leaves. NVIDIA is a
 * stand-in fetch here, with Kimi's limit and its own words for it.
 */

const LIMIT = 1_048_576;
const PROMPT = 129_334;
const ask = [{ role: 'user' as const, content: 'hello' }];

function answer(text: string) {
  const chunk = { choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: PROMPT, completion_tokens: 1 } };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { status: 200 });
}

function refuse(message: string) {
  const body = { error: { message, type: 'invalid_request_error', param: null, code: 400 } };
  return new Response(JSON.stringify(body), { status: 400 });
}

/** Kimi K3 on NVIDIA, noting each max_tokens it's asked for. */
function kimi(asked: number[]) {
  process.env.NVIDIA_NIM_API_KEY = 'test-key';
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    asked.push(body.max_tokens);
    if (PROMPT + body.max_tokens > LIMIT) {
      return refuse(`This model configuration accepts at most ${LIMIT} combined input and output tokens. However, your request has ${PROMPT} input tokens and asks for ${body.max_tokens} output tokens.`);
    }
    return answer('OK');
  }) as typeof fetch;
}

test('a model that counts the prompt in its limit is asked again for what the prompt leaves', async () => {
  const asked: number[] = [];
  kimi(asked);
  const reply = await chat('moonshotai/kimi-k3', ask, { maxTokens: LIMIT });
  assert.equal(reply.text, 'OK');
  assert.deepEqual(asked, [LIMIT, LIMIT - PROMPT]);
});

test('a call that fits is asked once', async () => {
  const asked: number[] = [];
  kimi(asked);
  await chat('moonshotai/kimi-k3', ask, { maxTokens: 1000 });
  assert.deepEqual(asked, [1000]);
});

test('any other refusal is not asked again', async () => {
  const asked: number[] = [];
  process.env.NVIDIA_NIM_API_KEY = 'test-key';
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    asked.push(JSON.parse(String(init?.body)).max_tokens);
    return refuse('Validation: Max tokens must not exceed 1048576, got 10000000');
  }) as typeof fetch;
  await assert.rejects(chat('moonshotai/kimi-k3', ask, { maxTokens: 10_000_000 }), (e) => e instanceof CallError && e.kind === 'bad');
  assert.deepEqual(asked, [10_000_000]);
});
