import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AI } from './lib.ts';

/*
 * NVIDIA's free API (build.nvidia.com), OpenAI style and always streamed: its gateway drops a call
 * that has sent nothing for 300 s, and a big model can sit in a queue for minutes before its first
 * token. The key is NVIDIA_NIM_API_KEY, from the environment or ai/.env (the main checkout's, in a
 * worktree). It is never printed.
 */

const URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

let cached: string | null = null;
function key(): string {
  if (cached) return cached;
  if (process.env.NVIDIA_NIM_API_KEY) return (cached = process.env.NVIDIA_NIM_API_KEY);
  const files = [join(AI, '.env')];
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: AI, encoding: 'utf8' }).trim();
    files.push(join(dirname(common), 'ai/.env'));
  } catch { /* not a git checkout */ }
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*NVIDIA_NIM_API_KEY\s*=\s*(.*?)\s*$/);
      if (m?.[1]) return (cached = m[1].replace(/^(["'])(.*)\1$/, '$2'));
    }
  }
  throw new Error('No NVIDIA_NIM_API_KEY in ai/.env or the environment.');
}

/**
 * Why a call failed, which decides what happens next.
 * rate: 429. busy: 5xx or "overloaded". slow: 504, a timeout, a dropped stream, an empty answer.
 * cut: the answer hit max_tokens. bad: 4xx, the request itself is wrong. gone: 401, 403 or 404,
 * the model isn't open to this key.
 */
export type Failure = 'rate' | 'busy' | 'slow' | 'cut' | 'bad' | 'gone';

export class CallError extends Error {
  constructor(public kind: Failure, message: string, public retryAfterS?: number) {
    super(message);
  }
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

export async function chat(model: string, messages: Msg[], o: ChatOptions): Promise<Reply> {
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
      headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
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
      const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
      const after = Number(res.headers.get('retry-after'));
      throw new CallError(kindOf(res.status), `HTTP ${res.status} ${body}`, after > 0 ? after : undefined);
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
  if (!text) throw new CallError('slow', `an empty answer (finish ${finish || 'none'}, ${thinkChars} characters of thinking)`);
  return {
    text,
    thinkChars,
    promptTokens: usage.prompt_tokens ?? 0,
    outTokens: usage.completion_tokens ?? 0,
    firstS: first ? (first - t0) / 1000 : 0,
    secs: (Date.now() - t0) / 1000,
  };
}
