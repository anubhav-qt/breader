import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

/*
 * The harness's view of the web, without the web: which addresses are kept out, what the reader
 * view makes of a small page, how Codex's and SearXNG's answers read to the model, and
 * where a search goes.
 */

process.env.AI_WORK = mkdtempSync(join(tmpdir(), 'breader-ai-test-'));
const { isPrivate, pageText, responsesAnswer, searxAnswer, webSearch } = await import('../web.ts');

test('addresses on this machine, the local network or link-local are private', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.10', '169.254.169.254', '0.0.0.0', '224.0.0.1']) {
    assert.equal(isPrivate(a), true, a);
  }
  for (const a of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '192.169.0.1']) {
    assert.equal(isPrivate(a), false, a);
  }
});

test('carrier-grade NAT, which Tailscale uses, is private', () => {
  assert.equal(isPrivate('100.64.0.1'), true);
  assert.equal(isPrivate('100.127.255.254'), true);
  assert.equal(isPrivate('100.63.0.1'), false);
  assert.equal(isPrivate('100.128.0.1'), false);
});

test('IPv6: loopback, unique local, link-local and multicast are private, the rest public', () => {
  for (const a of ['::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'ff02::1']) {
    assert.equal(isPrivate(a), true, a);
  }
  assert.equal(isPrivate('2001:4860:4860::8888'), false);
});

test('an IPv4 address written as IPv6 is judged as IPv4', () => {
  assert.equal(isPrivate('::ffff:127.0.0.1'), true);
  assert.equal(isPrivate('::ffff:192.168.0.1'), true);
  assert.equal(isPrivate('::ffff:8.8.8.8'), false);
});

test('anything that isn’t an address counts as private', () => {
  assert.equal(isPrivate('localhost'), true);
  assert.equal(isPrivate(''), true);
});

test('a page reads as its article, without the menus around it', () => {
  const para = 'The second season was announced at the end of the first, with the same studio and most of the same staff returning for it. '.repeat(4);
  const html = `<!doctype html><html><head><title>Site title</title></head><body>
    <nav><a href="/">Home</a> <a href="/news">News</a></nav>
    <article><h1>Season two news</h1><p>${para}</p><p>${para}</p><p>${para}</p></article>
    <footer>Cookie settings</footer>
  </body></html>`;
  const page = pageText(html, 'https://example.com/news/1');
  assert.match(page.text, /The second season was announced/);
  assert.doesNotMatch(page.text, /Cookie settings/);
  assert.ok(page.title.length > 0);
});

test('a page with no article still gives its text', () => {
  const page = pageText('<html><head><title>Short</title></head><body><p>Just a line.</p></body></html>', 'https://example.com/');
  assert.equal(page.title, 'Short');
  assert.match(page.text, /Just a line\./);
});

test('Codex’s answer reads as the answer, what was searched, cited sources first, no tags, no repeats', () => {
  const body = {
    output: [
      { type: 'reasoning' },
      {
        type: 'web_search_call',
        action: {
          query: 'frieren soundtrack composer',
          sources: [
            { type: 'url', url: 'https://b.example/2', title: 'B page' },
            { type: 'url', url: 'https://a.example/1?utm_source=openai' },
          ],
        },
      },
      {
        type: 'message',
        content: [{
          type: 'output_text',
          text: 'Evan Call composed it.',
          annotations: [{ type: 'url_citation', url: 'https://a.example/1?utm_source=openai', title: 'A page' }],
        }],
      },
    ],
  };
  assert.deepEqual(responsesAnswer(body).split('\n'), [
    'Evan Call composed it.',
    '',
    'Searched: frieren soundtrack composer',
    '',
    'Sources (read one with read_page):',
    '1. A page: https://a.example/1',
    '2. B page: https://b.example/2',
  ]);
});

test('a Codex search that found nothing at all is an error the model can act on', () => {
  assert.throws(() => responsesAnswer({ output: [] }), /try other words/);
  assert.throws(() => responsesAnswer({}), /try other words/);
});

test('a Codex search with sources but no words says there was no answer, and keeps the sources', () => {
  const body = { output: [{ type: 'web_search_call', action: { queries: ['one', 'two'], sources: [{ url: 'https://a.example/' }] } }] };
  assert.deepEqual(responsesAnswer(body).split('\n'), ['(No answer.)', '', 'Searched: one; two', '', 'Sources (read one with read_page):', '1. untitled: https://a.example/']);
});

test('with no SearXNG, a search goes to Codex’s web search, at medium, and NVIDIA is never asked', async (t) => {
  const asked: Array<{ path: string; body: Record<string, unknown>; auth?: string }> = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      asked.push({ path: req.url ?? '', body: JSON.parse(raw), auth: req.headers.authorization });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'From Codex.' }] }] }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1beta`;
  const brain = {
    models: [
      { id: 'nim-nvidia--nemotron-3.5-super-vl-120b-a12b', baseUrl: base },
      { id: 'gpt-6.1-terra', baseUrl: base },
    ],
    apiKey: 'a-key-for-the-tests',
    stream: () => { throw new Error('not used'); },
    opensAt: async () => null,
  } as never;

  assert.equal(await webSearch(brain, 'who scored it?'), 'From Codex.');
  assert.equal(asked.length, 1, 'NVIDIA is never asked to search');
  assert.equal(asked[0].path, '/v1/responses');
  assert.equal(asked[0].auth, 'Bearer a-key-for-the-tests');
  assert.equal(asked[0].body.model, 'gpt-6.1-terra');
  assert.deepEqual(asked[0].body.tools, [{ type: 'web_search' }]);
  assert.deepEqual(asked[0].body.reasoning, { effort: 'medium' });
  assert.match(String(asked[0].body.input), /who scored it\?/);
});

test('when every model fails the search says so, each with its status', async (t) => {
  const server = createServer((_req, res) => {
    res.statusCode = 503;
    res.end('{}');
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1beta`;
  const brain = { models: [{ id: 'gpt-6.1-terra', baseUrl: base }, { id: 'gpt-6.2-sol', baseUrl: base }], apiKey: 'k' } as never;
  await assert.rejects(webSearch(brain, 'q'), /The search failed \(gpt-6\.1-terra: 503; gpt-6\.2-sol: 503\)/);
});

