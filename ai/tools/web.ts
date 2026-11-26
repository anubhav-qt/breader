import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Readability } from '@mozilla/readability';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Type } from '../pi/pi-ai/src/index.ts';
import { log } from './balancer.ts';
import { tool, type Brain } from './harness.ts';
import { accountOf, proxyRoot, setting } from './proxy.ts';

/*
 * The harness's view of the web: a search, and a page read the way Firefox's reader view reads it
 * (Mozilla's Readability). Only metadata goes into a search: a series' names, never a book's text.
 *
 * NVIDIA's models can't search the web themselves, so a SearXNG (SEARXNG_URL,
 * github.com/searxng/searxng) lists what the web has, and the model reads the pages it picks.
 * Codex, NVIDIA's backup, searches with its own web search through the proxy, which is also the
 * search when SearXNG can't answer.
 *
 * A page is only fetched from the public internet. The worker sits next to the proxy, the
 * database and the API, and a page the model was pointed to by another page shouldn't reach them.
 */

const SEARCH_TIMEOUT_MS = 90_000;
const SEARX_TIMEOUT_MS = 30_000;
/** SearXNG's results shown for a search, the best first. */
const SEARX_RESULTS = 10;
const SNIPPET_CHARS = 300;
const PAGE_TIMEOUT_MS = 20_000;
const PAGE_BYTES = 3 * 1024 * 1024;
const PAGE_CHARS = 8000;
const REDIRECTS = 5;
const KEPT_PAGES = 40;

const round = (n: number) => Math.round(n * 10) / 10;

/** What a search found: the answer, what was searched, and the sources. */
interface Found {
  answer: string;
  queries: string[];
  sources: Array<{ url: string; title?: string }>;
}

/** A search's findings as the model reads them. */
function asText(f: Found): string {
  const lines = [f.answer.trim() || '(No answer.)'];
  if (f.queries.length) lines.push('', `Searched: ${f.queries.join('; ')}`);
  if (f.sources.length) {
    lines.push('', 'Sources (read one with read_page):');
    f.sources.forEach((s, i) => {
      lines.push(`${i + 1}. ${s.title ?? 'untitled'}: ${s.url}`);
    });
  }
  return lines.join('\n');
}

interface Responded {
  output?: Array<{
    type?: string;
    action?: { query?: string; queries?: string[]; sources?: Array<{ url?: string; title?: string }> };
    content?: Array<{ type?: string; text?: string; annotations?: Array<{ type?: string; url?: string; title?: string }> }>;
  }>;
}

/** An address without the tag Codex puts on the ones it cites. */
function untagged(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete('utm_source');
    return u.href;
  } catch {
    return url;
  }
}

/** Codex's answer as the model reads it: cited sources first. */
export function responsesAnswer(body: Responded): string {
  let answer = '';
  const queries: string[] = [];
  const cited: Array<{ url: string; title?: string }> = [];
  const found: Array<{ url: string; title?: string }> = [];
  for (const item of body.output ?? []) {
    if (item.type === 'web_search_call') {
      const a = item.action ?? {};
      if (a.query) queries.push(a.query);
      for (const q of a.queries ?? []) queries.push(q);
      for (const src of a.sources ?? []) {
        if (src.url) found.push({ url: src.url, title: src.title });
      }
    }
    if (item.type === 'message') {
      for (const c of item.content ?? []) {
        if (c.type !== 'output_text') continue;
        answer += c.text ?? '';
        for (const note of c.annotations ?? []) {
          if (note.type === 'url_citation' && note.url) cited.push({ url: note.url, title: note.title });
        }
      }
    }
  }
  if (!answer.trim() && !found.length) throw new Error('The search came back empty: try other words.');
  const sources: Found['sources'] = [];
  const seen = new Set<string>();
  for (const src of [...cited, ...found]) {
    const url = untagged(src.url);
    if (seen.has(url)) continue;
    seen.add(url);
    sources.push({ url, title: src.title });
  }
  return asText({ answer, queries: [...new Set(queries)], sources });
}

interface Searxed {
  results?: Array<{ url?: string; title?: string; content?: string }>;
}

