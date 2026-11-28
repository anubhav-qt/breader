import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Rung } from '../balancer.ts';
import { answerByModel, calls } from './nvidia.ts';

/*
 * Codex as NVIDIA's backup (backup.ts): the window it keeps the calls for, and the balancer
 * handing it a call only once NVIDIA's first model, tried again, and its second are both down.
 * The proxy is a stand-in: the test's fetch answers every call, Codex's too. The clock moves
 * only when the test moves it.
 */

process.env.AI_WORK = mkdtempSync(join(tmpdir(), 'breader-ai-test-'));
process.env.CLIPROXY_URL = 'http://proxy.test';
process.env.CLIPROXY_API_KEY = 'proxy-key';
const { BACKUP_MS, checkBackup, onBackup, resetBackup, startBackup, whenBackupEnds } = await import('../backup.ts');
const { Balancer, withBackup } = await import('../balancer.ts');
const { CODEX_FIRST } = await import('../proxy.ts');

let made = 0;
function rungs() {
  made++;
  const first: Rung = { model: `test/first-${made}`, name: `first-${made}`, maxTokens: 100, maxInFlight: 2, primary: true };
  const second: Rung = { model: `test/second-${made}`, name: `second-${made}`, maxTokens: 100, maxInFlight: 2 };
  return { first, second };
}

const ask = [{ role: 'user' as const, content: 'hello' }];
const who = (model: string) => calls.filter((c) => c.model === model).length;
const quick = { waitForTopS: 300, strikesToFall: 2, maxTries: 20 };

function virtualTime(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  t.mock.method(Math, 'random', () => 0.5);
  resetBackup();
  t.after(resetBackup);
}

/** Lets a call run, a virtual second at a time, and says how long it took. */
async function run<T>(t: TestContext, p: Promise<T>, limitS = 5000) {
  const t0 = Date.now();
  let settled = false;
  let value: T | undefined;
  let error: Error | undefined;
  p.then(
    (v) => { value = v; settled = true; },
    (e: Error) => { error = e; settled = true; },
  );
  for (let s = 0; s < limitS && !settled; s++) {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(1000);
  }
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  return { settled, value, error, secs: (Date.now() - t0) / 1000 };
}

test('the window opens once, lasts 10 minutes, and ends only when it is looked at after that', (t) => {
  virtualTime(t);
  let ended = 0;
  whenBackupEnds(() => ended++);
  assert.equal(onBackup(0), false);
  startBackup(0);
  assert.equal(onBackup(BACKUP_MS - 1), true);
  startBackup(5000);
  assert.equal(onBackup(BACKUP_MS + 1000), false, 'a second start inside the window doesn’t stretch it');
  checkBackup(BACKUP_MS - 1);
  assert.equal(ended, 0);
  checkBackup(BACKUP_MS);
  assert.equal(ended, 1);
  checkBackup(BACKUP_MS * 2);
  assert.equal(ended, 1, 'it ends once');
});

test('the ladder gets Codex last; while it has the calls, Codex first and alone at the top', (t) => {
  virtualTime(t);
  const { first, second } = rungs();
  const usual = withBackup([first, second], 0);
  assert.deepEqual(usual.map((r) => r.model), [first.model, second.model, CODEX_FIRST]);
  assert.equal(usual[2].codex, true);
  assert.deepEqual(usual[2].extra, { reasoning_effort: 'medium' }, 'Terra at medium');
  startBackup(0);
  const backup = withBackup([first, second], 1000);
  assert.deepEqual(backup.map((r) => r.model), [CODEX_FIRST, first.model, second.model]);
  assert.deepEqual(backup.map((r) => !!r.primary), [true, false, false]);
});

test('with no proxy there is no backup', (t) => {
  virtualTime(t);
  const { first, second } = rungs();
  const before = process.env.CLIPROXY_URL;
  delete process.env.CLIPROXY_URL;
  t.after(() => (process.env.CLIPROXY_URL = before));
  assert.deepEqual(withBackup([first, second], 0).map((r) => r.model), [first.model, second.model]);
});

