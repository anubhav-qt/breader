import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { adminStateOf, ADMIN_DEFAULTS, nimAlias, withStages } from '../../../shared/src/admin.ts';
import { answerWith, calls } from './nvidia.ts';

/*
 * Who does each stage of the pipeline, as the admin page picks it: the call's stage read from its
 * label, the book's own pick over the one for books to come, and the balancer asking that model
 * first. Also the settings kept from before the page listed NVIDIA's models.
 */

process.env.AI_WORK = mkdtempSync(join(tmpdir(), 'breader-ai-test-'));
process.env.CLIPROXY_URL = 'http://proxy.test';
process.env.CLIPROXY_API_KEY = 'proxy-key';
const { Balancer } = await import('../balancer.ts');
const { control } = await import('../control.ts');
const { newJob, runIn } = await import('../jobs.ts');
const { LADDER, PRIMARY, setModels } = await import('../kimi.ts');
const { pickFor, stageOf } = await import('../stages.ts');

const BOOK = 'a'.repeat(64);
const ask = [{ role: 'user' as const, content: 'hello' }];
const inJob = <T>(fn: () => Promise<T>, id = BOOK) => runIn(newJob('book', 'A Book', 'marks', id), fn);

test('a call’s stage is read from its label', () => {
  assert.equal(stageOf({ book: 'b', cast: 'pass' }), 'marks.cast');
  assert.equal(stageOf({ book: 'b', part: 3, round: 1 }), 'marks.mark');
  assert.equal(stageOf({ book: 'b', part: 3, round: 1 }, true), 'marks.redo');
  assert.equal(stageOf({ book: 'b', fix: '1,2', round: 2 }), 'marks.check');
  assert.equal(stageOf({ book: 'b', fix: '1,2', round: 2 }, true), 'marks.redo');
  assert.equal(stageOf({ book: 'b', settle: 4 }), 'marks.settle');
  assert.equal(stageOf({ book: 'b', cast: 'voices', try: 1 }), 'marks.voices');
  assert.equal(stageOf({ book: 'b', research: 'series' }), 'research');
  assert.equal(stageOf({ soundtrack: 'frieren' }), 'music.gather');
  assert.equal(stageOf({ book: 'b', music: 'plan' }), 'music.plan');
  assert.equal(stageOf({ book: 'b', music: 4 }), 'music.score');
  assert.equal(stageOf({ book: 'b', music: 'fix-4', round: 1 }), 'music.check');
  assert.equal(stageOf({ book: 'b', notes: 'roster-fix', round: 1 }), 'notes.roster');
  assert.equal(stageOf({ book: 'b', notes: 7 }), 'notes.write');
  assert.equal(stageOf({ book: 'b', notes: 'fix', round: 1 }), 'notes.check');
  assert.equal(stageOf({ book: 'b', notes: 'review' }, true), 'notes.review');
});

test('a book’s own pick goes over the one for books to come, and only for that book', async () => {
  const s = withStages(withStages(ADMIN_DEFAULTS, { picks: { 'marks.mark': { provider: 'gemini' } } }), { ids: [BOOK], picks: { 'marks.mark': { provider: 'nim', model: 'z-ai/glm-5.3' } } });
  Object.assign(control, { stages: s.stages, stagesFor: s.stagesFor });
  try {
    assert.deepEqual(await inJob(async () => pickFor('marks.mark')), { provider: 'nim', model: 'z-ai/glm-5.3' });
    assert.deepEqual(await inJob(async () => pickFor('marks.mark'), 'b'.repeat(64)), { provider: 'gemini' });
    assert.equal(await inJob(async () => pickFor('notes.write')), null);
    const back = withStages(s, { ids: [BOOK], picks: { 'marks.mark': null } });
    assert.equal(back.stagesFor[BOOK], undefined);
  } finally {
    Object.assign(control, { stages: {}, stagesFor: {} });
  }
});

test('the balancer asks the stage’s pick first, Gemini through CLIProxyAPI, the usual models behind it', async () => {
  setModels('test/first', 'test/second');
  const urls: string[] = [];
  answerWith((model) => (model === 'gemini-4-argon' ? 503 : `${model} says hi`));
  const inner = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    urls.push(String(url));
    return inner(url as string, init);
  }) as typeof fetch;
  Object.assign(control, { stages: { 'marks.mark': { provider: 'nim', model: 'test/picked' } }, stagesFor: { [BOOK]: { 'marks.cast': { provider: 'gemini', model: 'gemini-3.8-flash-high' } } } });
  try {
    const lb = new Balancer(LADDER, { waitForTopS: 0, strikesToFall: 1, maxTries: 3 });
    calls.length = 0;
    const marked = await inJob(() => lb.chat(ask, { book: 'b', part: 1, round: 1 }));
    assert.equal(marked.rung.model, 'test/picked');
    const cast = await inJob(() => lb.chat(ask, { book: 'b', cast: 'pass' }));
    assert.equal(cast.rung.model, 'gemini-3.8-flash-high');
    assert.equal(urls.at(-1), 'http://proxy.test/v1/chat/completions');
    // Settling has no pick: the first model, as ever.
    const settled = await inJob(() => lb.chat(ask, { book: 'b', settle: 2 }));
    assert.equal(settled.rung.model, 'test/first');
    // Marking again is the first model's alone, unless the stage has a pick.
    const top = new Balancer(PRIMARY, { waitForTopS: Infinity, strikesToFall: Infinity, maxTries: 3 });
    const redo = await inJob(() => top.chat(ask, { book: 'b', part: 1, round: 1 }));
    assert.equal(redo.rung.model, 'test/first');
  } finally {
    Object.assign(control, { stages: {}, stagesFor: {} });
    globalThis.fetch = inner;
  }
});

test('settings from before NVIDIA’s list keep working: Kimi K3 is retired, so its pick moves to Kimi K2.6', () => {
  assert.deepEqual(
    { first: adminStateOf({ marker: { first: 'kimi-k3' } }).marker.first, second: adminStateOf({ marker: { first: 'kimi-k3' } }).marker.second },
    { first: 'moonshotai/kimi-k2.6', second: 'nvidia/nemotron-3-ultra-550b-a55b' },
  );
  assert.equal(adminStateOf({ marker: { first: 'nemotron', paused: true } }).marker.second, 'moonshotai/kimi-k2.6');
  assert.equal(adminStateOf({ marker: { first: 'nemotron', paused: true } }).marker.paused, true);
  assert.deepEqual(adminStateOf({ stages: { 'marks.mark': { provider: 'gemini' }, bogus: { provider: 'nim' } } }).stages, { 'marks.mark': { provider: 'gemini' } });
  assert.equal(nimAlias('moonshotai/kimi-k2.6'), 'nim-moonshotai--kimi-k2.6');
});
