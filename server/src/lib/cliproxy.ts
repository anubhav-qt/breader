import { hkdfSync } from 'node:crypto';
import { ACCOUNT_KINDS, usageRequest, usageWindows, type AccountKind, type AiAccount, type CredentialFields, type UsageWindow } from '@breader/shared';
import { ApiError } from './errors.ts';

/*
 * CLIProxyAPI (github.com/router-for-me/CLIProxyAPI), which signs in to the AI accounts the owner
 * connects from the admin page (Antigravity, Claude Code, Codex) and serves their models to the
 * AI marker. The worker runs it (jobs/cliproxy.ts); the API asks it about the accounts here,
 * through its management API. Its two keys come from ADMIN_TOKEN, the same way in both, so
 * they're never written down anywhere else.
 *
 * Connecting an account is the proxy's own sign-in. The admin page opens the provider's sign-in
 * page, which ends by sending the browser to a localhost address that doesn't load, since the
 * proxy isn't on the owner's machine. The owner pastes that address into the admin page, and the
 * proxy finishes the sign-in with it, within 5 minutes of starting it.
 */

export const CLIPROXY_PORT = 8327;
const MANAGEMENT = '/v8/management';
const TIMEOUT_MS = 20_000;

export interface CliproxyKeys {
  /** For its model endpoints: the marker's. */
  apiKey: string;
  /** For its management API: the accounts and their limits. */
  managementKey: string;
}

function derive(adminToken: string, what: string): string {
  const key = hkdfSync('sha256', adminToken, 'breader', `cliproxy ${what}`, 24);
  return Buffer.from(key).toString('hex');
}

export function cliproxyKeys(adminToken: string): CliproxyKeys {
  return { apiKey: derive(adminToken, 'api key'), managementKey: derive(adminToken, 'management key') };
}

export interface Cliproxy {
  url: string;
  managementKey: string;
}

/** The worker's proxy, as the API reaches it: the worker's name on the compose network, unless CLIPROXY_URL says otherwise. Null without ADMIN_TOKEN. */
export function cliproxyFor(env: { ADMIN_TOKEN?: string; CLIPROXY_URL?: string }): Cliproxy | null {
  if (!env.ADMIN_TOKEN) return null;
  let url = `http://worker:${CLIPROXY_PORT}`;
  if (env.CLIPROXY_URL) url = env.CLIPROXY_URL.replace(/\/+$/, '');
  return { url, managementKey: cliproxyKeys(env.ADMIN_TOKEN).managementKey };
}

/** A call to the proxy's management API. Fails with what to tell the owner. */
async function call<T>(p: Cliproxy, method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${p.managementKey}` };
  let sent: string | undefined;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    sent = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(`${p.url}${MANAGEMENT}${path}`, { method, headers, body: sent, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ApiError(503, 'cliproxy_down', 'The AI accounts’ proxy isn’t answering. It runs in the worker, which may still be starting.');
  }
  const answer = (await res.json().catch(() => ({}))) as T & { error?: unknown };
  if (!res.ok) {
    let why = '';
    if (typeof answer.error === 'string') why = `: ${answer.error.slice(0, 200)}`;
    throw new ApiError(502, 'cliproxy_error', `The AI accounts’ proxy answered ${res.status}${why}.`);
  }
  return answer;
}

const isKind = (k: string): k is AccountKind => (ACCOUNT_KINDS as readonly string[]).includes(k);

/** An account as the proxy lists it. */
interface Credential {
  name: string;
  provider: string;
  email?: string;
  label?: string;
  status?: string;
  status_message?: string;
  disabled?: boolean;
  unavailable?: boolean;
  auth_index?: string;
  project_id?: string;
  /** Codex's account id is in its sign-in's claims. */
  id_token?: { chatgpt_account_id?: string };
}

interface Called {
  status_code?: number;
  body?: string;
}

function problemOf(c: Credential): string | null {
  if (c.disabled) return 'Turned off';
  if (c.unavailable || c.status === 'error') return c.status_message || 'Can’t serve right now';
  return null;
}

/** Its 5-hour and weekly limits, asked of the provider through the proxy, or null when they can't be read. */
async function usageOf(p: Cliproxy, c: Credential): Promise<UsageWindow[] | null> {
  if (!c.auth_index) return null;
  const fields: CredentialFields = { provider: c.provider, project_id: c.project_id, chatgpt_account_id: c.id_token?.chatgpt_account_id };
  const request = usageRequest(fields);
  if (!request) return null;
  try {
    const answer = await call<Called>(p, 'POST', '/requests/api-call', { auth_index: c.auth_index, ...request });
    if (!answer.body || (answer.status_code ?? 0) >= 300) return null;
    return usageWindows(c.provider, answer.body);
  } catch {
    return null;
  }
}

/** Every connected account, with its limits. */
export async function listAccounts(p: Cliproxy): Promise<AiAccount[]> {
  const listing = await call<{ files?: Credential[] }>(p, 'GET', '/credentials');
  const ours = (listing.files ?? []).filter((c) => isKind(c.provider));
  return Promise.all(ours.map(async (c) => ({
    id: c.name,
    kind: c.provider,
    name: c.email || c.label || c.name,
    problem: problemOf(c),
    usage: await usageOf(p, c),
  })));
}

/** Starts a sign-in: the provider's page to open, and the sign-in's state, which the rest of it goes by. */
export async function startSignIn(p: Cliproxy, kind: AccountKind): Promise<{ url: string; state: string }> {
  const r = await call<{ url?: string; state?: string }>(p, 'GET', `/oauth/auth-url?provider=${kind}`);
  if (!r.url || !r.state) throw new ApiError(502, 'cliproxy_error', 'The AI accounts’ proxy didn’t give a sign-in page.');
  return { url: r.url, state: r.state };
}

/** Finishes a sign-in with the address the provider's page ended on, which has to be this sign-in's. */
export async function finishSignIn(p: Cliproxy, state: string, redirectUrl: string) {
  let pasted: URL;
  try {
    pasted = new URL(redirectUrl);
  } catch {
    throw new ApiError(400, 'bad_redirect', 'That isn’t an address. Copy the whole address from the tab the sign-in ended in.');
  }
  if (pasted.searchParams.get('state') !== state) {
    throw new ApiError(400, 'bad_redirect', 'That address is from another sign-in. Start again and paste the address this one ends on.');
  }
  await call(p, 'POST', '/oauth/callback', { redirect_url: redirectUrl, state });
}

/** How a sign-in is going: still waiting, done, or failed and why. */
export async function signInStatus(p: Cliproxy, state: string): Promise<{ status: 'wait' | 'ok' | 'error'; error?: string }> {
  const r = await call<{ status?: string; error?: string }>(p, 'GET', `/oauth/status?state=${encodeURIComponent(state)}`);
  if (r.status === 'ok') return { status: 'ok' };
  if (r.status === 'wait') return { status: 'wait' };
  return { status: 'error', error: r.error ?? 'The sign-in failed.' };
}

export async function cancelSignIn(p: Cliproxy, state: string) {
  await call(p, 'DELETE', `/oauth/session?state=${encodeURIComponent(state)}`);
}

/** Signs an account out of the proxy for good. */
export async function removeAccount(p: Cliproxy, id: string) {
  await call(p, 'DELETE', `/credentials?name=${encodeURIComponent(id)}`);
}
