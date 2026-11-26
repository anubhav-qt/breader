import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Brain } from '../harness.ts';

/*
 * The harness's choices, without a model: what a failed call's message means, which model takes
 * the next call while others cool, when Codex, NVIDIA's backup, takes the calls, and the order the
 * proxy's Codex models are tried in. The
 * clock is pinned, and Math.random at 0.5 makes every jitter exactly 1.
 */

process.env.AI_WORK = mkdtempSync(join(tmpdir(), 'breader-ai-test-'));
const { byLine, choose, cool, coolCodex, failureOf, inTurn, nvidiaDown, pick, routed, tool, withCodexThinking } = await import('../harness.ts');
const { BACKUP_MS, checkBackup, onBackup, resetBackup } = await import('../backup.ts');
const { Type } = await import('../../pi/pi-ai/src/index.ts');
const { accountOf, CODEX_FIRST, CODEX_SECOND, codexInOrder, codexModels, isCodexForText, proxyRoot } = await import('../proxy.ts');

test('a limit or quota is a rate failure, however it’s said', () => {
  assert.equal(failureOf('Server requested 37s retry delay'), 'rate');
  assert.equal(failureOf('429 Too Many Requests'), 'rate');
  assert.equal(failureOf('{"error":{"status":"RESOURCE_EXHAUSTED"}}'), 'rate');
  assert.equal(failureOf('Quota exceeded for this account'), 'rate');
});

test('a sign-in turned away is its own failure, so the run stops', () => {
  assert.equal(failureOf('401 Unauthorized'), 'signIn');
  assert.equal(failureOf('{"error":{"code": 403,"message":"denied"}}'), 'signIn');
});

test('a busy server, a timeout or no status at all is busy; any other status is a bad request', () => {
  assert.equal(failureOf('status code 503'), 'busy');
  assert.equal(failureOf('408 Request Timeout'), 'busy');
  assert.equal(failureOf('fetch failed'), 'busy');
  assert.equal(failureOf('400 Bad Request'), 'bad');
});

/** Models with names of their own, since the cooldowns are shared by everything in the process. */
let made = 0;
function models() {
  made++;
  return [{ id: `flash-${made}` }, { id: `pro-${made}` }, { id: `lite-${made}` }];
}

function pinned(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  t.mock.method(Math, 'random', () => 0.5);
}

test('the first model takes the call while it isn’t cooling', (t) => {
  pinned(t);
  const [flash, pro] = models();
  assert.equal(pick([flash, pro], new Map(), 0), flash);
});

test('Flash cooling a little while is waited for', (t) => {
  pinned(t);
  const [flash, pro] = models();
  cool(flash.id, 'rate');
  // A minute's cooldown, and only one failure: worth waiting for.
  assert.equal(pick([flash, pro], new Map(), 0), 60_000);
  assert.equal(pick([flash, pro], new Map(), 60_000), flash);
});

test('Flash failing again, the next model that isn’t cooling takes the call', (t) => {
  pinned(t);
  const [flash, pro, lite] = models();
  cool(flash.id, 'rate');
  cool(flash.id, 'rate');
  assert.equal(pick([flash, pro, lite], new Map(), 0), pro);
  cool(pro.id, 'busy');
  assert.equal(pick([flash, pro, lite], new Map(), 0), lite);
});

test('with every model cooling, it looks again when the first cools down, a minute at most', (t) => {
  pinned(t);
  const [flash, pro] = models();
  cool(flash.id, 'rate');
  cool(flash.id, 'rate');
  cool(pro.id, 'busy');
  // Flash for two minutes, Pro for 30 seconds.
  assert.equal(pick([flash, pro], new Map(), 0), 30_000);
  cool(pro.id, 'busy');
  cool(pro.id, 'busy');
  assert.equal(pick([flash, pro], new Map(), 0), 60_000);
});

