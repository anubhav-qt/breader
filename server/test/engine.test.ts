import { describe, expect, it } from 'vitest';
import { Scheduler, type Host, type Job, type Kind, type Model, type Payload, type Runner } from '../src/engine/scheduler.ts';
import { coresOf, sizeOf } from '../src/engine/serve.ts';
import { bytesOf, floats, frame, unframe } from '../src/engine/wire.ts';

/*
 * The engine's scheduler (ADR 0002), with a fake runner: each job it's given waits until the test
 * lets it finish, so the test sees which job went where, and in what order.
 */

interface Ran {
  host: number;
  slot: number;
  name: string;
  drop: string[];
  finish: (r?: unknown) => void;
  fail: (e: Error) => void;
}

function fakeRunner() {
  const ran: Ran[] = [];
  const stopped: Array<[number, number]> = [];
  const runner: Runner = {
    run(host, slot, payload: Payload, drop) {
      return new Promise((resolve, reject) => {
        ran.push({ host, slot, name: payload.ask as string, drop, finish: (r) => resolve(r ?? payload.ask), fail: reject });
      });
    },
    stop(host, slot) {
      stopped.push([host, slot]);
    },
  };
  return { runner, ran, stopped };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const KOKORO: Model = { key: 'kokoro', mb: 750 };
const PIPER: Model = { key: 'piper:a', mb: 250 };
const PANELS: Model = { key: 'panels', mb: 500 };

function host(workers: number, more: Partial<Host> = {}): Host {
  return { workers, budgetMb: 10_000, lowMb: 100, freeMb: 5_000, boot: 'one', ...more };
}

function setup(o: { hosts?: Host[]; now?: () => number; liveHoldMs?: number; idleMs?: number; mostLive?: number } = {}) {
  const f = fakeRunner();
  const lows: Array<[number, boolean]> = [];
  const s = new Scheduler(f.runner, {
    hosts: (o.hosts ?? [host(1)]).length,
    now: o.now,
    liveHoldMs: o.liveHoldMs ?? 0,
    idleMs: o.idleMs,
    mostLive: o.mostLive,
    onLow: (h, low) => lows.push([h, low]),
  });
  for (const [h, info] of (o.hosts ?? [host(1)]).entries()) s.host(h, info);
  const job = (kind: Kind, name: string, more: Partial<Job> = {}) => {
    const p = s.run({ kind, who: '', model: null, body: () => ({ ask: name }), ...more });
    p.catch(() => {});
    return p;
  };
  return { s, ...f, job, lows };
}

/** Lets the one job running finish, and waits for the next to start. */
async function next(ran: Ran[]) {
  const before = ran.length;
  ran[before - 1].finish();
  await tick();
  return ran.slice(before).map((r) => r.name);
}

describe('the engine’s scheduler', () => {
  it('runs live reading first, then panels, then audiobooks', async () => {
    const { ran, job } = setup();
    void job('book', 'first book');
    await tick();
    void job('book', 'book');
    void job('panel', 'panel');
    void job('live', 'live');
    expect(ran.map((r) => r.name)).toEqual(['first book']);
    expect(await next(ran)).toEqual(['live']);
    expect(await next(ran)).toEqual(['panel']);
    expect(await next(ran)).toEqual(['book']);
  });

  it('gives each reader a turn, a job each', async () => {
    const { ran, job } = setup();
    void job('panel', 'busy', { who: 'x' });
    await tick();
    for (const n of [1, 2, 3]) void job('panel', `a${n}`, { who: 'a' });
    void job('panel', 'b1', { who: 'b' });
    void job('panel', 'c1', { who: 'c' });
    const order = [];
    for (let i = 0; i < 5; i++) order.push(...(await next(ran)));
    expect(order).toEqual(['a1', 'b1', 'c1', 'a2', 'a3']);
  });

  it('puts a reader who just came before one who just had a turn', async () => {
    const { ran, job } = setup();
    // a's first is running, its others waiting, when b comes.
    for (const n of [1, 2, 3]) void job('panel', `a${n}`, { who: 'a' });
    await tick();
    void job('panel', 'b1', { who: 'b' });
    void job('panel', 'b2', { who: 'b' });
    const order = ['a1'];
    for (let i = 0; i < 4; i++) order.push(...(await next(ran)));
    expect(order).toEqual(['a1', 'b1', 'a2', 'b2', 'a3']);
  });

  it('remembers a reader’s turn while their line is empty for a moment', async () => {
    const { ran, job } = setup();
    void job('book', 'a1', { who: 'a' });
    await tick();
    void job('book', 'b1', { who: 'b' });
    void job('book', 'b2', { who: 'b' });
    // a's next comes only after a1 is done, as a book's next paragraph does: b still goes first.
    ran[0].finish();
    void job('book', 'a2', { who: 'a' });
    await tick();
    const order = ['a1', ...ran.slice(1).map((r) => r.name)];
    for (let i = 0; i < 2; i++) order.push(...(await next(ran)));
    expect(order).toEqual(['a1', 'b1', 'a2', 'b2']);
  });

  it('gives a library’s books turns inside its own', async () => {
    const { ran, job } = setup();
    void job('book', 'busy', { who: 'x' });
    await tick();
    // Library a: two books of three sentences each. Library b: one book of one.
    for (const n of [1, 2, 3]) void job('book', `a-one-${n}`, { who: 'a', sub: 'one' });
    for (const n of [1, 2, 3]) void job('book', `a-two-${n}`, { who: 'a', sub: 'two' });
    void job('book', 'b-one-1', { who: 'b', sub: 'one' });
    const order = [];
    for (let i = 0; i < 7; i++) order.push(...(await next(ran)));
    expect(order).toEqual(['a-one-1', 'b-one-1', 'a-two-1', 'a-one-2', 'a-two-2', 'a-one-3', 'a-two-3']);
  });

  it('runs what finishes a paragraph before its book’s other sentences', async () => {
    const { ran, job } = setup();
    void job('book', 'busy', { who: 'x' });
    await tick();
    for (const n of [1, 2, 3]) void job('book', `s${n}`, { who: 'a', sub: 'one' });
    void job('book', 'mp3-1', { who: 'a', sub: 'one', soon: true });
    void job('book', 'mp3-2', { who: 'a', sub: 'one', soon: true });
    void job('book', 'other', { who: 'a', sub: 'two' });
    const order = [];
    for (let i = 0; i < 6; i++) order.push(...(await next(ran)));
    expect(order).toEqual(['mp3-1', 'other', 'mp3-2', 's1', 's2', 's3']);
  });

  it('turns away what a book has waiting when asked, and only that', async () => {
    const { s, ran, job } = setup();
    void job('book', 'busy', { who: 'x' });
    await tick();
    const one = [1, 2].map((n) => job('book', `one-${n}`, { who: 'a', sub: 'one' }));
    void job('book', 'two-1', { who: 'a', sub: 'two' });
    s.drop('book', 'a', 'one');
    s.drop('book', 'nobody', 'one');
    for (const p of one) await expect(p).rejects.toMatchObject({ dropped: true });
    expect(s.waiting('book', 'a')).toBe(1);
    expect(await next(ran)).toEqual(['two-1']);
  });

  it('reads a reader’s live sentences one at a time, in order', async () => {
    const { ran, job } = setup({ hosts: [host(3)] });
    for (const n of [1, 2, 3]) void job('live', `a${n}`, { who: 'a' });
    void job('live', 'b1', { who: 'b' });
    await tick();
    expect(ran.map((r) => r.name)).toEqual(['a1', 'b1']);
    ran[0].finish();
    await tick();
    expect(ran.map((r) => r.name)).toEqual(['a1', 'b1', 'a2']);
  });

  it('leaves a worker for live reading, and more while anyone reads aloud', async () => {
    let t = 1_000;
    const { ran, job } = setup({ hosts: [host(4, { besideLive: 1 })], now: () => t, liveHoldMs: 60_000 });
    // No one reading: other work takes all but one worker.
    for (const n of [1, 2, 3, 4]) void job('book', `book${n}`, { who: `l${n}` });
    await tick();
    expect(ran.map((r) => r.name)).toEqual(['book1', 'book2', 'book3']);
    // A reader's first sentence starts at once, on the one left.
    void job('live', 'a1', { who: 'a' });
    await tick();
    expect(ran.at(-1)!.name).toBe('a1');
    // While they read, other work gets one worker: as books finish, no more start till one is left.
    for (const r of ran) if (r.name !== 'book3') r.finish();
    await tick();
    expect(ran.length).toBe(4);
    for (const n of [5, 6]) void job('book', `book${n}`, { who: `l${n}` });
    await tick();
    expect(ran.length).toBe(4);
    ran.find((r) => r.name === 'book3')!.finish();
    await tick();
    expect(ran.slice(4).map((r) => r.name)).toEqual(['book4']);
    // More readers find workers at once.
    for (const who of ['b', 'c', 'd']) void job('live', `${who}1`, { who });
    await tick();
    expect(ran.slice(5).map((r) => r.name)).toEqual(['b1', 'c1', 'd1']);
    // A minute after the last sentence, no one's reading: all but one again.
    for (const r of ran.slice(5)) r.finish();
    await tick();
    t += 60_000;
    ran[4].finish();
    await tick();
    expect(ran.slice(8).map((r) => r.name)).toEqual(['book5', 'book6']);
  });

  it('finds panels while anyone reads aloud, though audiobooks wait', async () => {
    const { s, ran, job } = setup({ hosts: [host(3, { besideLive: 0 })], liveHoldMs: 60_000 });
    void job('live', 'a1', { who: 'a' });
    await tick();
    ran[0].finish();
    void job('book', 'book1');
    void job('panel', 'p1', { who: 'x' });
    void job('panel', 'p2', { who: 'y' });
    void job('panel', 'p3', { who: 'z' });
    await tick();
    // Two panels: one worker is still left for live reading.
    expect(ran.slice(1).map((r) => r.name)).toEqual(['p1', 'p2']);
    for (const r of ran.slice(1)) r.finish();
    await tick();
    expect(ran.at(-1)!.name).toBe('p3');
    ran.at(-1)!.finish();
    await tick();
    // The book waits for the reader to stop.
    expect(ran.length).toBe(4);
    expect(s.waiting('book')).toBe(1);
  });

  it('never gives other work every worker, however it’s set, and shares a lone one', async () => {
    const one = setup({ hosts: [host(3, { besideLive: 10 })], liveHoldMs: 60_000 });
    void one.job('live', 'a1', { who: 'a' });
    await tick();
    one.ran[0].finish();
    for (const n of [1, 2, 3]) void one.job('book', `book${n}`, { who: `l${n}` });
    await tick();
    expect(one.ran.slice(1).map((r) => r.name)).toEqual(['book1', 'book2']);
    // One worker: a book still runs between a reader's sentences.
    const lone = setup({ hosts: [host(1, { besideLive: 0 })], liveHoldMs: 60_000 });
    void lone.job('live', 'a1', { who: 'a' });
    void lone.job('book', 'book1');
    await tick();
    expect(await next(lone.ran)).toEqual(['book1']);
  });

  it('puts other work on the workers that read live longest ago', async () => {
    let now = 1_000;
    const { ran, job } = setup({ hosts: [host(3)], now: () => now, liveHoldMs: 60_000 });
    void job('book', 'book', { model: PANELS });
    void job('live', 'live', { model: KOKORO });
    await tick();
    const liveSlot = ran[1].slot;
    now += 10;
    ran[1].finish();
    ran[0].finish();
    await tick();
    void job('book', 'b1', { model: PIPER });
    void job('book', 'b2', { model: PIPER });
    await tick();
    expect(ran.slice(2).map((r) => r.slot)).not.toContain(liveSlot);
  });

  it('sends a job to the worker already holding its model', async () => {
    const { ran, job } = setup({ hosts: [host(3)] });
    void job('live', 'k1', { model: KOKORO, who: 'a' });
    void job('live', 'p1', { model: PIPER, who: 'b' });
    await tick();
    const kSlot = ran[0].slot;
    ran[0].finish();
    ran[1].finish();
    await tick();
    void job('book', 'k2', { model: KOKORO });
    await tick();
    expect(ran[2].slot).toBe(kSlot);
  });

  it('keeps the models held under the budget, letting go of the one used longest ago', async () => {
    let now = 0;
    const { ran, job, s } = setup({ hosts: [host(2, { budgetMb: 1_100 })], now: () => now });
    void job('live', 'k', { model: KOKORO });
    await tick();
    now = 10;
    ran[0].finish();
    await tick();
    now = 20;
    void job('live', 'p', { model: PIPER });
    await tick();
    // Kokoro and Piper fit (1000 of 1100). Panels don't, until Kokoro goes.
    now = 30;
    ran[1].finish();
    await tick();
    void job('panel', 'panels', { model: PANELS });
    await tick();
    const last = ran.at(-1)!;
    expect(last.name).toBe('panels');
    expect(last.drop).toEqual(['kokoro']);
    expect(s.stats().engines[0].heldMb).toBeLessThanOrEqual(1_100);
  });

  it('waits when no free worker has room, rather than going over', async () => {
    const { ran, job, s } = setup({ hosts: [host(2, { budgetMb: 1_000 })] });
    void job('live', 'k', { model: KOKORO });
    await tick();
    // Kokoro's worker is busy; the other has nothing to let go of, and panels would make 1250.
    void job('panel', 'panels', { model: PANELS });
    await tick();
    expect(ran.map((r) => r.name)).toEqual(['k']);
    expect(s.waiting('panel')).toBe(1);
    ran[0].finish();
    await tick();
    expect(ran.at(-1)!.name).toBe('panels');
    expect(ran.at(-1)!.drop).toEqual(['kokoro']);
  });

  it('runs a model bigger than the budget on its own', async () => {
    const { ran, job } = setup({ hosts: [host(1, { budgetMb: 300 })] });
    void job('live', 'k', { model: KOKORO });
    await tick();
    expect(ran.map((r) => r.name)).toEqual(['k']);
  });

  it('starts only live reading when short of memory, turns panels away, and stops free workers', async () => {
    const plenty = host(2, { lowMb: 1_000 });
    const short = host(2, { lowMb: 1_000, freeMb: 500 });
    const { ran, job, s, stopped, lows } = setup({ hosts: [plenty] });
    // Both workers busy: a live sentence and a book's.
    void job('live', 'live 1');
    void job('book', 'book 1');
    await tick();
    const panel = job('panel', 'waiting panel');
    const book = job('book', 'waiting book');
    s.host(0, short);
    expect(lows).toEqual([[0, true]]);
    await expect(panel).rejects.toMatchObject({ busy: true });
    await expect(job('panel', 'new panel')).rejects.toMatchObject({ busy: true });
    // The book's worker comes free: no book starts on it, and it's let go.
    ran[1].finish();
    await tick();
    expect(ran.map((r) => r.name)).toEqual(['live 1', 'book 1']);
    s.host(0, short);
    expect(stopped).toEqual([[0, ran[1].slot]]);
    // Live reading still runs.
    void job('live', 'live while short', { who: 'another reader' });
    await tick();
    expect(ran.at(-1)!.name).toBe('live while short');
    ran.at(-1)!.finish();
    ran[0].finish();
    await tick();
    expect(s.waiting('book')).toBe(1);
    // Memory again: the book goes on.
    s.host(0, plenty);
    expect(lows).toEqual([[0, true], [0, false]]);
    await tick();
    expect(ran.at(-1)!.name).toBe('waiting book');
    ran.at(-1)!.finish();
    await expect(book).resolves.toBe('waiting book');
  });

  it('keeps a worker that read live lately when short of memory, for a minute', async () => {
    let t = 1_000;
    const plenty = host(2, { lowMb: 1_000 });
    const short = host(2, { lowMb: 1_000, freeMb: 500 });
    const { ran, job, s, stopped } = setup({ hosts: [plenty], now: () => t, liveHoldMs: 60_000 });
    void job('book', 'book');
    void job('live', 'live', { who: 'a' });
    await tick();
    const [bookSlot, liveSlot] = [ran[0].slot, ran[1].slot];
    for (const r of ran) r.finish();
    await tick();
    s.host(0, short);
    expect(stopped).toEqual([[0, bookSlot]]);
    t += 60_000;
    s.tick();
    expect(stopped).toEqual([[0, bookSlot], [0, liveSlot]]);
  });

  it('turns live reading and panels away with no engine up, and holds audiobooks till one is', async () => {
    const f = fakeRunner();
    const s = new Scheduler(f.runner, { hosts: 1, liveHoldMs: 0 });
    await expect(s.run({ kind: 'live', who: '', model: null, body: () => ({ ask: 'l' }) })).rejects.toMatchObject({ off: true });
    await expect(s.run({ kind: 'panel', who: '', model: null, body: () => ({ ask: 'p' }) })).rejects.toMatchObject({ off: true });
    const book = s.run({ kind: 'book', who: '', model: null, body: () => ({ ask: 'b' }) });
    await tick();
    expect(f.ran.length).toBe(0);
    s.host(0, host(1));
    await tick();
    expect(f.ran.map((r) => r.name)).toEqual(['b']);
    f.ran[0].finish();
    await expect(book).resolves.toBe('b');
  });

  it('turns away live reading and panels waiting when the last engine goes', async () => {
    const { s, job } = setup();
    void job('book', 'busy');
    await tick();
    const live = job('live', 'live');
    const book = job('book', 'book');
    s.host(0, null);
    await expect(live).rejects.toMatchObject({ off: true });
    expect(s.waiting('book')).toBe(1);
    void book;
  });

  it('turns live reading away past its most waiting', async () => {
    const { job } = setup({ mostLive: 2 });
    void job('live', 'running');
    await tick();
    void job('live', 'w1');
    void job('live', 'w2');
    await expect(job('live', 'w3')).rejects.toMatchObject({ busy: true });
  });

  it('forgets what a worker held when it stops, or its engine starts again', async () => {
    const { ran, job, s } = setup({ hosts: [host(1)] });
    void job('live', 'k', { model: KOKORO });
    await tick();
    ran[0].fail(Object.assign(new Error('gone'), { stopped: true }));
    await tick();
    expect(s.stats().engines[0].models).toEqual([[]]);
    void job('live', 'k2', { model: KOKORO });
    await tick();
    ran[1].finish();
    await tick();
    expect(s.stats().engines[0].models).toEqual([['kokoro']]);
    s.host(0, host(1, { boot: 'two' }));
    expect(s.stats().engines[0].models).toEqual([[]]);
  });

  it('lets a worker go after a quiet while', async () => {
    let now = 0;
    const { ran, job, s, stopped } = setup({ now: () => now, idleMs: 1_000 });
    void job('book', 'b');
    await tick();
    ran[0].finish();
    await tick();
    now = 999;
    s.tick();
    expect(stopped).toEqual([]);
    now = 1_000;
    s.tick();
    expect(stopped).toEqual([[0, 0]]);
    expect(s.stats().engines[0].started).toBe(0);
  });

  it('shares work across engines, each to its own budget', async () => {
    const { ran, job, s } = setup({ hosts: [host(1, { budgetMb: 800 }), host(1, { budgetMb: 800 })] });
    void job('book', 'one', { model: KOKORO });
    void job('book', 'two', { model: KOKORO });
    await tick();
    expect(ran.map((r) => r.host).sort()).toEqual([0, 1]);
    expect(s.stats().engines.map((e) => e.heldMb)).toEqual([750, 750]);
  });

  it('passes a job that fails back to whoever asked, and carries on', async () => {
    const { ran, job } = setup();
    const a = job('live', 'bad');
    const b = job('live', 'good');
    await tick();
    ran[0].fail(new Error('no'));
    await expect(a).rejects.toThrow('no');
    await tick();
    ran[1].finish();
    await expect(b).resolves.toBe('good');
  });
});

describe('the engine’s size', () => {
  it('reads physical cores, not threads', () => {
    const cpu = (phys: number, core: number) => `processor\t: 0\nphysical id\t: ${phys}\ncore id\t\t: ${core}\n`;
    const eight = Array.from({ length: 16 }, (_, i) => cpu(0, i % 8)).join('\n');
    expect(coresOf(eight)).toBe(8);
  });

  it('gives a worker of four threads for each two cores, half the memory, and audiobooks none while reading aloud', () => {
    expect(sizeOf({}, 8, 16_000)).toEqual({ workers: 4, threads: 4, budgetMb: 8_000, lowMb: 1_024, besideLive: 0 });
    expect(sizeOf({}, 2, 2_000)).toEqual({ workers: 1, threads: 2, budgetMb: 1_000, lowMb: 250, besideLive: 0 });
    expect(sizeOf({}, 1, 2_000)).toMatchObject({ workers: 1, threads: 1 });
    expect(sizeOf({ ENGINE_WORKERS: 5, ENGINE_THREADS: 1, ENGINE_MEMORY_MB: 3_000, ENGINE_LOW_MB: 10, ENGINE_BESIDE_LIVE: 2 }, 8, 16_000)).toEqual({ workers: 5, threads: 1, budgetMb: 3_000, lowMb: 10, besideLive: 2 });
  });
});

describe('the engine’s wire', () => {
  it('carries a header and bytes', () => {
    const f = frame({ a: 1, s: 'é' }, new Uint8Array([1, 2, 3]));
    const { head, bytes } = unframe<{ a: number; s: string }>(f);
    expect(head).toEqual({ a: 1, s: 'é' });
    expect([...bytes]).toEqual([1, 2, 3]);
  });

  it('turns away what isn’t a message', () => {
    expect(() => unframe(new Uint8Array([0, 0]))).toThrow();
    expect(() => unframe(new Uint8Array([0, 0, 0, 9, 1]))).toThrow();
  });

  it('reads sound however its bytes lie', () => {
    const audio = new Float32Array([0.5, -0.25, 1]);
    const f = frame({ x: 1 }, bytesOf(audio));
    const { bytes } = unframe(f);
    expect([...floats(bytes)]).toEqual([0.5, -0.25, 1]);
    const odd = new Uint8Array(13);
    odd.set(bytesOf(audio), 1);
    expect([...floats(odd.subarray(1))]).toEqual([0.5, -0.25, 1]);
    expect(() => floats(new Uint8Array(5))).toThrow();
  });
});
