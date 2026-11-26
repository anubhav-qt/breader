import {
  collapseSystemMessages,
  createAssistantMessageEventStream,
  getCurrentTools,
  getSystemMessageText,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type JsonObject,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from '../pi/pi-ai/src/index.ts';
import { nimAlias } from '../../shared/src/admin.ts';
import { NIM_BASE, nvidiaKey } from './nim.ts';

/*
 * NVIDIA's models in the harness (harness.ts), asked straight with the NVIDIA key, the way the
 * balancer asks them (nim.ts): OpenAI's chat format, always streamed, with the harness's tools.
 * pi speaks only Gemini's format, so this turns its chat into NVIDIA's and the answer back. The
 * model's id in the harness is its alias (nim-…, as accountOf knows it); its name is NVIDIA's id.
 */

/** The provider the harness gives NVIDIA's models, which picks this stream for them. */
export const NIM_PROVIDER = 'nvidia';
/** An NVIDIA model's window as the harness counts it: compacted well before most fill. */
const NIM_WINDOW = 128_000;
const NIM_MAX_TOKENS = 16_000;

/** pi's model for one of NVIDIA's, by NVIDIA's id. */
export function nimModel(id: string): Model<'google-generative-ai'> {
  return {
    id: nimAlias(id),
    name: id,
    // The harness's models share one type; this stream is what speaks to NVIDIA.
    api: 'google-generative-ai',
    provider: NIM_PROVIDER,
    baseUrl: NIM_BASE,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, xhigh: null, max: null },
    contextWindow: NIM_WINDOW,
    maxTokens: NIM_MAX_TOKENS,
  };
}

interface OpenAiCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

type OpenAiMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: OpenAiCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

function textOf(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content;
  const texts: string[] = [];
  for (const c of content) {
    if (c.type === 'text' && c.text) texts.push(c.text);
  }
  return texts.join('\n');
}

/** pi's chat as NVIDIA reads it. Thinking isn't sent back: NVIDIA's models don't take it. */
export function nimMessages(context: TranscriptContext): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];
  for (const m of collapseSystemMessages(context).messages) {
    if (m.role === 'system') {
      out.push({ role: 'system', content: getSystemMessageText(m) });
      continue;
    }
    if (m.role === 'user') {
      out.push({ role: 'user', content: textOf(m.content) });
      continue;
    }
    if (m.role === 'assistant') {
      let text = '';
      const calls: OpenAiCall[] = [];
      for (const block of m.content) {
        if (block.type === 'text') text += block.text;
        if (block.type === 'toolCall') {
          calls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.arguments ?? {}) } });
        }
      }
      if (!text && !calls.length) continue;
      const said: OpenAiMessage = { role: 'assistant', content: text };
      if (calls.length) said.tool_calls = calls;
      out.push(said);
      continue;
    }
    if (m.role === 'toolResult') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: textOf(m.content) });
    }
  }
  return out;
}

/** The chat's tools as NVIDIA takes them. */
export function nimTools(context: TranscriptContext) {
  return getCurrentTools(context.messages).map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: JSON.parse(JSON.stringify(t.parameters)) },
  }));
}

interface Chunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  error?: { message?: string };
}

/** What a streamed answer adds up to. */
export interface Gathered {
  thinking: string;
  text: string;
  calls: Array<{ id: string; name: string; arguments: string }>;
  finish: string | null;
  usage: Chunk['usage'] | null;
}

/** Adds one streamed piece to what's gathered. */
export function gather(g: Gathered, chunk: Chunk) {
  if (chunk.error) throw new Error(`NVIDIA’s stream broke: ${chunk.error.message ?? 'no reason given'}`);
  if (chunk.usage) g.usage = chunk.usage;
  const choice = chunk.choices?.[0];
  if (!choice) return;
  const d = choice.delta ?? {};
  const thought = d.reasoning_content ?? d.reasoning;
  if (thought) g.thinking += thought;
  if (d.content) g.text += d.content;
  for (const piece of d.tool_calls ?? []) {
    const i = piece.index ?? g.calls.length;
    if (!g.calls[i]) g.calls[i] = { id: '', name: '', arguments: '' };
    const call = g.calls[i];
    if (piece.id) call.id = piece.id;
    if (piece.function?.name) call.name += piece.function.name;
    if (piece.function?.arguments) call.arguments += piece.function.arguments;
  }
  if (choice.finish_reason) g.finish = choice.finish_reason;
}

