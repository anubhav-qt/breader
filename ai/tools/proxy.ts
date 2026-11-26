import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { opensAt, usageRequest, usageWindows, type CredentialFields } from '../../shared/src/accounts.ts';
import type { Model } from '../pi/pi-ai/src/index.ts';
import { AI } from './lib.ts';
import { nvidiaKey } from './nim.ts';

/*
 * Codex, NVIDIA's backup (backup.ts), through CLIProxyAPI, on the Codex accounts the owner connects
 * from the admin page, the way breader_writer reaches its models: GPT-6.1 Terra, the cheapest that
 * does the job, then GPT-6.2 Sol, then Codex's other models. The harness speaks Gemini's format to
 * them, and the proxy turns it into Codex's; the balancer speaks OpenAI's chat.
 *
 * On the server the worker runs the proxy (server/src/jobs/cliproxy.ts) and hands the marker its
 * address and keys: CLIPROXY_URL, CLIPROXY_API_KEY and CLIPROXY_MANAGEMENT_KEY. On a Mac they can
 * be in ai/.env instead, for the Mac's own proxy. With several accounts of a kind the proxy uses
 * one until it reaches a limit, then the next (fill-first). When every one of them is out, the
 * harness asks each account's limits (shared/src/accounts.ts) and waits for the first to fill
 * again. Nothing here prints a key.
 */

/** Codex's model tried first: the cheapest that does the job well. */
export const CODEX_FIRST = 'gpt-6.1-terra';
/** Codex's model tried next, should the first's work be poor or it can't answer. */
export const CODEX_SECOND = 'gpt-6.2-sol';
/** pi's thinking level for NVIDIA's models: high, as the owner asked. Codex thinks at medium. */
export const THINKING = 'high';


const MANAGEMENT = '/v8/management';
const TIMEOUT_MS = 20_000;

export interface Proxy {
  url: string;
  /** For the model endpoints. */
  apiKey: string;
  /** For the management API: the accounts and their limits. Blank means the harness can't tell when a limit fills again. */
  managementKey: string;
}

/** A setting from the environment or ai/.env. */
export function setting(name: string): string {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv.trim();
  const file = join(AI, '.env');
  if (!existsSync(file)) return '';
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[1] === name) return m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return '';
}

/** The proxy the settings name, or null when there's none. */
export function proxy(): Proxy | null {
  const url = setting('CLIPROXY_URL').replace(/\/+$/, '');
  if (!url) return null;
  return { url, apiKey: setting('CLIPROXY_API_KEY'), managementKey: setting('CLIPROXY_MANAGEMENT_KEY') };
}

/** Whether the NVIDIA key is here, which lets the harness ask NVIDIA's models straight. */
function hasNvidiaKey(): boolean {
  try {
    nvidiaKey();
    return true;
  } catch {
    return false;
  }
}

/** Why the harness can't run here, or null when it can: it needs the NVIDIA key; Codex is only the backup. */
export function noHarness(): string | null {
  if (hasNvidiaKey()) return null;
  return 'there’s no NVIDIA key: set NVIDIA_NIM_API_KEY in ai/.env, or give the marker ADMIN_TOKEN to open the sealed one';
}

interface Listed {
  id: string;
  owned_by?: string;
}

