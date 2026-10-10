import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

/*
 * The harness's choices, without Gemini: what a failed call's message means, which model takes
 * the next call while others cool, and the order the proxy's Gemini models are tried in. The
 * clock is pinned, and Math.random at 0.5 makes every jitter exactly 1.
 */

process.env.AI_WORK = mkdtempSync(join(tmpdir(), 'breader-ai-test-'));
const { cool, failureOf, pick } = await import('../harness.ts');
const { FIRST_MODEL, inOrder, isGeminiForText } = await import('../proxy.ts');

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
  assert.throws(() => pick([flash, pro], skip, 0), /Every Gemini model turned the request away: flash said no; pro said no/);
});

test('Gemini 3.8 Flash high first, then the newest version, the bigger model first, unversioned last', () => {
  const ids = ['gemini-exp', 'gemini-2.5-pro', 'gemini-3.1-flash-lite', 'gemini-3.1-flash', FIRST_MODEL, 'gemini-3.1-pro', 'gemini-3.8-flash'];
  assert.deepEqual(inOrder(ids), [FIRST_MODEL, 'gemini-3.8-flash', 'gemini-3.1-pro', 'gemini-3.1-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-pro', 'gemini-exp']);
  assert.equal(ids[0], 'gemini-exp', 'the list given is left as it was');
});

test('only Gemini models that write text are used', () => {
  assert.equal(isGeminiForText('gemini-3.8-flash-high'), true);
  assert.equal(isGeminiForText('gemini-3.1-flash-image'), false);
  assert.equal(isGeminiForText('claude-sonnet-5-5'), false);
});
