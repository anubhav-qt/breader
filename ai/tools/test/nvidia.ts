/*
 * A stand-in for NVIDIA's API: fetch answers every call from the test's script, so the tests
 * never reach the network or use the real key.
 */

/** An HTTP status, or the answer's text ('' is an empty answer). */
export type Say = number | string;

/** Every call made, in order: the model and the end of the last message. */
export const calls: Array<{ model: string; user: string }> = [];

export function answerWith(answer: (model: string, user: string) => Say) {
  process.env.NVIDIA_NIM_API_KEY = 'test-key';
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const user: string = body.messages.at(-1).content;
    calls.push({ model: body.model, user });
    const say = answer(body.model, user);
    if (typeof say === 'number') return new Response('{"error":"from the test"}', { status: say });
    const chunk = { choices: [{ delta: { content: say }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { status: 200 });
  }) as typeof fetch;
}

/** Answers by model, each call taking the next one in its list, the last one again and again. */
export function answerByModel(script: Record<string, Say[]>) {
  answerWith((model) => {
    const list = script[model];
    if (!list) throw new Error(`The test has nothing for ${model} to say.`);
    if (list.length > 1) return list.shift()!;
    return list[0];
  });
}
