import { AsyncLocalStorage } from 'node:async_hooks';
import protobuf from 'protobufjs';
import { log } from '../log.ts';

/*
 * How the novel sites' plugins fetch (LNReader's @libs/fetch), here on a server instead of a
 * phone: as a phone's browser, with the cookies each site set, and past Cloudflare's "Just a
 * moment" page through FlareSolverr when there's one (FLARESOLVERR_URL). FlareSolverr opens the
 * page in a real browser and hands back its cookies, which let the calls after it through. Where a
 * site still stops them, its pages are read through that browser instead. Each call that failed is
 * counted (failures), so a site that couldn't be reached isn't taken for one with nothing on it.
 */

/** The browser the plugins were written against: a phone's. */
const PHONE = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
/** How long one call waits for its site. */
const WAIT = 30_000;
/** How long FlareSolverr may take with Cloudflare's page. */
const SOLVE_WAIT = 60_000;
/** A site whose pages still meet Cloudflare with the browser's cookies is read through the browser this long. */
const BROWSER_FOR = 30 * 60_000;

/** The calls that failed inside one plugin call (host.ts), and why the last one did. */
export interface Failures {
  failed: number;
  reason: string | null;
}
export const failures = new AsyncLocalStorage<Failures>();

function failed(reason: string) {
  const f = failures.getStore();
  if (!f) return;
  f.failed += 1;
  f.reason = reason;
}

/** What the plugins pass: plain headers or a Headers, and anything else fetch takes. */
export interface FetchInit {
  headers?: Record<string, string | undefined> | Headers;
  method?: string;
  body?: FormData | string | Uint8Array;
  signal?: AbortSignal;
  [x: string]: unknown;
}

interface Solved {
  status: number;
  html: string;
}

/** A site as cookies go: its address without a leading www. */
function siteOf(url: string): string {
  const host = new URL(url).hostname.toLowerCase();
  return host.replace(/^www\./, '');
}

/** The cookies each site set, and the browser FlareSolverr passed Cloudflare as, whose cookies need its name. */
class Jar {
  private cookies = new Map<string, Map<string, string>>();
  private agents = new Map<string, string>();

  header(site: string): string {
    const all = this.cookies.get(site);
    if (!all) return '';
    const parts: string[] = [];
    for (const [name, value] of all) parts.push(`${name}=${value}`);
    return parts.join('; ');
  }

  put(site: string, name: string, value: string) {
    let all = this.cookies.get(site);
    if (!all) {
      all = new Map();
      this.cookies.set(site, all);
    }
    all.set(name, value);
  }

  /** The cookies a site set with an answer. */
  take(site: string, res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const pair = line.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      this.put(site, pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  agent(site: string): string | undefined {
    return this.agents.get(site);
  }

  setAgent(site: string, agent: string) {
    this.agents.set(site, agent);
  }
}

/** Cloudflare's page instead of the site's: "Just a moment", or its challenge by header. */
async function challenged(res: Response): Promise<boolean> {
  if (res.status !== 403 && res.status !== 503 && res.status !== 429) return false;
  if (res.headers.get('cf-mitigated') === 'challenge') return true;
  const server = res.headers.get('server') ?? '';
  if (!/cloudflare/i.test(server)) return false;
  const text = await res.clone().text().catch(() => '');
  return /Just a moment|challenge-platform|cf-browser-verification|_cf_chl_opt/i.test(text);
}

const ENTITIES: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#39;': "'" };

/** A browser shows JSON in a <pre>: the JSON itself, when that's what the page is. */
export function unwrapJson(html: string): string | null {
  const m = /^\s*<html[^>]*>\s*<head>[\s\S]*?<\/head>\s*<body>\s*<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(html);
  if (!m) return null;
  const text = m[1].replace(/&lt;|&gt;|&amp;|&quot;|&#39;/g, (e) => ENTITIES[e]);
  try {
    JSON.parse(text);
    return text;
  } catch {
    return null;
  }
}

function headersOf(init: FetchInit | undefined): Headers {
  const out = new Headers();
  const given = init?.headers;
  if (given instanceof Headers) {
    for (const [k, v] of given) out.set(k, v);
  } else if (given) {
    for (const [k, v] of Object.entries(given)) {
      if (v !== undefined) out.set(k, v);
    }
  }
  return out;
}

export interface Fetcher {
  fetchApi(url: string, init?: FetchInit): Promise<Response>;
  fetchText(url: string, init?: FetchInit, encoding?: string): Promise<string>;
  fetchFile(url: string, init?: FetchInit): Promise<string>;
  fetchProto(protoInit: ProtoInit, url: string, init?: FetchInit): Promise<unknown>;
}

export interface ProtoInit {
  proto: string;
  requestType: string;
  requestData?: Record<string, unknown>;
  responseType: string;
}

export interface FetchOptions {
  /** FlareSolverr's address (http://flaresolverr:8191/v1), when there's one. */
  solver?: string;
  fetch?: typeof fetch;
}

/** The fetching every plugin shares: one jar of cookies, one browser for Cloudflare. */
export function makeFetcher(opts: FetchOptions = {}): Fetcher & { send(url: string, init?: FetchInit): Promise<Response> } {
  const fetchFn = opts.fetch ?? fetch;
  const jar = new Jar();
  /** Cloudflare's page being solved for a site, once however many calls meet it. */
  const solving = new Map<string, Promise<Solved | null>>();
  /** Sites read through the browser until then, as its cookies alone don't pass. */
  const browserOnly = new Map<string, number>();

  /** The page through FlareSolverr's browser, its cookies kept for the calls after. Null without one, or when it failed. */
  function solve(url: string): Promise<Solved | null> {
    const solver = opts.solver;
    if (!solver) return Promise.resolve(null);
    const site = siteOf(url);
    const going = solving.get(site);
    if (going) return going;
    const asking = (async (): Promise<Solved | null> => {
      try {
        const res = await fetchFn(solver, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cmd: 'request.get', url, maxTimeout: SOLVE_WAIT }),
          signal: AbortSignal.timeout(SOLVE_WAIT + 10_000),
        });
        const body = (await res.json()) as { status?: string; message?: string; solution?: { status: number; response: string; userAgent: string; cookies: Array<{ name: string; value: string }> } };
        const s = body.solution;
        if (body.status !== 'ok' || !s) {
          log.warn({ site, said: body.message }, 'FlareSolverr couldn’t pass Cloudflare');
          return null;
        }
        for (const c of s.cookies) jar.put(site, c.name, c.value);
        jar.setAgent(site, s.userAgent);
        return { status: s.status, html: s.response };
      } catch (err) {
        log.warn({ err, site }, 'FlareSolverr didn’t answer');
        return null;
      }
    })();
    solving.set(site, asking);
    void asking.finally(() => solving.delete(site));
    return asking;
  }

