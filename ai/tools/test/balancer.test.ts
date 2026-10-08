import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Rung } from '../balancer.ts';
import { answerByModel, calls } from './nvidia.ts';

/*
 * The balancer in virtual time: NVIDIA is a script (nvidia.ts) and the clock moves only when the
 * test moves it, so an hour of backing off takes a moment. Math.random is pinned at 0.5, which
 * makes every jitter exactly 1, so the waits can be checked to the second.
 */

process.env.AI_WORK = mkdtempSync(join(tmpdir(), 'breader-ai-test-'));
const { Balancer, jitter } = await import('../balancer.ts');

/** Rungs with names of their own, since every Balancer in a process shares a model's state. */
let made = 0;
function rungs() {
  made++;
  const kimi: Rung = { model: `test/kimi-${made}`, name: `kimi-${made}`, maxTokens: 100, maxInFlight: 2, primary: true };
  const nemo: Rung = { model: `test/nemo-${made}`, name: `nemo-${made}`, maxTokens: 100, maxInFlight: 2 };
  return { kimi, nemo };
}

const patient = { waitForTopS: 300, strikesToFall: 3, maxTries: Infinity, patient: true };
const ask = [{ role: 'user' as const, content: 'hello' }];
const who = (r: Rung) => calls.filter((c) => c.model === r.model).length;

function virtualTime(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  t.mock.method(Math, 'random', () => 0.5);
}

/** Lets a call run, a virtual second at a time, for up to `limitS`, and says how long it took. */
async function run<T>(t: TestContext, p: Promise<T>, limitS = 20_000) {
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

test('jitter is half to one and a half times as long', (t) => {
  t.mock.method(Math, 'random', () => 0);
  assert.equal(jitter(60), 30);
  t.mock.method(Math, 'random', () => 0.999);
  assert.ok(jitter(60) > 89.9 && jitter(60) < 90);
});

test('a 429 cools the model, and the same call answers once it has waited', async (t) => {
  virtualTime(t);
  const { kimi, nemo } = rungs();
  answerByModel({ [kimi.model]: [429, 'ok'], [nemo.model]: ['from nemotron'] });
  const r = await run(t, new Balancer([kimi, nemo], patient).chat(ask, {}));
  assert.equal(r.value?.reply.text, 'ok');
  assert.equal(r.value?.tries, 2);
  assert.ok(r.secs >= 60 && r.secs <= 62, `waited ${r.secs} s`);
  assert.equal(who(nemo), 0, 'a minute is worth waiting for the top model');
});

test('429 after 429: the waits double up to the cap, and a patient call never gives up', async (t) => {
  virtualTime(t);
  const { kimi } = rungs();
  answerByModel({ [kimi.model]: [429, 429, 429, 429, 429, 429, 429, 429, 'ok'] });
  const r = await run(t, new Balancer([kimi], patient).chat(ask, {}));
  assert.equal(r.value?.reply.text, 'ok');
  assert.equal(r.value?.tries, 9);
  // 60, 120, 240, 480, 960, then the cap of 1,800 three times.
  const want = 60 + 120 + 240 + 480 + 960 + 1800 * 3;
  assert.ok(r.secs >= want && r.secs <= want + 10, `waited ${r.secs} s, wanted about ${want}`);
});

test('a call that is not patient stops after its tries', async (t) => {
  virtualTime(t);
  const { kimi } = rungs();
  answerByModel({ [kimi.model]: [503] });
  const r = await run(t, new Balancer([kimi], { waitForTopS: 300, strikesToFall: 3, maxTries: 3 }).chat(ask, {}));
  assert.match(r.error?.message ?? '', /No answer after 3 tries/);
});

test('empty answers are that call’s alone: three, and it asks the next model', async (t) => {
  virtualTime(t);
  const { kimi, nemo } = rungs();
  answerByModel({ [kimi.model]: ['', '', '', 'kimi again'], [nemo.model]: ['from nemotron'] });
  const lb = new Balancer([kimi, nemo], patient);
  const r = await run(t, lb.chat(ask, {}));
  assert.equal(r.value?.reply.text, 'from nemotron');
  assert.equal(who(kimi), 3);
  // 20 s, then 40 s, between the empty answers.
  assert.ok(r.secs >= 60 && r.secs <= 62, `waited ${r.secs} s`);
  const next = await run(t, lb.chat(ask, {}));
  assert.equal(next.value?.reply.text, 'kimi again', 'the model itself never cooled');
  assert.ok(next.secs <= 1);
});

test('a refused request goes to the next model at once', async (t) => {
  virtualTime(t);
  const { kimi, nemo } = rungs();
  answerByModel({ [kimi.model]: [400], [nemo.model]: ['from nemotron'] });
  const r = await run(t, new Balancer([kimi, nemo], patient).chat(ask, {}));
  assert.equal(r.value?.reply.text, 'from nemotron');
  assert.ok(r.secs <= 1);
});

test('when every model answers a call empty, it fails, so its book can rest and try later', async (t) => {
  virtualTime(t);
  const { kimi, nemo } = rungs();
  answerByModel({ [kimi.model]: [''], [nemo.model]: [''] });
  const r = await run(t, new Balancer([kimi, nemo], patient).chat(ask, {}));
  assert.match(r.error?.message ?? '', /No model left to ask: kimi-\d+ answered it empty 3 times; nemo-\d+ answered it empty 3 times/);
});

test('a refused key: a patient run asks again about an hour later', async (t) => {
  virtualTime(t);
  const { kimi, nemo } = rungs();
  answerByModel({ [kimi.model]: [403, 'kimi is back'], [nemo.model]: ['from nemotron'] });
  const lb = new Balancer([kimi, nemo], patient);
  const r = await run(t, lb.chat(ask, {}));
  assert.equal(r.value?.reply.text, 'from nemotron', 'an hour is too long to wait for the top model');
  assert.ok(Balancer.refused().includes(kimi.name));
  t.mock.timers.tick(3601_000);
  const later = await run(t, lb.chat(ask, {}));
  assert.equal(later.value?.reply.text, 'kimi is back');
  assert.ok(!Balancer.refused().includes(kimi.name));
});

test('a refused key: a run that is not patient drops the model', async (t) => {
  virtualTime(t);
  const { kimi } = rungs();
  answerByModel({ [kimi.model]: [403] });
  const r = await run(t, new Balancer([kimi], { waitForTopS: 300, strikesToFall: 3, maxTries: 12 }).chat(ask, {}));
  assert.match(r.error?.message ?? '', /No model left to ask: kimi-\d+ refuses the key/);
});

test('notes calls wait while a book is being marked, then go', async (t) => {
  virtualTime(t);
  const { kimi } = rungs();
  answerByModel({ [kimi.model]: ['a note'] });
  const notes = new Balancer([kimi], { ...patient, low: true });
  const marks = new Balancer([kimi], patient);
  Balancer.holdLow = true;
  const waiting = notes.chat(ask, {});
  const held = await run(t, waiting, 600);
  assert.equal(held.settled, false);
  assert.equal(who(kimi), 0);
  const mark = await run(t, marks.chat(ask, {}));
  assert.equal(mark.value?.reply.text, 'a note', 'marks go straight through');
  Balancer.holdLow = false;
  const r = await run(t, waiting);
  assert.equal(r.value?.reply.text, 'a note');
  assert.ok(r.secs <= 11, `waited ${r.secs} s after the hold`);
});
