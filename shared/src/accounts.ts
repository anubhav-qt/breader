/*
 * The AI accounts signed in to the server's CLIProxyAPI (server/src/lib/cliproxy.ts): Antigravity,
 * Claude Code and Codex, connected from the admin page. Each has a 5-hour limit and a weekly one.
 * How to ask each provider how much is used, and how to read its answer, is here, since the admin
 * page shows it and the AI marker waits on it (ai/tools/proxy.ts). The questions go through the
 * proxy's /requests/api-call, which puts the account's own token where $TOKEN$ is.
 *
 * Read from CLIProxyAPI 8.0.5 and its Management Center's quota page (both
 * github.com/router-for-me), and checked against a real Antigravity account on 2026-10-10.
 */

export const ACCOUNT_KINDS = ['antigravity', 'claude', 'codex'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const KIND_NAMES: Record<AccountKind, string> = {
  antigravity: 'Antigravity',
  claude: 'Claude Code',
  codex: 'Codex',
};

/** One limit of an account: how much of it is used, and when it fills up again. */
export interface UsageWindow {
  /** "5 hours" or "Week". */
  label: string;
  /** 0 to 100. */
  usedPercent: number;
  /** When it's back to full, as an ISO time, if the provider says. */
  resetsAt: string | null;
}

/** An account as the admin page shows it. */
export interface AiAccount {
  /** The proxy's file name for it. */
  id: string;
  kind: string;
  /** Its email, or whatever else names it. */
  name: string;
  /** Why it can't serve right now, or null while it can. */
  problem: string | null;
  /** Its limits, or null when they couldn't be read. */
  usage: UsageWindow[] | null;
}

/** A request for the proxy's api-call: $TOKEN$ in a header becomes the account's token. */
export interface UsageRequest {
  method: 'GET' | 'POST';
  url: string;
  header: Record<string, string>;
  data?: string;
}

/** What the proxy lists for an account, as far as asking for its usage goes. */
export interface CredentialFields {
  provider: string;
  project_id?: string;
  chatgpt_account_id?: string;
}

const ANTIGRAVITY_QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary';
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

/** How to ask for an account's usage, or null for a kind of account this can't ask about. */
export function usageRequest(c: CredentialFields): UsageRequest | null {
  if (c.provider === 'antigravity') {
    if (!c.project_id) return null;
    return {
      method: 'POST',
      url: ANTIGRAVITY_QUOTA_URL,
      header: {
        Authorization: 'Bearer $TOKEN$',
        'Content-Type': 'application/json',
        'User-Agent': 'antigravity/cli/1.0.13 (aidev_client; os_type=linux; arch=amd64)',
      },
      data: JSON.stringify({ project: c.project_id }),
    };
  }
  if (c.provider === 'claude') {
    return {
      method: 'GET',
      url: CLAUDE_USAGE_URL,
      header: { Authorization: 'Bearer $TOKEN$', 'anthropic-beta': 'oauth-2025-04-20' },
    };
  }
  if (c.provider === 'codex') {
    const header: Record<string, string> = { Authorization: 'Bearer $TOKEN$' };
    if (c.chatgpt_account_id) header['Chatgpt-Account-Id'] = c.chatgpt_account_id;
    return { method: 'GET', url: CODEX_USAGE_URL, header };
  }
  return null;
}

function jsonOf(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object') return value as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

function numberOf(value: unknown): number | null {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(n)) return null;
  return n;
}

function percent(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

function labelOf(window: string): string {
  if (window === '5h') return '5 hours';
  if (window === 'weekly') return 'Week';
  return window;
}

interface Bucket {
  bucketId?: string;
  window?: string;
  resetTime?: string;
  remainingFraction?: number | string;
}

/** Antigravity's Gemini limits: the group its Gemini models share. */
function antigravityWindows(body: Record<string, unknown>): UsageWindow[] {
  const out: UsageWindow[] = [];
  const groups = Array.isArray(body.groups) ? (body.groups as Array<{ buckets?: Bucket[] }>) : [];
  for (const group of groups) {
    for (const bucket of group.buckets ?? []) {
      if (!bucket.bucketId?.startsWith('gemini-')) continue;
      const left = numberOf(bucket.remainingFraction);
      if (left === null) continue;
      out.push({ label: labelOf(bucket.window ?? ''), usedPercent: percent((1 - left) * 100), resetsAt: bucket.resetTime ?? null });
    }
  }
  return out;
}

interface ClaudeWindow {
  utilization?: number | string;
  resets_at?: string | null;
}

function claudeWindows(body: Record<string, unknown>): UsageWindow[] {
  const out: UsageWindow[] = [];
  const named: Array<[string, string]> = [['five_hour', '5 hours'], ['seven_day', 'Week']];
  for (const [key, label] of named) {
    const w = body[key] as ClaudeWindow | null | undefined;
    if (!w) continue;
    const used = numberOf(w.utilization);
    if (used === null) continue;
    out.push({ label, usedPercent: percent(used), resetsAt: w.resets_at ?? null });
  }
  return out;
}

interface CodexWindow {
  used_percent?: number | string;
  reset_at?: number | string;
  reset_after_seconds?: number | string;
}

function codexReset(w: CodexWindow, now: number): string | null {
  const at = numberOf(w.reset_at);
  if (at !== null) return new Date(at * 1000).toISOString();
  const after = numberOf(w.reset_after_seconds);
  if (after !== null) return new Date(now + after * 1000).toISOString();
  return null;
}

function codexWindows(body: Record<string, unknown>, now: number): UsageWindow[] {
  const out: UsageWindow[] = [];
  const limits = body.rate_limit as { primary_window?: CodexWindow | null; secondary_window?: CodexWindow | null } | undefined;
  if (!limits) return out;
  const named: Array<[CodexWindow | null | undefined, string]> = [[limits.primary_window, '5 hours'], [limits.secondary_window, 'Week']];
  for (const [w, label] of named) {
    if (!w) continue;
    const used = numberOf(w.used_percent);
    if (used === null) continue;
    out.push({ label, usedPercent: percent(used), resetsAt: codexReset(w, now) });
  }
  return out;
}

/** An account's limits from the provider's answer, or null when the answer can't be read. */
export function usageWindows(provider: string, text: string, now = Date.now()): UsageWindow[] | null {
  const body = jsonOf(text);
  if (!body) return null;
  let windows: UsageWindow[] = [];
  if (provider === 'antigravity') windows = antigravityWindows(body);
  else if (provider === 'claude') windows = claudeWindows(body);
  else if (provider === 'codex') windows = codexWindows(body, now);
  if (!windows.length) return null;
  return windows;
}

/**
 * When an account can serve again: now while every limit has some left, else when the last of its
 * used-up limits fills again. Null when a used-up limit doesn't say when.
 */
export function opensAt(windows: UsageWindow[], now = Date.now()): number | null {
  let at = now;
  for (const w of windows) {
    if (w.usedPercent < 100) continue;
    if (!w.resetsAt) return null;
    const reset = Date.parse(w.resetsAt);
    if (!Number.isFinite(reset)) return null;
    at = Math.max(at, reset);
  }
  return at;
}