test('models that turned the run away are passed over, and when none is left it says why', () => {
  const [flash, pro] = models();
  const skip = new Map([[flash.id, 'flash said no']]);
  assert.equal(pick([flash, pro], skip, 0), pro);
  skip.set(pro.id, 'pro said no');
  assert.throws(() => pick([flash, pro], skip, 0), /Every model turned the request away: flash said no; pro said no/);
});

test('Codex: Terra first, then Sol 6.2, then the newest version, whatever order they come in', () => {
  const ids = ['gpt-5.6-sol', 'gpt-6-astra', CODEX_SECOND, 'gpt-6.1-sol', CODEX_FIRST, 'gpt-6.2-astra'];
  assert.deepEqual(codexInOrder(ids), [CODEX_FIRST, CODEX_SECOND, 'gpt-6.2-astra', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.6-sol']);
  assert.deepEqual(codexInOrder(['gpt-6.1-sol', 'gpt-6-luna']), ['gpt-6.1-sol', 'gpt-6-luna'], 'neither first one connected');
});

test('only Codex models that work through a task are used: no image, review or chat models', () => {
  assert.equal(isCodexForText('gpt-6.1-terra'), true);
  assert.equal(isCodexForText('gpt-6.2-sol'), true);
  assert.equal(isCodexForText('gpt-image-2.5'), false);
  assert.equal(isCodexForText('gpt-6-chat-thinking'), false);
  assert.equal(isCodexForText('codex-auto-review'), false);
  assert.equal(isCodexForText('gemini-3.8-flash-high'), false);
});

test('each model is on its own kind of account: Codex’s are gpt-, every other is NVIDIA’s', () => {
  assert.equal(accountOf('gpt-6.1-terra'), 'Codex');
  assert.equal(accountOf('nim-nvidia--nemotron-3.5-super-vl-120b-a12b'), 'NVIDIA');
  assert.equal(accountOf('nvidia/nemotron-3-ultra-550b-a55b'), 'NVIDIA');
});

test('a run’s work names every model that answered, with its account', () => {
  assert.equal(byLine(['gpt-6.1-terra']), 'gpt-6.1-terra on Codex');
  assert.equal(byLine(new Set(['nim-nvidia--nemotron-3.5-super-vl-120b-a12b', 'gpt-6.1-terra'])), 'nim-nvidia--nemotron-3.5-super-vl-120b-a12b on NVIDIA and gpt-6.1-terra on Codex');
  assert.equal(byLine([]), 'no model');
});

/** NVIDIA's two models and Codex's two, with names of their own. */
function ladder() {
  made++;
  return [{ id: `nim-first-${made}` }, { id: `nim-second-${made}` }, { id: `gpt-6.1-terra-${made}` }, { id: `gpt-6.2-sol-${made}` }];
}

/** A brain of the ladder's models, as routed() reorders it. */
function brainOf(models: Array<{ id: string }>): Brain {
  return { models, apiKey: '', stream: null, opensAt: async () => null } as unknown as Brain;
}

test('the soundtrack asks Codex first and NVIDIA behind it; every other stage NVIDIA first', () => {
  const all = ladder();
  const ids = (b: Brain) => b.models.map((m) => m.id);
  assert.deepEqual(ids(routed(brainOf(all), { soundtrack: 'spice-and-wolf' })), [all[2].id, all[3].id, all[0].id, all[1].id]);
  assert.deepEqual(ids(routed(brainOf(all), { research: 'spice-and-wolf' })), all.map((m) => m.id));
  assert.deepEqual(ids(routed(brainOf(all), { part: 3 })), all.map((m) => m.id));
  const nvidiaOnly = all.slice(0, 2);
  assert.deepEqual(ids(routed(brainOf(nvidiaOnly), { soundtrack: 'x' })), nvidiaOnly.map((m) => m.id), 'no Codex: NVIDIA alone');
});

test('the soundtrack goes to NVIDIA once Codex can’t answer: out of its limits, or failing twice', (t) => {
  pinned(t);
  const out = routed(brainOf(ladder()), { soundtrack: 'x' }).models;
  coolCodex(out, 3 * 3600_000);
  assert.equal(pick(out, new Map(), 0), out[2], 'Codex out for hours: NVIDIA’s first');

  const busy = routed(brainOf(ladder()), { soundtrack: 'x' }).models;
  cool(busy[0].id, 'busy');
  assert.equal(pick(busy, new Map(), 0), 30_000, 'one failure: Codex is waited for');
  cool(busy[0].id, 'busy');
  cool(busy[1].id, 'busy');
  cool(busy[1].id, 'busy');
  assert.equal(pick(busy, new Map(), 0), busy[2], 'both Codex models failing: NVIDIA’s first');
});

test('a Codex limit cools every Codex model, until when the account says, and leaves NVIDIA alone', (t) => {
  pinned(t);
  const all = ladder();
  coolCodex(all, 5_000);
  assert.equal(pick(all.slice(2), new Map(), 0), 5_000, 'both Codex models wait for the account');
  assert.equal(pick(all, new Map(), 0), all[0], 'NVIDIA still takes the call');
});

test('NVIDIA’s first model is tried again, then its second, and only then Codex', (t) => {
  pinned(t);
  resetBackup();
  t.after(resetBackup);
  const all = ladder();
  cool(all[0].id, 'busy');
  assert.equal(pick(inTurn(all, 0), new Map(), 0), 30_000, 'one failure: the first is waited for');
  cool(all[0].id, 'busy');
  assert.equal(pick(inTurn(all, 0), new Map(), 0), all[1], 'twice: the second');
  assert.equal(nvidiaDown(all, 0), false);
  cool(all[1].id, 'busy');
  assert.equal(nvidiaDown(all, 0), true);
  assert.equal(pick(inTurn(all, 0), new Map(), 0), all[2], 'both cooling: Codex');
});

test('Codex taking a call while NVIDIA is down keeps the calls for 10 minutes, then NVIDIA is tried afresh', async (t) => {
  pinned(t);
  resetBackup();
  t.after(resetBackup);
  const all = ladder();
  for (const m of all.slice(0, 2)) {
    cool(m.id, 'busy');
    cool(m.id, 'busy');
  }
  assert.equal(await choose(all, new Map()), all[2]);
  assert.equal(onBackup(0), true);
  assert.equal(BACKUP_MS, 10 * 60_000);

  // NVIDIA has cooled down, but Codex still has the calls till the window ends.
  t.mock.timers.setTime(BACKUP_MS - 1);
  assert.deepEqual(inTurn(all, Date.now()).map((m) => m.id), [all[2].id, all[3].id, all[0].id, all[1].id]);
  assert.equal(await choose(all, new Map()), all[2]);

  t.mock.timers.setTime(BACKUP_MS);
  assert.equal(await choose(all, new Map()), all[0], 'the window ended: NVIDIA first again');
  assert.equal(onBackup(Date.now()), false);
});

test('the window’s end forgets NVIDIA’s cooldowns, so its first model is asked at once', async (t) => {
  pinned(t);
  resetBackup();
  t.after(resetBackup);
  const all = ladder();
  // Half an hour of cooling for the first, longer than the window.
  for (let i = 0; i < 6; i++) cool(all[0].id, 'rate');
  cool(all[1].id, 'rate');
  cool(all[1].id, 'rate');
  assert.equal(await choose(all, new Map()), all[2]);
  t.mock.timers.setTime(BACKUP_MS);
  checkBackup(Date.now());
  assert.equal(pick(all, new Map(), Date.now()), all[0], 'its cooling is forgotten');
});

test('NVIDIA turning one request away hands it to Codex, but opens no window', async (t) => {
  pinned(t);
  resetBackup();
  t.after(resetBackup);
  const all = ladder();
  const skip = new Map([[all[0].id, 'no'], [all[1].id, 'no']]);
  assert.equal(await choose(all, skip), all[2]);
  assert.equal(onBackup(0), false);
});

test('Codex thinks at medium, which the proxy reads from a budget; NVIDIA keeps the harness’s own', () => {
  const given: Array<{ id: string; options: unknown }> = [];
  const stream = withCodexThinking(((model: { id: string }, _context: unknown, options: unknown) => {
    given.push({ id: model.id, options });
    return null;
  }) as never);
  const nim = 'nim-nvidia--nemotron-3.5-super-vl-120b-a12b';
  stream({ id: 'gpt-6.1-terra', provider: 'codex' } as never, { messages: [] } as never, { reasoning: 'high', apiKey: 'k' });
  stream({ id: nim, provider: 'nvidia' } as never, { messages: [] } as never, { reasoning: 'high', apiKey: 'k' });
  assert.deepEqual(given, [
    { id: 'gpt-6.1-terra', options: { reasoning: 'medium', apiKey: 'k', thinkingBudgets: { medium: 8192 } } },
    { id: nim, options: { reasoning: 'high', apiKey: 'k' } },
  ]);
});

/** A stand-in proxy that lists `models`, at CLIPROXY_URL. */
async function standIn(t: TestContext, models: () => Array<{ id: string; owned_by: string }>) {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: models() }));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const port = (server.address() as AddressInfo).port;
  const before = { url: process.env.CLIPROXY_URL, key: process.env.CLIPROXY_API_KEY };
  t.after(() => {
    process.env.CLIPROXY_URL = before.url;
    process.env.CLIPROXY_API_KEY = before.key;
    server.close();
  });
  process.env.CLIPROXY_URL = `http://127.0.0.1:${port}`;
  process.env.CLIPROXY_API_KEY = 'a-key-for-the-tests';
  return server;
}

