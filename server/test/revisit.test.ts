import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { retry, tidy } from '../src/lib/mistral.ts';
import { browser, deps, registered } from './helpers.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const text = () => `Mira walked to the old mill at Hollow End, where Tobin kept the quern. ${Math.random()}`;

const NOTES = {
  people: [{ name: 'Mira', aka: ['the girl'], who: 'A miller’s daughter.', did: 'Walks to the mill.' }, { name: '', who: 'nameless' }],
  places: [{ name: 'The old mill', about: 'Where Tobin works.' }],
  terms: [{ term: 'quern', meaning: 'A stone for grinding grain by hand.' }],
  extra: 'dropped',
};

/** Mistral, answering every part with `content`, once `hold` lets it. */
function mistral(content: unknown = NOTES, hold?: Promise<void>) {
  const calls: RequestInit[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    calls.push(init);
    await hold;
    return new Response(JSON.stringify({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return calls;
}

describe('revisit', () => {
  beforeEach(() => { deps.env.MISTRAL_API_KEY = 'test-key'; retry.waits = [0, 0]; });
  afterEach(() => { vi.unstubAllGlobals(); deps.env.MISTRAL_API_KEY = undefined; });

  it('reads a part in the background, once for everyone, and knows it by its hash after', async () => {
    let release = () => {};
    const calls = mistral(NOTES, new Promise<void>((r) => { release = r; }));
    const t = text();
    const { b } = await registered();
    const before = await b.post('/v1/revisit/known', { hashes: [sha(t)] });
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ known: {}, reading: [], failed: {}, on: true });

    const first = await b.post('/v1/revisit/part', { title: 'The Mill', text: t });
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ hash: sha(t) });
    expect((await b.post('/v1/revisit/known', { hashes: [sha(t)] })).body.reading).toEqual([sha(t)]);

    // Another reader sending the same words while they're read: still one read.
    const other = await registered();
    expect((await other.b.post('/v1/revisit/part', { title: 'The Mill', text: t })).status).toBe(202);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const sent = JSON.parse(String(calls[0].body));
    expect(sent.messages[1].content).toBe(`Chapter: The Mill\n\n${t}`);
    expect(sent.response_format).toEqual({ type: 'json_object' });

    release();
    const notes = {
      people: [{ name: 'Mira', aka: ['the girl'], who: 'A miller’s daughter.', did: 'Walks to the mill.' }],
      places: [{ name: 'The old mill', about: 'Where Tobin works.' }],
      terms: [{ term: 'quern', meaning: 'A stone for grinding grain by hand.' }],
    };
    await vi.waitFor(async () => {
      const known = await other.b.post('/v1/revisit/known', { hashes: [sha(t), sha('nothing')] });
      expect(known.body).toEqual({ known: { [sha(t)]: notes }, reading: [], failed: {}, on: true });
    });
    const again = await other.b.post('/v1/revisit/part', { title: 'The Mill', text: t });
    expect(again.status).toBe(200);
    expect(again.body.notes).toEqual(notes);
    expect(calls).toHaveLength(1);
  });

  it('says when a part couldn’t be read, and tries again when it’s sent again', async () => {
    const calls = mistral('not json at all');
    const t = text();
    const { b } = await registered();
    expect((await b.post('/v1/revisit/part', { title: '', text: t })).status).toBe(202);
    await vi.waitFor(async () => {
      const known = await b.post('/v1/revisit/known', { hashes: [sha(t)] });
      expect(known.body.failed[sha(t)]?.code).toBe('revisit_failed');
    });
    // Asked three times, then given up on.
    expect(calls).toHaveLength(3);

    mistral();
    expect((await b.post('/v1/revisit/part', { title: '', text: t })).status).toBe(202);
    await vi.waitFor(async () => {
      const known = await b.post('/v1/revisit/known', { hashes: [sha(t)] });
      expect(Object.keys(known.body.known)).toEqual([sha(t)]);
      expect(known.body.failed).toEqual({});
    });
  });

  it('says so when it isn’t set up', async () => {
    const { b } = await registered();
    deps.env.MISTRAL_API_KEY = undefined;
    const off = await b.post('/v1/revisit/part', { title: '', text: text() });
    expect(off.status).toBe(503);
    expect(off.body.code).toBe('revisit_off');
    expect((await b.post('/v1/revisit/known', { hashes: [] })).body.on).toBe(false);
  });

  it('is for libraries only', async () => {
    mistral();
    const res = await browser().post('/v1/revisit/part', { title: '', text: text() });
    expect(res.status).toBe(401);
  });
});

describe('revisit notes', () => {
  it('are put in the app’s own voice, whatever the model wrote', () => {
    const notes = tidy({
      people: [
        {
          name: 'the Silent Man (mentioned) ✨',
          aka: ['he', 'a quiet, shy man with a beard', 'their brother', 'The Silent Man', 'Silent One'],
          who: 'a **quiet** guest — who barely speaks 🙂',
          did: "drinks the host's wine and calls it 'fine' -- then leaves/goes home",
        },
        { name: 'Blank', aka: [], who: '', did: '' },
      ],
      places: [{ name: 'Richmond.', about: '# where the house is, 1890–1895' }],
      terms: [
        { term: 'the Silent Man', meaning: 'Him again.' },
        { term: 'peptone', meaning: 'Refers to "a food"... for the weak' },
      ],
    });
    expect(notes).toEqual({
      people: [{
        name: 'The Silent Man',
        aka: ['Silent One'],
        who: 'A quiet guest, who barely speaks.',
        did: 'Drinks the host’s wine and calls it ‘fine’, then leaves or goes home.',
      }],
      places: [{ name: 'Richmond', about: 'Where the house is, 1890–1895.' }],
      terms: [{ term: 'peptone', meaning: 'Refers to “a food”… for the weak.' }],
    });
  });
});
