import { afterEach, describe, expect, it, vi } from 'vitest';
import { cliproxyFor, cliproxyKeys, finishSignIn, listAccounts } from '../src/lib/cliproxy.ts';

/*
 * The AI accounts' proxy as the API sees it (lib/cliproxy.ts): its keys, where it's found, a
 * sign-in finished only with its own address, and the accounts read from a fake proxy.
 */

const TOKEN = 'an-admin-token-for-the-tests';
const proxy = { url: 'http://proxy.test', managementKey: 'management' };

interface Sent {
  url: string;
  method: string;
  auth: string;
  body: unknown;
}

/** A fake proxy: answers by path, and keeps what was sent. */
function fakeProxy(answers: Record<string, unknown>): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    let body: unknown = null;
    if (init.body) body = JSON.parse(String(init.body));
    sent.push({ url, method: init.method ?? 'GET', auth: headers.authorization, body });
    const path = new URL(url).pathname;
    if (!(path in answers)) return new Response('{"error":"not here"}', { status: 404 });
    return Response.json(answers[path]);
  });
  return sent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the proxy’s keys', () => {
  it('are the same every time from the same admin token, and differ for each purpose', () => {
    const a = cliproxyKeys(TOKEN);
    expect(cliproxyKeys(TOKEN)).toEqual(a);
    expect(a.apiKey).not.toBe(a.managementKey);
    expect(a.apiKey).toMatch(/^[0-9a-f]{48}$/);
    expect(a.managementKey).toMatch(/^[0-9a-f]{48}$/);
  });

  it('change with the admin token', () => {
    const other = cliproxyKeys(`${TOKEN}-2`);
    expect(other.apiKey).not.toBe(cliproxyKeys(TOKEN).apiKey);
    expect(other.managementKey).not.toBe(cliproxyKeys(TOKEN).managementKey);
  });
});

describe('where the proxy is', () => {
  it('is the worker, unless CLIPROXY_URL says otherwise, and nowhere without an admin token', () => {
    expect(cliproxyFor({})).toBeNull();
    expect(cliproxyFor({ ADMIN_TOKEN: TOKEN })).toEqual({ url: 'http://worker:8327', managementKey: cliproxyKeys(TOKEN).managementKey });
    expect(cliproxyFor({ ADMIN_TOKEN: TOKEN, CLIPROXY_URL: 'http://127.0.0.1:18327/' })?.url).toBe('http://127.0.0.1:18327');
  });
});

describe('finishing a sign-in', () => {
  it('refuses an address from another sign-in, without asking the proxy', async () => {
    const sent = fakeProxy({});
    await expect(finishSignIn(proxy, 'mine', 'http://localhost:51121/oauth-callback?code=abc&state=theirs')).rejects.toMatchObject({ status: 400, code: 'bad_redirect' });
    await expect(finishSignIn(proxy, 'mine', 'http://localhost:51121/oauth-callback?code=abc')).rejects.toMatchObject({ code: 'bad_redirect' });
    await expect(finishSignIn(proxy, 'mine', 'not an address')).rejects.toMatchObject({ code: 'bad_redirect' });
    expect(sent).toEqual([]);
  });

  it('hands the proxy its own address, with the management key', async () => {
    const sent = fakeProxy({ '/v8/management/oauth/callback': { status: 'ok' } });
    const pasted = 'http://localhost:51121/oauth-callback?code=abc&state=mine';
    await finishSignIn(proxy, 'mine', pasted);
    expect(sent).toEqual([{ url: 'http://proxy.test/v8/management/oauth/callback', method: 'POST', auth: 'Bearer management', body: { redirect_url: pasted, state: 'mine' } }]);
  });
});

describe('the accounts', () => {
  it('are listed with their limits, and only the kinds the admin page knows', async () => {
    const quota = { groups: [{ buckets: [{ bucketId: 'gemini-5h', window: '5h', resetTime: '2026-10-10T15:00:00Z', remainingFraction: 0.4 }] }] };
    const sent = fakeProxy({
      '/v8/management/credentials': {
        files: [
          { name: 'antigravity-a.json', provider: 'antigravity', email: 'a@example.com', auth_index: '1', project_id: 'p-1' },
          { name: 'claude-b.json', provider: 'claude', label: 'Work', disabled: true },
          { name: 'gemini-c.json', provider: 'gemini-cli', email: 'c@example.com', auth_index: '3' },
        ],
      },
      '/v8/management/requests/api-call': { status_code: 200, body: JSON.stringify(quota) },
    });
    const accounts = await listAccounts(proxy);
    expect(accounts).toEqual([
      { id: 'antigravity-a.json', kind: 'antigravity', name: 'a@example.com', problem: null, usage: [{ label: '5 hours', usedPercent: 60, resetsAt: '2026-10-10T15:00:00Z' }] },
      { id: 'claude-b.json', kind: 'claude', name: 'Work', problem: 'Turned off', usage: null },
    ]);
    const asked = sent.find((s) => s.url.endsWith('/requests/api-call'));
    expect(asked?.body).toMatchObject({ auth_index: '1', method: 'POST', data: '{"project":"p-1"}' });
  });

  it('say so when the proxy isn’t answering', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    await expect(listAccounts(proxy)).rejects.toMatchObject({ status: 503, code: 'cliproxy_down' });
  });
});