  /** A page read through the browser, as a fetch answer: JSON unwrapped from the page it's shown in. */
  function asResponse(solved: Solved): Response {
    const json = unwrapJson(solved.html);
    let status = solved.status;
    if (status < 200 || status > 599) status = 200;
    if (json !== null) return new Response(json, { status, headers: { 'content-type': 'application/json' } });
    return new Response(solved.html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }

  async function once(url: string, init: FetchInit | undefined, site: string): Promise<Response> {
    const headers = headersOf(init);
    for (const [k, v] of Object.entries({ Accept: '*/*', 'Accept-Language': '*', 'Sec-Fetch-Mode': 'cors', 'Accept-Encoding': 'gzip, deflate' })) {
      if (!headers.has(k)) headers.set(k, v);
    }
    const agent = jar.agent(site);
    if (agent) headers.set('User-Agent', agent);
    else if (!headers.has('User-Agent')) headers.set('User-Agent', PHONE);
    const cookies = jar.header(site);
    if (cookies) {
      const own = headers.get('Cookie');
      if (own) headers.set('Cookie', `${own}; ${cookies}`);
      else headers.set('Cookie', cookies);
    }
    let signal = AbortSignal.timeout(WAIT);
    if (init?.signal) signal = AbortSignal.any([init.signal, signal]);
    const res = await fetchFn(url, { ...init, headers, signal } as RequestInit);
    jar.take(site, res);
    return res;
  }

  /** A call to a site, past Cloudflare where it can be. Throws when the site can't be reached, as fetch does. */
  async function send(url: string, init?: FetchInit): Promise<Response> {
    const site = siteOf(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const plain = method === 'GET';
    if (plain && (browserOnly.get(site) ?? 0) > Date.now()) {
      const solved = await solve(url);
      if (solved) return asResponse(solved);
    }
    let res: Response;
    try {
      res = await once(url, init, site);
    } catch (err) {
      failed(String((err as Error)?.message ?? err));
      throw err;
    }
    if (await challenged(res)) {
      const solved = await solve(url);
      if (solved) {
        const again = await once(url, init, site).catch(() => null);
        if (again && !(await challenged(again))) return again;
        // The browser's cookies alone don't pass: its pages from now on, a while.
        if (plain) {
          browserOnly.set(site, Date.now() + BROWSER_FOR);
          return asResponse(solved);
        }
      }
      failed('Cloudflare');
      return res;
    }
    if (!res.ok) failed(`HTTP ${res.status}`);
    return res;
  }

  return {
    send,

    fetchApi: (url, init) => send(url, init),

    async fetchText(url, init, encoding) {
      try {
        const res = await send(url, init);
        if (!res.ok) return '';
        const data = await res.arrayBuffer();
        return new TextDecoder(encoding).decode(data);
      } catch {
        return '';
      }
    },

    async fetchFile(url, init) {
      try {
        const res = await send(url, init);
        if (!res.ok) return '';
        return Buffer.from(await res.arrayBuffer()).toString('base64');
      } catch {
        return '';
      }
    },

    async fetchProto(protoInit, url, init) {
      const root = protobuf.parse(protoInit.proto).root;
      const Request = root.lookupType(protoInit.requestType);
      const data = protoInit.requestData ?? {};
      if (Request.verify(data)) throw new Error('Invalid Proto');
      const encoded = Request.encode(data).finish();
      // gRPC-web's frame: a zero byte, then the message's length in four.
      const head = Buffer.alloc(5);
      head.writeUInt32BE(encoded.length, 1);
      const res = await send(url, { method: 'POST', ...init, body: Buffer.concat([head, Buffer.from(encoded)]) });
      const payload = new Uint8Array(await res.arrayBuffer());
      const length = ((payload[1] << 24) | (payload[2] << 16) | (payload[3] << 8) | payload[4]) >>> 0;
      const Reply = root.lookupType(protoInit.responseType);
      return Reply.decode(payload.slice(5, 5 + length));
    },
  };
}