test('SearXNG’s results read as titles, addresses and short snippets, each address once, ten at most', () => {
  const results = [
    { url: 'https://a.example/', title: ' A page ', content: 'One  line\n of it.' },
    { url: 'https://a.example/', title: 'A again', content: 'twice' },
    { url: 'https://b.example/', content: 'x'.repeat(400) },
    { title: 'No address' },
  ];
  for (let i = 0; i < 12; i++) results.push({ url: `https://c.example/${i}`, title: `C ${i}`, content: '' });
  const lines = searxAnswer({ results }, 'who scored it?').split('\n');
  assert.equal(lines[0], 'Results for: who scored it?');
  assert.equal(lines[3], '1. A page: https://a.example/');
  assert.equal(lines[4], '   One line of it.');
  assert.equal(lines[5], '2. untitled: https://b.example/');
  assert.equal(lines[6].length, 3 + 300);
  assert.equal(lines.filter((l) => /^\d+\. /.test(l)).length, 10);
  assert.equal(lines.at(-1), '10. C 7: https://c.example/7');
});

test('SearXNG finding nothing says to try other words', () => {
  assert.throws(() => searxAnswer({ results: [] }, 'q'), /found nothing: try other words/);
  assert.throws(() => searxAnswer({}, 'q'), /found nothing/);
});

test('an NVIDIA model searches on SearXNG, once, and Codex takes over when SearXNG is down', async (t) => {
  const asked: string[] = [];
  let searxDown = false;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      asked.push(req.url ?? '');
      res.setHeader('content-type', 'application/json');
      if (req.url?.startsWith('/search')) {
        if (searxDown) {
          res.statusCode = 502;
          res.end('{}');
          return;
        }
        res.end(JSON.stringify({ results: [{ url: 'https://a.example/', title: 'A', content: 'From SearXNG.' }] }));
        return;
      }
      res.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'From Codex.' }] }] }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.SEARXNG_URL = `${root}/`;
  t.after(() => {
    delete process.env.SEARXNG_URL;
    server.close();
  });
  const brain = {
    models: [
      { id: 'nim-moonshotai--kimi-k2.6', baseUrl: `${root}/v1beta` },
      { id: 'nim-nvidia--nemotron-3-ultra-550b-a55b', baseUrl: `${root}/v1beta` },
      { id: 'gpt-6.1-terra', baseUrl: `${root}/v1beta` },
    ],
    apiKey: 'k',
  } as never;

  assert.match(await webSearch(brain, 'who scored it?'), /1\. A: https:\/\/a\.example\/\n   From SearXNG\./);
  assert.deepEqual(asked, ['/search?q=who+scored+it%3F&format=json']);

  searxDown = true;
  assert.equal(await webSearch(brain, 'who scored it?'), 'From Codex.');
  assert.deepEqual(asked.slice(1), ['/search?q=who+scored+it%3F&format=json', '/v1/responses'], 'SearXNG is asked once, then Codex');
});

test('with only NVIDIA models and SearXNG down, the search says so', async (t) => {
  const server = createServer((_req, res) => {
    res.statusCode = 503;
    res.end('{}');
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  process.env.SEARXNG_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(() => {
    delete process.env.SEARXNG_URL;
    server.close();
  });
  const brain = { models: [{ id: 'nim-moonshotai--kimi-k2.6', baseUrl: 'http://unused/v1beta' }], apiKey: 'k' } as never;
  await assert.rejects(webSearch(brain, 'q'), /The search failed \(SearXNG: 503\)/);
});
