import { log } from '../log.ts';
import { nvidiaKey } from '../jobs/cliproxy.ts';

/*
 * The model for the small jobs that tidy what readers see: telling which series a search found are
 * one (manga/same.ts), checking Browse's lists hold what their tab says (manga/curate.ts) and
 * filling in what nobody gave a book (jobs/fill.ts). NVIDIA's Nemotron 3.5 Super, asked straight,
 * with the NVIDIA key the marker uses. A "low" job has its thinking off: it answers in a few
 * seconds and still right. Only the laptop asks (api.ts); the fallback goes by what's been told
 * already. Each answer is JSON, and every caller keeps it, so a thing is asked about once.
 */

export type Thinking = 'low' | 'medium' | 'high';
/** NVIDIA's model for the small jobs, by its id there. */
export const MODEL = 'nvidia/nemotron-3.5-super-vl-120b-a12b';
const NIM_CHAT = 'https://integrate.api.nvidia.com/v1/chat/completions';
/** Room for the thinking and the answer. */
const MAX_TOKENS = 16_000;
/** Calls at once: the rest wait their turn, so a busy Browse doesn't use up the key's limits. */
const AT_ONCE = 2;

export interface Tidier {
  /** The model's JSON answer to the prompt, or a throw when it can't be had in time, counted from its turn. */
  json<T>(system: string, prompt: string, o: { timeout: number; thinking: Thinking }): Promise<T>;
  /** The model that answered, with its thinking, as kept beside each answer. */
  model(thinking: Thinking): string;
}

/** Text the model wrote as JSON, with the fences it sometimes puts round it taken off. */
export function parseJson<T>(text: string): T {
  const bare = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(bare) as T;
}

/** NVIDIA's model, or null where there's no NVIDIA key (nor ADMIN_TOKEN to open it). */
export function makeTidier(env: { ADMIN_TOKEN?: string }, fetcher: typeof fetch = fetch, key = keyFor(env)): Tidier | null {
  if (!key) return null;
  const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };

  let going = 0;
  const waiting: Array<() => void> = [];
  async function turn<T>(fn: () => Promise<T>): Promise<T> {
    if (going >= AT_ONCE) await new Promise<void>((go) => waiting.push(go));
    going += 1;
    try {
      return await fn();
    } finally {
      going -= 1;
      waiting.shift()?.();
    }
  }

  return {
    model: (thinking) => `${MODEL}:${thinking}`,
    json<T>(system: string, prompt: string, o: { timeout: number; thinking: Thinking }) {
      // From its turn, so work queued behind a busy Browse isn't timed out waiting. Whoever's waiting
      // on an answer waits only so long anyway (manga/same.ts).
      return turn(async () => {
        const res = await fetcher(NIM_CHAT, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: MODEL,
            temperature: 0,
            max_tokens: MAX_TOKENS,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: prompt },
            ],
            chat_template_kwargs: { enable_thinking: o.thinking !== 'low' },
          }),
          signal: AbortSignal.timeout(o.timeout),
        });
        if (!res.ok) {
          const why = (await res.text().catch(() => '')).slice(0, 200);
          throw new Error(`NVIDIA answered ${res.status}: ${why}`);
        }
        const body = (await res.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
        const text = body.choices?.[0]?.message?.content ?? '';
        try {
          return parseJson<T>(text);
        } catch (err) {
          log.warn({ err, text: text.slice(0, 200) }, 'NVIDIA’s answer wasn’t JSON');
          throw err;
        }
      });
    },
  };
}

function keyFor(env: { ADMIN_TOKEN?: string }): string | null {
  if (!env.ADMIN_TOKEN) return process.env.NVIDIA_NIM_API_KEY ?? null;
  return nvidiaKey(env.ADMIN_TOKEN);
}
