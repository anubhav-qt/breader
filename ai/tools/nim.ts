import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AI } from './lib.ts';
import { unseal } from './seal.ts';

/*
 * NVIDIA's free API (build.nvidia.com), OpenAI style and always streamed: its gateway drops a call
 * that has sent nothing for 300 s, and a big model can sit in a queue for minutes before its first
 * token. The key is NVIDIA_NIM_API_KEY, from the environment or ai/.env (the main checkout's, in a
 * worktree), or on the server, ai/nvidia-key.enc opened with its ADMIN_TOKEN (seal.ts). It is
 * never printed.
 */

const URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
export const SEALED = join(AI, 'nvidia-key.enc');

export interface Key {
  key: string;
  from: string;
}

function fromEnvFiles(): Key | null {
  const files = [join(AI, '.env')];
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: AI, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    files.push(join(dirname(common), 'ai/.env'));
  } catch { /* not a git checkout */ }
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*NVIDIA_NIM_API_KEY\s*=\s*(.*?)\s*$/);
      if (m?.[1]) return { key: m[1].replace(/^(["'])(.*)\1$/, '$2'), from: file };
    }
  }
  return null;
}

function fromSealed(): Key | null {
  const token = process.env.ADMIN_TOKEN;
  if (!token || !existsSync(SEALED)) return null;
  try {
    return { key: unseal(readFileSync(SEALED, 'utf8').trim(), token), from: 'ai/nvidia-key.enc' };
  } catch {
    throw new Error('ai/nvidia-key.enc doesn’t open with this ADMIN_TOKEN. Seal it again: npm --prefix ai run seal.');
  }
}

let cached: Key | null = null;

/** The key, and where it came from. Throws when there's none. */
export function nvidiaKey(): Key {
  if (cached) return cached;
  if (process.env.NVIDIA_NIM_API_KEY) {
    cached = { key: process.env.NVIDIA_NIM_API_KEY, from: 'the environment' };
    return cached;
  }
  cached = fromEnvFiles() ?? fromSealed();
  if (!cached) throw new Error('No NVIDIA_NIM_API_KEY in ai/.env or the environment, and no ai/nvidia-key.enc with an ADMIN_TOKEN to open it.');
  return cached;
}

/**
 * Why a call failed, which decides what happens next.
 * rate: 429. busy: 5xx or "overloaded". slow: 504, a timeout, a dropped stream. empty: an answer
 * with no text, which a model can keep giving one prompt (a scene it won't touch) while it answers
 * others. cut: the answer hit max_tokens. bad: 4xx, the request itself is wrong. gone: 401, 403 or
 * 404, the model isn't open to this key.
 */
export type Failure = 'rate' | 'busy' | 'slow' | 'empty' | 'cut' | 'bad' | 'gone';

export class CallError extends Error {
  /**
   * room: when a call asked for more than its prompt leaves of the model's limit, the most it can
   * ask for.
   */
  constructor(public kind: Failure, message: string, public retryAfterS?: number, public room?: number) {
    super(message);
  }
}

/**
 * Kimi K3 counts the prompt and the answer together against its limit, and says so when a call
 * asks for more: "This model configuration accepts at most 1048576 combined input and output
 * tokens. However, your request has 129334 input tokens and asks for ...".
 */
const SHARED_LIMIT = /at most (\d+) combined input and output tokens\. However, your request has (\d+) input tokens/;

/** What an error's prompt leaves of the model's limit, or undefined when the error isn't about that. */
function roomLeft(body: string): number | undefined {
  const m = body.match(SHARED_LIMIT);
  if (!m) return undefined;
  return Number(m[1]) - Number(m[2]);
}

export interface Msg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface Reply {
  text: string;
  thinkChars: number;
  promptTokens: number;
  outTokens: number;
  /** Seconds to the first token, thinking included: mostly time in NVIDIA's queue. */
  firstS: number;
  secs: number;
}

export interface ChatOptions {
  maxTokens: number;
  extra?: Record<string, unknown>;
  /** Longest wait for the first token. */
  firstS?: number;
  /** Longest silence once the answer has started. */
  idleS?: number;
}

function kindOf(status: number): Failure {
  if (status === 429) return 'rate';
  if (status === 401 || status === 403 || status === 404) return 'gone';
  if (status === 504 || status === 408) return 'slow';
  if (status >= 500) return 'busy';
  return 'bad';
}

/**
 * A call to one of NVIDIA's models, asking for as long an answer as the model can give (kimi.ts,
 * LADDER). A model that counts the prompt against that too is asked again for what the prompt
 * leaves.
 */
export async function chat(model: string, messages: Msg[], o: ChatOptions): Promise<Reply> {
  try {
    return await once(model, messages, o);
  } catch (e) {
    if (!(e instanceof CallError)) throw e;
    const room = e.room;
    if (room === undefined || room <= 0) throw e;
    return once(model, messages, { ...o, maxTokens: room });
  }
}

async function once(model: string, messages: Msg[], o: ChatOptions): Promise<Reply> {
  const t0 = Date.now();
  const ctl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let why = '';
  const arm = (s: number, what: string) => {
    clearTimeout(timer);
    timer = setTimeout(() => { why = what; ctl.abort(); }, s * 1000);
  };
  arm(o.firstS ?? 600, 'no first token');

  let text = '';
  let thinkChars = 0;
  let first = 0;
  let finish = '';
  let usage: { prompt_tokens?: number; completion_tokens?: number } = {};
  try {
    const res = await fetch(URL, {
      method: 'POST',
      signal: ctl.signal,
      headers: { Authorization: `Bearer ${nvidiaKey().key}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: o.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
        ...o.extra,
      }),
    });
    if (!res.ok || !res.body) {
      const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ');
      const after = Number(res.headers.get('retry-after'));
      throw new CallError(kindOf(res.status), `HTTP ${res.status} ${body.slice(0, 160)}`, after > 0 ? after : undefined, roomLeft(body));
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let ev: {
          error?: unknown;
          usage?: typeof usage;
          choices?: Array<{ delta?: { content?: string; reasoning_content?: string; reasoning?: string }; finish_reason?: string }>;
        };
        try { ev = JSON.parse(data); } catch { continue; }
        if (ev.error) {
          const msg = JSON.stringify(ev.error).slice(0, 160);
          throw new CallError(/overload|unavailable|capacity/i.test(msg) ? 'busy' : /rate|too many/i.test(msg) ? 'rate' : 'slow', `stream error ${msg}`);
        }
        if (ev.usage) usage = ev.usage;
        for (const ch of ev.choices ?? []) {
          const d = ch.delta ?? {};
          const think = d.reasoning_content ?? d.reasoning ?? '';
          if (!first && (d.content || think)) first = Date.now();
          if (first) arm(o.idleS ?? 240, 'the answer stalled');
          text += d.content ?? '';
          thinkChars += think.length;
          if (ch.finish_reason) finish = ch.finish_reason;
        }
      }
    }
  } catch (e) {
    if (e instanceof CallError) throw e;
    if (why) throw new CallError('slow', why);
    throw new CallError('slow', `network: ${e instanceof Error ? e.message : String(e)}`.slice(0, 160));
  } finally {
    clearTimeout(timer);
  }

  text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (finish === 'length') throw new CallError('cut', `the answer hit max_tokens (${o.maxTokens})`);
  if (!text) throw new CallError('empty', `an empty answer (finish ${finish || 'none'}, ${thinkChars} characters of thinking)`);
  return {
    text,
    thinkChars,
    promptTokens: usage.prompt_tokens ?? 0,
    outTokens: usage.completion_tokens ?? 0,
    firstS: first ? (first - t0) / 1000 : 0,
    secs: (Date.now() - t0) / 1000,
  };
}