/** SearXNG's results as the model reads them: each one's title, address and snippet, to read with read_page. */
export function searxAnswer(body: Searxed, query: string): string {
  const kept: Array<{ url: string; title: string; snippet: string }> = [];
  const seen = new Set<string>();
  for (const r of body.results ?? []) {
    if (!r.url || seen.has(r.url)) continue;
    seen.add(r.url);
    const snippet = (r.content ?? '').replace(/\s+/g, ' ').trim();
    kept.push({ url: r.url, title: r.title?.trim() || 'untitled', snippet: snippet.slice(0, SNIPPET_CHARS) });
    if (kept.length >= SEARX_RESULTS) break;
  }
  if (!kept.length) throw new Error('The search found nothing: try other words, or the names in Japanese.');
  const lines = [`Results for: ${query}`, 'These are only snippets: read the useful pages with read_page before you trust them.', ''];
  kept.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}: ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
  });
  return lines.join('\n');
}

/** SearXNG's address, or '' when there's none. */
const searxUrl = () => setting('SEARXNG_URL').replace(/\/+$/, '');

/** One search on SearXNG, for an NVIDIA model to read. */
async function searxSearch(base: string, query: string): Promise<string> {
  const url = new URL(`${base}/search`);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  const startedAt = Date.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(SEARX_TIMEOUT_MS) });
  const secs = round((Date.now() - startedAt) / 1000);
  log({ at: new Date(startedAt).toISOString(), use: 'web_search', model: 'searxng', ok: res.ok, status: res.status, secs });
  if (!res.ok) throw new Error(`SearXNG: ${res.status}`);
  return searxAnswer((await res.json()) as Searxed, query);
}

const PROMPT = (query: string) => `Search the web and answer this: ${query}

Keep to what the sources say. Write names and titles exactly as they're published, in English and in Japanese where they have both. Under 300 words.`;

/** One search on a Codex model, with its own web search, at medium thinking. */
function searchRequest(m: { id: string; baseUrl: string }, apiKey: string, query: string): { url: string; init: RequestInit } {
  const body = {
    model: m.id,
    input: PROMPT(query),
    tools: [{ type: 'web_search' }],
    include: ['web_search_call.action.sources'],
    reasoning: { effort: 'medium' },
  };
  return {
    url: `${proxyRoot(m)}/v1/responses`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    },
  };
}

/**
 * Asks the web the way the harness's models can, in their order: SearXNG for an NVIDIA model
 * (once, however many there are), Codex's own search for its.
 */
export async function webSearch(b: Brain, query: string): Promise<string> {
  const problems: string[] = [];
  const searx = searxUrl();
  let searxTried = false;
  for (const m of b.models) {
    if (accountOf(m.id) === 'NVIDIA') {
      if (!searx || searxTried) continue;
      searxTried = true;
      try {
        return await searxSearch(searx, query);
      } catch (e) {
        problems.push((e as Error).message);
      }
      continue;
    }
    const startedAt = Date.now();
    const request = searchRequest(m, b.apiKey, query);
    let res: Response;
    try {
      res = await fetch(request.url, request.init);
    } catch (e) {
      problems.push(`${m.id}: ${(e as Error).message}`);
      continue;
    }
    const secs = round((Date.now() - startedAt) / 1000);
    log({ at: new Date(startedAt).toISOString(), use: 'web_search', model: m.id, ok: res.ok, status: res.status, secs });
    if (!res.ok) {
      problems.push(`${m.id}: ${res.status}`);
      continue;
    }
    return responsesAnswer((await res.json()) as Responded);
  }
  throw new Error(`The search failed (${problems.join('; ')}). Try again in a while, or search YouTube directly.`);
}

function ipv4Private(address: string): boolean {
  const [a, b] = address.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // Carrier-grade NAT, which Tailscale uses too.
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

/** True for an address that isn't on the public internet: this machine, the local network, link-local. */
export function isPrivate(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return ipv4Private(address);
  if (kind !== 6) return true;
  const a = address.toLowerCase();
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Private(mapped[1]);
  if (a === '::' || a === '::1') return true;
  if (/^f[cd]/.test(a)) return true;
  if (/^fe[89ab]/.test(a)) return true;
  if (a.startsWith('ff')) return true;
  return false;
}

async function checkAddress(url: URL) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Only web pages can be read, not ${url.protocol} addresses.`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    const found = await lookup(host, { all: true }).catch(() => []);
    addresses = found.map((f) => f.address);
  }
  if (!addresses.length) throw new Error(`${url.hostname} doesn't resolve: check the address.`);
  for (const address of addresses) {
    if (isPrivate(address)) throw new Error(`${url.hostname} isn't on the public internet, so it can't be read.`);
  }
}