async function listed(p: Proxy): Promise<Listed[] | null> {
  try {
    const res = await fetch(`${p.url}/v1/models`, {
      headers: { authorization: `Bearer ${p.apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: Listed[] };
    return body.data ?? [];
  } catch {
    return null;
  }
}

/** "gpt-6.1-terra" → [6, 1]; no version → []. */
function versionOf(id: string): number[] {
  const m = id.match(/^gpt-(\d+(?:\.\d+)*)/);
  if (!m) return [];
  return m[1].split('.').map(Number);
}

/** The newer version first; a model with no version number after the ones with one. */
function byVersion(a: string, b: string): number {
  const va = versionOf(a);
  const vb = versionOf(b);
  if (!va.length && vb.length) return 1;
  if (va.length && !vb.length) return -1;
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const diff = (vb[i] ?? 0) - (va[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Terra, then Sol 6.2, then Codex's other models, the newest version first. */
export function codexInOrder(ids: string[]): string[] {
  const first = [CODEX_FIRST, CODEX_SECOND];
  const head = first.filter((id) => ids.includes(id));
  const tail = ids.filter((id) => !first.includes(id));
  tail.sort((a, b) => {
    const diff = byVersion(a, b);
    if (diff !== 0) return diff;
    return a.localeCompare(b);
  });
  return [...head, ...tail];
}

/** Codex models that work through a task: not the ones that draw, review code or only chat. */
export function isCodexForText(id: string): boolean {
  if (!/^gpt-\d/.test(id)) return false;
  if (id.includes('image')) return false;
  return !id.includes('chat');
}

/** Whose account a model is on: NVIDIA's are nim-…, by nimAlias, and Codex's gpt-…. */
export function accountOf(id: string): 'Codex' | 'NVIDIA' {
  if (id.startsWith('gpt-')) return 'Codex';
  return 'NVIDIA';
}

/** A Codex model's window as the harness counts it: Codex's own for its models. */
const CODEX_WINDOW = 272_000;

/** pi's model for one of Codex's models through the proxy, spoken to in Gemini's format. */
export function modelFor(p: Proxy, id: string): Model<'google-generative-ai'> {
  return {
    id,
    name: id,
    api: 'google-generative-ai',
    provider: 'codex',
    baseUrl: `${p.url}/v1beta`,
    input: ['text'],
    // The subscription is paid for already.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, xhigh: null, max: null },
    contextWindow: CODEX_WINDOW,
    maxTokens: 32_000,
  };
}

/** The proxy's address, from one of its models. */
export const proxyRoot = (m: { baseUrl: string }) => m.baseUrl.replace(/\/v1beta$/, '');

/**
 * Codex's models through the proxy, in the order the backup tries them. None while no Codex
 * account is connected, or the proxy doesn't answer: NVIDIA then works alone.
 */
export async function codexModels(p: Proxy): Promise<Array<Model<'google-generative-ai'>>> {
  const all = await listed(p);
  if (all === null) return [];
  const ids: string[] = [];
  for (const m of all) {
    if (m.owned_by !== 'openai') continue;
    if (isCodexForText(m.id)) ids.push(m.id);
  }
  return codexInOrder([...new Set(ids)]).map((id) => modelFor(p, id));
}

/** A call to the proxy's management API, or null when it can't be made or doesn't answer. */
async function manage<T>(p: Proxy, path: string, body?: unknown): Promise<T | null> {
  if (!p.managementKey) return null;
  const headers: Record<string, string> = { authorization: `Bearer ${p.managementKey}` };
  let method = 'GET';
  let sent: string | undefined;
  if (body !== undefined) {
    method = 'POST';
    headers['content-type'] = 'application/json';
    sent = JSON.stringify(body);
  }
  try {
    const res = await fetch(`${p.url}${MANAGEMENT}${path}`, { method, headers, body: sent, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

interface Credential extends CredentialFields {
  auth_index?: string;
  disabled?: boolean;
}

interface Called {
  status_code?: number;
  body?: string;
}

/**
 * When a Codex account has room again: now while one has some left, else when the first one's
 * used-up limits fill again. Null when that can't be told.
 */
export async function accountsOpenAt(p: Proxy): Promise<number | null> {
  const listing = await manage<{ files?: Credential[] }>(p, '/credentials');
  if (!listing) return null;
  let soonest: number | null = null;
  for (const c of listing.files ?? []) {
    if (c.provider !== 'codex' || c.disabled || !c.auth_index) continue;
    const request = usageRequest(c);
    if (!request) continue;
    const answer = await manage<Called>(p, '/requests/api-call', { auth_index: c.auth_index, ...request });
    if (!answer || !answer.body || (answer.status_code ?? 0) >= 300) continue;
    const windows = usageWindows('codex', answer.body);
    if (!windows) continue;
    const at = opensAt(windows);
    if (at === null) continue;
    if (soonest === null || at < soonest) soonest = at;
  }
  return soonest;
}
