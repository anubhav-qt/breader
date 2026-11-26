import { log } from '../log.ts';
import { nvidiaKey } from '../jobs/cliproxy.ts';
import { cliproxyFor, cliproxyKeys } from './cliproxy.ts';

/*
 * The model for the small jobs that tidy what readers see: telling which series a search found are
 * one (manga/same.ts), checking Browse's lists hold what their tab says (manga/curate.ts) and
 * filling in what nobody gave a book (jobs/fill.ts). Codex's GPT-6.1 Terra at medium thinking,
 * through the worker's CLIProxyAPI, first. NVIDIA's Nemotron 3.5 Super, asked straight with the
 * NVIDIA key the marker uses, is the backup: a call Codex can't answer goes to it, and when Codex
 * is down NVIDIA keeps the calls for BACKUP_MS, then Codex is asked again. On NVIDIA a "low" job
 * has its thinking off: it answers in a few seconds and still right. Only the laptop asks
 * (api.ts); the fallback goes by what's been told already. Each answer is JSON, and every caller
 * keeps it with the model that gave it, so a thing is asked about once.
 */

export type Thinking = 'low' | 'medium' | 'high';
/** Codex's model for the small jobs, and how hard it thinks. */
export const CODEX_MODEL = 'gpt-6.1-terra';
const CODEX_EFFORT = 'medium';
/** NVIDIA's model for the small jobs, by its id there. */
export const NVIDIA_MODEL = 'nvidia/nemotron-3.5-super-vl-120b-a12b';
const NIM_CHAT = 'https://integrate.api.nvidia.com/v1/chat/completions';
/** Room for the thinking and the answer. */
const MAX_TOKENS = 16_000;
/** Calls at once: the rest wait their turn, so a busy Browse doesn't use up the accounts' limits. */
const AT_ONCE = 2;
/** How long NVIDIA keeps the calls once Codex is down. */
export const BACKUP_MS = 10 * 60_000;

/** A JSON answer, and the model that gave it, with its thinking, as kept beside each answer. */
export interface Told<T> {
  value: T;
  model: string;
}

export interface Tidier {
  /** The model's JSON answer to the prompt, or a throw when it can't be had in time, counted from its turn. */
  json<T>(system: string, prompt: string, o: { timeout: number; thinking: Thinking }): Promise<Told<T>>;
}

/** Text the model wrote as JSON, with the fences it sometimes puts round it taken off. */
export function parseJson<T>(text: string): T {
  const bare = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(bare) as T;
}

/** One chat-completions endpoint the tidier asks: where, with which key, and what it adds to a call. */
interface Door {
  name: string;
  url: string;
  key: string;
  body(thinking: Thinking): Record<string, unknown>;
  model(thinking: Thinking): string;
}

/** A call that came back but wasn't an answer: the model was there, so Codex isn't down. */
class NotJson extends Error {}

function codexDoor(env: { ADMIN_TOKEN?: string; CLIPROXY_URL?: string }): Door | null {
  const proxy = cliproxyFor(env);
  if (!proxy || !env.ADMIN_TOKEN) return null;
  return {
    name: 'Codex',
    url: `${proxy.url}/v1/chat/completions`,
    key: cliproxyKeys(env.ADMIN_TOKEN).apiKey,
    body: () => ({ model: CODEX_MODEL, reasoning_effort: CODEX_EFFORT }),
    model: () => `${CODEX_MODEL}:${CODEX_EFFORT}`,
  };
}

function nvidiaDoor(key: string | null): Door | null {
  if (!key) return null;
  return {
    name: 'NVIDIA',
    url: NIM_CHAT,
    key,
    body: (thinking) => ({ model: NVIDIA_MODEL, chat_template_kwargs: { enable_thinking: thinking !== 'low' } }),
    model: (thinking) => `${NVIDIA_MODEL}:${thinking}`,
  };
}

/**
 * Codex first and NVIDIA behind it, or whichever of them is here; null where neither is (no
 * ADMIN_TOKEN for the proxy, and no NVIDIA key).
 */
export function makeTidier(
  env: { ADMIN_TOKEN?: string; CLIPROXY_URL?: string },
  fetcher: typeof fetch = fetch,
  key = keyFor(env),
  now: () => number = Date.now,
): Tidier | null {
  const codex = codexDoor(env);
  const nvidia = nvidiaDoor(key);
  if (!codex && !nvidia) return null;
  /** Until when NVIDIA has the calls, because Codex was down. */
  let backupUntil = 0;

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

  async function ask<T>(door: Door, system: string, prompt: string, o: { timeout: number; thinking: Thinking }): Promise<Told<T>> {
    const res = await fetcher(door.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${door.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...door.body(o.thinking),
        temperature: 0,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(o.timeout),
    });
    if (!res.ok) {
      const why = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`${door.name} answered ${res.status}: ${why}`);
    }
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
    const text = body.choices?.[0]?.message?.content ?? '';
    try {
      return { value: parseJson<T>(text), model: door.model(o.thinking) };
    } catch (err) {
      log.warn({ err, text: text.slice(0, 200) }, `${door.name}’s answer wasn’t JSON`);
      throw new NotJson(`${door.name}’s answer wasn’t JSON`);
    }
  }

  /** The doors to try for one call, in order. */
  function doors(): Door[] {
    const order: Door[] = [];
    const codexUp = now() >= backupUntil;
    if (codex && codexUp) order.push(codex);
    if (nvidia) order.push(nvidia);
    // While NVIDIA has the calls, Codex is still asked when NVIDIA can't answer.
    if (codex && !codexUp) order.push(codex);
    return order;
  }

  return {
    json<T>(system: string, prompt: string, o: { timeout: number; thinking: Thinking }) {
      // From its turn, so work queued behind a busy Browse isn't timed out waiting. Whoever's waiting
      // on an answer waits only so long anyway (manga/same.ts).
      return turn(async () => {
        let last: unknown = null;
        for (const door of doors()) {
          try {
            return await ask<T>(door, system, prompt, o);
          } catch (err) {
            last = err;
            const down = door === codex && !(err instanceof NotJson);
            if (down && now() >= backupUntil) {
              backupUntil = now() + BACKUP_MS;
              log.warn({ err, until: new Date(backupUntil).toISOString() }, 'Codex can’t answer: NVIDIA takes the small jobs');
            }
          }
        }
        throw last;
      });
    },
  };
}

function keyFor(env: { ADMIN_TOKEN?: string }): string | null {
  if (!env.ADMIN_TOKEN) return process.env.NVIDIA_NIM_API_KEY ?? null;
  return nvidiaKey(env.ADMIN_TOKEN);
}