/** The body, up to the cap. */
async function bodyOf(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size >= PAGE_BYTES) {
      await reader.cancel();
      break;
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Fetches a public page, checking every address it redirects to. */
async function fetchPublic(address: string): Promise<{ url: string; type: string; text: string }> {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Error(`${address} isn't a web address.`);
  }
  for (let hop = 0; hop <= REDIRECTS; hop++) {
    await checkAddress(url);
    const res = await fetch(url, {
      redirect: 'manual',
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; Breader/1.0)', accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' },
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
    const next = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && next) {
      url = new URL(next, url);
      continue;
    }
    if (!res.ok) throw new Error(`${url.hostname} answered ${res.status}: try another source.`);
    return { url: url.href, type: res.headers.get('content-type') ?? '', text: await bodyOf(res) };
  }
  throw new Error(`${address} redirects too many times: try another source.`);
}

const tidy = (text: string) => text.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*(\n\s*)+/g, '\n\n').trim();

/** A page's title and readable text, as the reader view sees it. */
export function pageText(html: string, url: string): { title: string; text: string } {
  const dom = new JSDOM(html, { url, virtualConsole: new VirtualConsole() });
  const document = dom.window.document;
  const pageTitle = document.title;
  const article = new Readability(document).parse();
  let title = pageTitle;
  let text = '';
  if (article) {
    title = article.title || pageTitle;
    text = article.textContent ?? '';
  }
  if (!text.trim()) text = document.body?.textContent ?? '';
  dom.window.close();
  return { title: title.trim(), text: tidy(text) };
}

const PAGES = new Map<string, { title: string; text: string }>();

async function readable(address: string): Promise<{ title: string; text: string }> {
  const kept = PAGES.get(address);
  if (kept) return kept;
  const page = await fetchPublic(address);
  let read: { title: string; text: string };
  if (page.type.includes('html')) {
    read = pageText(page.text, page.url);
  } else if (page.type.startsWith('text/') || page.type.includes('json')) {
    read = { title: page.url, text: tidy(page.text) };
  } else {
    throw new Error(`${address} is ${page.type || 'not a page'}, not a page: try another source.`);
  }
  if (!read.text) throw new Error(`${address} has no text to read: try another source.`);
  if (PAGES.size >= KEPT_PAGES) PAGES.delete(PAGES.keys().next().value as string);
  PAGES.set(address, read);
  return read;
}

/** A page's text from a character on, a page's worth at a time. */
export async function readPage(address: string, from: number): Promise<string> {
  const page = await readable(address);
  const start = Math.max(0, Math.min(from, page.text.length));
  const end = Math.min(page.text.length, start + PAGE_CHARS);
  const lines = [page.title, address, `(Characters ${start} to ${end} of ${page.text.length}.)`, '', page.text.slice(start, end)];
  if (end < page.text.length) lines.push('', `(More: read_page with from=${end}.)`);
  return lines.join('\n');
}

export function webSearchTool(b: Brain) {
  return tool(
    'web_search',
    'Searches the web: an answer with its sources, or a list of results to read with read_page. Ask one clear question at a time, with the names you know in English and Japanese.',
    Type.Object({ query: Type.String({ description: 'The question, e.g. "Who composed the anime soundtrack of <series>, and what are its OST albums for each season?"' }) }),
    (args) => webSearch(b, args.query),
  );
}

/** The read_page tool. `onRead` hears each page read, for the sources list. */
export function readPageTool(onRead?: (url: string) => void) {
  return tool(
    'read_page',
    'Reads a web page as plain text, 8000 characters at a time: a source from web_search, or a page found in one. Public pages only.',
    Type.Object({
      url: Type.String({ description: 'The page’s address.' }),
      from: Type.Optional(Type.Integer({ minimum: 0, description: 'The character to start at, from the last read’s "More" line.' })),
    }),
    async (args) => {
      const text = await readPage(args.url, args.from ?? 0);
      if (onRead) onRead(args.url);
      return text;
    },
  );
}
