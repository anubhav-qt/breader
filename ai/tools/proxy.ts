import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { opensAt, usageRequest, usageWindows, type CredentialFields } from '../../shared/src/accounts.ts';
import type { Model } from '../pi/pi-ai/src/index.ts';
import { AI } from './lib.ts';

/*
 * The harness's models (harness.ts): Gemini through CLIProxyAPI, on the Antigravity accounts the
 * owner connects from the admin page, the way breader_writer reaches its models. Gemini 3.8
 * Flash, thinking high, first; while it can't answer, whatever other Gemini models Antigravity
 * serves, the newest first.
 *
 * On the server the worker runs the proxy (server/src/jobs/cliproxy.ts) and hands the marker its
 * address and keys: CLIPROXY_URL, CLIPROXY_API_KEY and CLIPROXY_MANAGEMENT_KEY. On a Mac they can
 * be in ai/.env instead, for the Mac's own proxy. With several Antigravity accounts the proxy uses
 * one until it reaches a limit, then the next (fill-first). When every one of them is out, the
 * harness asks each account's limits (shared/src/accounts.ts) and waits for the first to fill
 * again. Nothing here prints a key.
 */

export const FIRST_MODEL = 'gemini-3.8-flash-high';
/** pi's thinking level for every model: high, as the owner asked. */
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
function setting(name: string): string {
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

/** Why the harness can't run here, or null when it can. */
export function noHarness(): string | null {
  if (proxy()) return null;
  return 'there’s no CLIProxyAPI: the worker starts one when its image has it, or set CLIPROXY_URL and CLIPROXY_API_KEY in ai/.env';
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

/** "gemini-3.7-flash-high" → [3, 7]; no version → []. */
function versionOf(id: string): number[] {
  const m = id.match(/^gemini-(\d+(?:\.\d+)*)/);
  if (!m) return [];
  return m[1].split('.').map(Number);
}

/** Pro before Flash before Lite, at one version. */
function sizeOf(id: string): number {
  if (id.includes('lite')) return 2;
  if (id.includes('flash')) return 1;
  return 0;
}

/** Gemini 3.8 Flash high first, then the newest version first, the bigger model first. */
export function inOrder(ids: string[]): string[] {
  return [...ids].sort((a, b) => {
    if (a === FIRST_MODEL) return -1;
    if (b === FIRST_MODEL) return 1;
    const va = versionOf(a);
    const vb = versionOf(b);
    // A model with no version number goes after the ones with one.
    if (!va.length && vb.length) return 1;
    if (va.length && !vb.length) return -1;
    for (let i = 0; i < Math.max(va.length, vb.length); i++) {
      const diff = (vb[i] ?? 0) - (va[i] ?? 0);
      if (diff !== 0) return diff;
    }
    const bySize = sizeOf(a) - sizeOf(b);
    if (bySize !== 0) return bySize;
    return a.localeCompare(b);
  });
}

/** Gemini models that write text: not the ones that draw. */
export function isGeminiForText(id: string): boolean {
  if (!id.startsWith('gemini')) return false;
  return !id.includes('image');
}

/** pi's model for one of the proxy's Gemini models, thinking high. */
export function modelFor(p: Proxy, id: string): Model<'google-generative-ai'> {
  return {
    id,
    name: id,
    api: 'google-generative-ai',
    provider: 'antigravity',
    baseUrl: `${p.url}/v1beta`,
    input: ['text'],
    // The subscription is paid for already.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, xhigh: null, max: null },
    contextWindow: 1_000_000,
    maxTokens: 32_000,
  };
}

/** Every Gemini model Antigravity serves through the proxy, in the order the harness tries them. */
export async function geminiModels(p: Proxy): Promise<Array<Model<'google-generative-ai'>>> {
  const all = await listed(p);
  if (all === null) throw new Error('CLIProxyAPI can’t be reached.');
  const ids: string[] = [];
  for (const m of all) {
    const fromAntigravity = !m.owned_by || m.owned_by === 'antigravity';
    if (fromAntigravity && isGeminiForText(m.id)) ids.push(m.id);
  }
  if (!ids.length) throw new Error('Antigravity serves no Gemini models: connect an Antigravity account from the admin page, or connect it again.');
  return inOrder([...new Set(ids)]).map((id) => modelFor(p, id));
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
 * When an Antigravity account has Gemini to give again: now while one has some left, else when
 * the first one's used-up limits fill again. Null when that can't be told.
 */
export async function geminiOpensAt(p: Proxy): Promise<number | null> {
  const listing = await manage<{ files?: Credential[] }>(p, '/credentials');
  if (!listing) return null;
  let soonest: number | null = null;
  for (const c of listing.files ?? []) {
    if (c.provider !== 'antigravity' || c.disabled || !c.auth_index) continue;
    const request = usageRequest(c);
    if (!request) continue;
    const answer = await manage<Called>(p, '/requests/api-call', { auth_index: c.auth_index, ...request });
    if (!answer || !answer.body || (answer.status_code ?? 0) >= 300) continue;
    const windows = usageWindows('antigravity', answer.body);
    if (!windows) continue;
    const at = opensAt(windows);
    if (at === null) continue;
    if (soonest === null || at < soonest) soonest = at;
  }
  return soonest;
}
