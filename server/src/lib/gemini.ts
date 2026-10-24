import { log } from '../log.ts';
import { cliproxyFor, cliproxyKeys } from './cliproxy.ts';

/*
 * Gemini, for the small jobs that tidy what readers see: telling which series a search found are
 * one (manga/same.ts), checking Browse's lists hold what their tab says (manga/curate.ts) and
 * filling in what nobody gave a book (jobs/fill.ts). Through CLIProxyAPI on the Antigravity
 * accounts the owner connected from the admin page, the way the AI marker's harness (ai/tools)
 * reaches it, with Gemini 3.8 Flash at the thinking each job asks for (as Seelie asks it). The worker that holds the
 * lease runs the proxy (jobs/cliproxy.ts), so only the laptop reaches it; the fallback goes by
 * what's been told already. Each answer is JSON, and every caller keeps it, so a thing is asked
 * about once.
 */

export type Thinking = 'low' | 'medium' | 'high';
/** The one model the proxy serves Flash as; its thinking is set on each call. */
export const MODEL = 'gemini-3.8-flash-high';
/** Calls at once: the rest wait their turn, so a busy Browse doesn't use up the accounts. */
const AT_ONCE = 2;

export interface Gemini {
  /** Gemini's JSON answer to the prompt, or a throw when it can't be had in time, counted from its turn. */
  json<T>(system: string, prompt: string, o: { timeout: number; thinking: Thinking }): Promise<T>;
  /** The model that answered, with its thinking, as kept beside each answer. */
  model(thinking: Thinking): string;
}

interface Part {
  text?: string;
  thought?: boolean;
}

/** Text Gemini wrote as JSON, with the fences it sometimes puts round it taken off. */
export function parseJson<T>(text: string): T {
  const bare = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(bare) as T;
}

/** Gemini through the worker's proxy, or null where there's none (no ADMIN_TOKEN). */
export function makeGemini(env: { ADMIN_TOKEN?: string; CLIPROXY_URL?: string }, fetcher: typeof fetch = fetch): Gemini | null {
  const proxy = cliproxyFor(env);
  if (!proxy || !env.ADMIN_TOKEN) return null;
  const { url } = proxy;
  const key = cliproxyKeys(env.ADMIN_TOKEN).apiKey;
  const headers = { authorization: `Bearer ${key}`, 'x-goog-api-key': key, 'content-type': 'application/json' };

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
        const res = await fetcher(`${url}/v1beta/models/${MODEL}:generateContent`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0, thinkingConfig: { thinkingLevel: o.thinking } },
          }),
          signal: AbortSignal.timeout(o.timeout),
        });
        if (!res.ok) {
          const why = (await res.text().catch(() => '')).slice(0, 200);
          throw new Error(`Gemini answered ${res.status}: ${why}`);
        }
        const body = (await res.json()) as { candidates?: Array<{ content?: { parts?: Part[] } }> };
        const text = (body.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought && p.text).map((p) => p.text).join('');
        try {
          return parseJson<T>(text);
        } catch (err) {
          log.warn({ err, text: text.slice(0, 200) }, 'Gemini’s answer wasn’t JSON');
          throw err;
        }
      });
    },
  };
}