function stopOf(finish: string | null, calls: number): 'toolUse' | 'length' | 'stop' {
  if (calls > 0) return 'toolUse';
  if (finish === 'length') return 'length';
  if (finish === 'stop') return 'stop';
  throw new Error(`NVIDIA’s answer ended without a finish (${finish ?? 'none'}): ask again.`);
}

function argumentsOf(raw: string, name: string): JsonObject {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as JsonObject;
  } catch {
    throw new Error(`NVIDIA’s call to ${name} had arguments that weren’t JSON: ask again.`);
  }
}

/** Reads the event stream's lines into what's gathered. */
async function readStream(res: Response, g: Gathered) {
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const data = line.trim();
      if (!data.startsWith('data:')) continue;
      const body = data.slice(5).trim();
      if (body === '[DONE]') continue;
      gather(g, JSON.parse(body) as Chunk);
    }
  }
}

/** The harness's stream for an NVIDIA model: one call, the whole answer as pi's events. */
export function nimStream(model: Model<'google-generative-ai'>, context: TranscriptContext, options?: SimpleStreamOptions, fetcher: typeof fetch = fetch, key?: string): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'pending',
    timestamp: Date.now(),
  };

  const run = async () => {
    const tools = nimTools(context);
    const body: Record<string, unknown> = {
      model: model.name,
      messages: nimMessages(context),
      max_tokens: model.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      chat_template_kwargs: { enable_thinking: true },
    };
    if (tools.length) body.tools = tools;
    const res = await fetcher(`${NIM_BASE}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key ?? nvidiaKey().key}`, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    if (!res.ok) {
      const why = (await res.text().catch(() => '')).slice(0, 300);
      // The status first, as the harness reads it (failureOf).
      throw new Error(`${res.status} from NVIDIA: ${why}`);
    }
    const g: Gathered = { thinking: '', text: '', calls: [], finish: null, usage: null };
    await readStream(res, g);
    const stop = stopOf(g.finish, g.calls.length);
    output.stopReason = stop;

    stream.push({ type: 'start', partial: output });
    if (g.thinking) {
      output.content.push({ type: 'thinking', thinking: g.thinking });
      const i = output.content.length - 1;
      stream.push({ type: 'thinking_start', contentIndex: i, partial: output });
      stream.push({ type: 'thinking_delta', contentIndex: i, delta: g.thinking, partial: output });
      stream.push({ type: 'thinking_end', contentIndex: i, content: g.thinking, partial: output });
    }
    if (g.text) {
      output.content.push({ type: 'text', text: g.text });
      const i = output.content.length - 1;
      stream.push({ type: 'text_start', contentIndex: i, partial: output });
      stream.push({ type: 'text_delta', contentIndex: i, delta: g.text, partial: output });
      stream.push({ type: 'text_end', contentIndex: i, content: g.text, partial: output });
    }
    g.calls.forEach((c, n) => {
      const toolCall = { type: 'toolCall' as const, id: c.id || `${c.name}_${Date.now()}_${n}`, name: c.name, arguments: argumentsOf(c.arguments, c.name) };
      output.content.push(toolCall);
      const i = output.content.length - 1;
      stream.push({ type: 'toolcall_start', contentIndex: i, partial: output });
      stream.push({ type: 'toolcall_delta', contentIndex: i, delta: c.arguments, partial: output });
      stream.push({ type: 'toolcall_end', contentIndex: i, toolCall, partial: output });
    });
    if (g.usage) {
      const cached = g.usage.prompt_tokens_details?.cached_tokens ?? 0;
      output.usage.input = (g.usage.prompt_tokens ?? 0) - cached;
      output.usage.cacheRead = cached;
      output.usage.output = g.usage.completion_tokens ?? 0;
      output.usage.totalTokens = g.usage.total_tokens ?? 0;
    }
    stream.push({ type: 'done', reason: stop, message: output });
    stream.end();
  };

  run().catch((err: unknown) => {
    output.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
    output.errorMessage = (err as Error).message;
    stream.push({ type: 'error', reason: output.stopReason, error: output });
    stream.end();
  });
  return stream;
}