test('NVIDIA’s first is tried again, then its second, then Codex, which keeps the calls 10 minutes', async (t) => {
  virtualTime(t);
  const { first, second } = rungs();
  answerByModel({ [first.model]: [503], [second.model]: [503], [CODEX_FIRST]: ['from codex'] });
  calls.length = 0;
  const lb = new Balancer([first, second], quick);
  const r = await run(t, lb.chat(ask, {}));
  assert.equal(r.value?.reply.text, 'from codex');
  assert.equal(r.value?.rung.codex, true);
  assert.ok(who(first.model) >= 2, `the first was asked ${who(first.model)} times`);
  assert.ok(who(second.model) >= 1, 'then the second');
  assert.equal(onBackup(Date.now()), true);

  // NVIDIA answers again, but Codex has the calls till the window ends.
  answerByModel({ [first.model]: ['from nvidia'], [second.model]: ['from nvidia'], [CODEX_FIRST]: ['from codex'] });
  const during = await run(t, lb.chat(ask, {}));
  assert.equal(during.value?.reply.text, 'from codex');

  t.mock.timers.tick(BACKUP_MS);
  const after = await run(t, lb.chat(ask, {}));
  assert.equal(after.value?.reply.text, 'from nvidia', 'the window ended: NVIDIA first again');
  assert.equal(after.value?.rung.model, first.model, 'its cooldown forgotten');
});

test('Codex failing while it has the calls hands them back to NVIDIA', async (t) => {
  virtualTime(t);
  const { first, second } = rungs();
  answerByModel({ [first.model]: ['from nvidia'], [second.model]: ['from nvidia'], [CODEX_FIRST]: [503] });
  startBackup(0);
  const r = await run(t, new Balancer([first, second], quick).chat(ask, {}));
  assert.equal(r.value?.reply.text, 'from nvidia');
});

test('a call NVIDIA turns away goes to Codex, but opens no window', async (t) => {
  virtualTime(t);
  const { first, second } = rungs();
  answerByModel({ [first.model]: [400], [second.model]: [400], [CODEX_FIRST]: ['from codex'] });
  const r = await run(t, new Balancer([first, second], quick).chat(ask, {}));
  assert.equal(r.value?.reply.text, 'from codex');
  assert.equal(onBackup(Date.now()), false);
});

test('casting the voices asks Codex first, with NVIDIA well', async (t) => {
  virtualTime(t);
  const { first, second } = rungs();
  answerByModel({ [first.model]: ['from nvidia'], [second.model]: ['from nvidia'], [CODEX_FIRST]: ['from codex'] });
  const lb = new Balancer([first, second], quick);
  const r = await run(t, lb.chat(ask, { book: 'b', cast: 'voices', try: 1 }));
  assert.equal(r.value?.reply.text, 'from codex');
  assert.equal(onBackup(Date.now()), false, 'it isn’t the backup taking over');
  const other = await run(t, lb.chat(ask, { book: 'b', part: 1 }));
  assert.equal(other.value?.reply.text, 'from nvidia', 'other calls stay NVIDIA’s');
});

test('casting the voices goes to NVIDIA when Codex fails', async (t) => {
  virtualTime(t);
  const { first, second } = rungs();
  answerByModel({ [first.model]: ['from nvidia'], [second.model]: ['from nvidia'], [CODEX_FIRST]: [503] });
  const lb = new Balancer([first, second], { ...quick, strikesToFall: 1 });
  const r = await run(t, lb.chat(ask, { book: 'b', cast: 'voices', try: 1 }));
  assert.equal(r.value?.reply.text, 'from nvidia');
});

test('a call marked codexFirst asks Codex first, on any stage, and opens no window', async (t) => {
  virtualTime(t);
  const { first, second } = rungs();
  answerByModel({ [first.model]: ['from nvidia'], [second.model]: ['from nvidia'], [CODEX_FIRST]: ['from codex'] });
  const lb = new Balancer([first, second], quick);
  const r = await run(t, lb.chat(ask, { book: 'b', part: 1, codexFirst: true }));
  assert.equal(r.value?.reply.text, 'from codex');
  assert.equal(onBackup(Date.now()), false, 'it isn’t the backup taking over');
  const next = await run(t, lb.chat(ask, { book: 'b', part: 2 }));
  assert.equal(next.value?.reply.text, 'from nvidia', 'a call without it stays NVIDIA’s');
});