test('the backup is Codex’s models that work through a task, Terra first, through the proxy’s Gemini door', async (t) => {
  await standIn(t, () => [
    { id: 'gemini-3.1-pro', owned_by: 'antigravity' },
    { id: 'gpt-6.2-sol', owned_by: 'openai' },
    { id: 'gpt-image-2', owned_by: 'openai' },
    { id: 'gpt-6.1-terra', owned_by: 'openai' },
    { id: 'claude-sonnet-5-5', owned_by: 'claude' },
  ]);
  const p = { url: process.env.CLIPROXY_URL!, apiKey: 'a-key-for-the-tests', managementKey: '' };
  const models = await codexModels(p);
  assert.deepEqual(models.map((m) => m.id), ['gpt-6.1-terra', 'gpt-6.2-sol']);
  assert.deepEqual(models.map((m) => m.provider), ['codex', 'codex']);
  assert.equal(models[0].baseUrl, `${p.url}/v1beta`);
  assert.equal(proxyRoot(models[0]), p.url);
  assert.equal(models[0].contextWindow, 272_000, 'Codex’s own window, so its chats compact in time');
});

test('with no Codex account, or no proxy answering, there’s no backup and NVIDIA works alone', async (t) => {
  const server = await standIn(t, () => [{ id: 'claude-sonnet-5-5', owned_by: 'claude' }]);
  const p = { url: process.env.CLIPROXY_URL!, apiKey: 'a-key-for-the-tests', managementKey: '' };
  assert.deepEqual(await codexModels(p), []);
  await new Promise<void>((ok) => server.close(() => ok()));
  assert.deepEqual(await codexModels(p), []);
});

test('a tool hands back its whole result, however long', async () => {
  const long = 'a line of research\n'.repeat(5000);
  const t = tool('show', 'Shows it all.', Type.Object({}), () => long);
  const result = await t.execute('call-1', {});
  assert.deepEqual(result.content, [{ type: 'text', text: long }]);
});
