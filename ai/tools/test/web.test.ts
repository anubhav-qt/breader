import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

/*
 * The harness's view of the web, without the web: which addresses are kept out, what the reader
 * view makes of a small page, and how a grounded answer reads to the model.
 */

process.env.AI_WORK = mkdtempSync(join(tmpdir(), 'breader-ai-test-'));
const { isPrivate, pageText, searchAnswer } = await import('../web.ts');

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

test('a grounded answer reads as the answer, what was searched, then the sources, numbered', () => {
  const body = {
    candidates: [{
      content: { parts: [{ text: 'Working it out first.', thought: true }, { text: 'The answer, ' }, { text: 'in two parts.' }] },
      groundingMetadata: {
        webSearchQueries: ['first search', 'second search'],
        groundingChunks: [{ web: { uri: 'https://a.example/1', title: 'A page' } }, { web: { uri: 'https://b.example/2' } }],
      },
    }],
  };
  const lines = searchAnswer(body).split('\n');
  assert.deepEqual(lines, [
    'The answer, in two parts.',
    '',
    'Searched: first search; second search',
    '',
    'Sources (read one with read_page):',
    '1. A page: https://a.example/1',
    '2. untitled: https://b.example/2',
  ]);
});

test('an answer that is only thinking says there was no answer', () => {
  const body = { candidates: [{ content: { parts: [{ text: 'Thinking only.', thought: true }] } }] };
  assert.equal(searchAnswer(body), '(No answer.)');
});

test('a search with no candidate at all is an error the model can act on', () => {
  assert.throws(() => searchAnswer({ candidates: [] }), /try other words/);
});
