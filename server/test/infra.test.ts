import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeApp } from '../src/app.ts';
import { FRESH_S, infraFrom, readInfra, type SeenRow } from '../src/lib/infra.ts';
import { makeSeen, watchHeader, type SeenDetail } from '../src/lib/seen.ts';
import { deps, env, primary, registered } from './helpers.ts';

/*
 * The admin page's infra map: each API server says how it is (server_seen), and any server reads
 * every one back with the read copies' places and R2's use, so nobody wakes Azure to ask.
 */

const NOW = new Date('2026-11-24T12:00:00Z');
const HOME = 'laptop';
const STARTED = new Date('2026-11-21T12:00:00Z');

function row(machine: string, ageS: number, detail: SeenDetail = {}, role = 'fallback'): SeenRow {
  return { machine, role, release: 'abc1234', ageS, startedAt: STARTED, detail };
}

const homeRow = (ageS: number, detail: SeenDetail = {}) => row(HOME, ageS, detail, 'laptop');
const gcpRow = (ageS: number, detail: SeenDetail = {}) => row('gcp', ageS, { jsonOnly: true, ...detail });
const azureRow = (ageS: number, detail: SeenDetail = {}) => row('azure-sg', ageS, detail);
const watch = (agoS: number, missed: number) => ({ at: new Date(NOW.getTime() - agoS * 1000).toISOString(), missed });

const infraOf = (seen: SeenRow[], more: Partial<Parameters<typeof infraFrom>[0]> = {}) =>
  infraFrom({ home: HOME, now: NOW, seen, copies: [], r2: null, ...more });

describe('the watcher’s header', () => {
  it('reads a count of misses', () => {
    expect(watchHeader('0')).toBe(0);
    expect(watchHeader('14')).toBe(14);
    expect(watchHeader('44640')).toBe(44640);
  });

  it('takes nothing else', () => {
    for (const bad of [undefined, '', ' 3', '-1', '1.5', '1e3', 'abc', '44641', '9999999', '３']) {
      expect(watchHeader(bad)).toBeNull();
    }
  });
});

describe('which box a server is', () => {
  it('puts the ThinkPad, GCP and Azure each in their own', () => {
    const infra = infraOf([homeRow(5), gcpRow(5), azureRow(5)]);
    expect(infra.servers.home?.state).toBe('up');
    expect(infra.servers.gcp?.state).toBe('up');
    expect(infra.servers.azure?.state).toBe('up');
  });

  it('leaves a box empty when no server is in it', () => {
    expect(infraOf([]).servers).toEqual({ home: null, gcp: null, azure: null });
  });

  it('takes the newest when two servers say they are the same box', () => {
    const infra = infraOf([azureRow(400), { ...azureRow(5), machine: 'azure-new', release: 'new1234' }]);
    expect(infra.servers.azure?.release).toBe('new1234');
  });

  it('shows nothing of a server in no box', () => {
    const infra = infraOf([row('somewhere', 5, {}, 'laptop')]);
    expect(infra.servers).toEqual({ home: null, gcp: null, azure: null });
  });
});

describe('how a server is', () => {
  it('is up with what it said, when heard lately', () => {
    const engine = { up: 1, workers: 4, busy: 2, waiting: 3, done: 9 };
    const home = infraOf([homeRow(10, { engine })]).servers.home;
    expect(home).toEqual({
      state: 'up',
      release: 'abc1234',
      heardAt: '2026-11-24T11:59:50.000Z',
      startedAt: STARTED.toISOString(),
      engine: { up: 1, workers: 4, busy: 2, waiting: 3 },
    });
  });

  it('is busy while it says so, and keeps its egress', () => {
    const egress = { usedMb: 742, limitMb: 800 };
    const gcp = infraOf([gcpRow(10, { busy: true, egress })]).servers.gcp;
    expect(gcp?.state).toBe('busy');
    expect(gcp?.egress).toEqual(egress);
  });

  it('is down past the fresh window, with no start or engines', () => {
    const engine = { up: 1, workers: 4, busy: 0, waiting: 0, done: 0 };
    const home = infraOf([homeRow(FRESH_S + 1, { engine })]).servers.home;
    expect(home).toEqual({ state: 'down', release: 'abc1234', heardAt: new Date(NOW.getTime() - (FRESH_S + 1) * 1000).toISOString() });
    expect(infraOf([homeRow(FRESH_S)]).servers.home?.state).toBe('up');
  });

  it('gives a server that says how it is less often 3 of its own turns before it is down', () => {
    expect(infraOf([gcpRow(360, { everyS: 120 })]).servers.gcp?.state).toBe('up');
    expect(infraOf([gcpRow(361, { everyS: 120 })]).servers.gcp?.state).toBe('down');
    expect(infraOf([gcpRow(FRESH_S, { everyS: 10 })]).servers.gcp?.state).toBe('up');
    expect(infraOf([gcpRow(FRESH_S + 1, { everyS: 10 })]).servers.gcp?.state).toBe('down');
  });

  it('shows engines for the ThinkPad alone', () => {
    const engine = { up: 1, workers: 2, busy: 0, waiting: 0, done: 4 };
    expect(infraOf([azureRow(5, { engine })]).servers.azure?.engine).toBeUndefined();
  });
});

describe('Azure, the standby', () => {
  it('is asleep when quiet and nobody wants it', () => {
    expect(infraOf([homeRow(5), azureRow(3600)]).servers.azure?.state).toBe('asleep');
  });

  it('is down when quiet while the watcher has missed home 10 minutes', () => {
    const seen = [homeRow(5), azureRow(3600), gcpRow(5, { watch: watch(30, 10) })];
    expect(infraOf(seen).servers.azure?.state).toBe('down');
  });

  it('stays asleep when the watcher’s word of 10 misses is old', () => {
    const seen = [homeRow(5), azureRow(3600), gcpRow(5, { watch: watch(181, 10) })];
    expect(infraOf(seen).servers.azure?.state).toBe('asleep');
  });

  it('stays asleep under 10 misses', () => {
    const seen = [homeRow(400), azureRow(3600), gcpRow(5, { watch: watch(30, 9) })];
    expect(infraOf(seen).servers.azure?.state).toBe('asleep');
  });

  it('is down when home has been gone long enough that the watcher must have woken it', () => {
    expect(infraOf([homeRow(13 * 60 + 1), azureRow(3600)]).servers.azure?.state).toBe('down');
    expect(infraOf([homeRow(13 * 60), azureRow(3600)]).servers.azure?.state).toBe('asleep');
  });
});

describe('the watcher', () => {
  it('is its newest ask, heard by any server', () => {
    const seen = [homeRow(400, { watch: watch(400, 0) }), azureRow(5, { watch: watch(20, 12) })];
    expect(infraOf(seen).watcher).toEqual({ lastAsked: watch(20, 12).at, missed: 12 });
  });

  it('is nothing when no server heard it', () => {
    expect(infraOf([homeRow(5)]).watcher).toBeNull();
  });
});

describe('Modal', () => {
  it('is up while Azure is awake with an engine on it, with the jobs it did', () => {
    const engine = { up: 1, workers: 1, busy: 1, waiting: 0, done: 6 };
    expect(infraOf([azureRow(5, { engine })]).modal).toEqual({ up: true, done: 6 });
  });

  it('is on call while Azure sleeps, or has no engine up', () => {
    const engine = { up: 1, workers: 1, busy: 0, waiting: 0, done: 6 };
    expect(infraOf([azureRow(3600, { engine })]).modal).toEqual({ up: false, done: 0 });
    expect(infraOf([azureRow(5, { engine: { ...engine, up: 0 } })]).modal).toEqual({ up: false, done: 6 });
    expect(infraOf([azureRow(5)]).modal).toEqual({ up: false, done: 0 });
  });

  it('is nothing with no Azure', () => {
    expect(infraOf([homeRow(5)]).modal).toBeNull();
  });
});

describe('the read copies', () => {
  it('belong to the server that reads them, and say how far behind they are', () => {
    const seen = [homeRow(5, { copy: 'laptop' }), gcpRow(5, { copy: 'gcp-copy' })];
    const copies = [
      { name: 'laptop', ackAgeS: 2, oldestUnreadS: null },
      { name: 'gcp-copy', ackAgeS: 5, oldestUnreadS: 214 },
      { name: 'old-copy', ackAgeS: null, oldestUnreadS: 9000 },
    ];
    expect(infraOf(seen, { copies }).copies).toEqual([
      { name: 'laptop', where: 'home', behind: 0 },
      { name: 'gcp-copy', where: 'gcp', behind: 214 },
      { name: 'old-copy', where: 'other', behind: null },
    ]);
  });
});

describe('R2', () => {
  it('says its room and writes, or nothing when it isn’t in the pool', () => {
    const r2 = { budget: 9e9, writeLimit: 900_000, bytes: 3e9, writes: 1200 };
    expect(infraOf([], { r2 }).r2).toEqual({ bytes: 3e9, limitBytes: 9e9, writes: 1200, writeLimit: 900_000 });
    expect(infraOf([]).r2).toBeNull();
  });
});

describe('saying and reading back, in Supabase', () => {
  const MACHINES = ['infra-test-home', 'infra-test-gcp'];
  const COPY = 'infra-test-copy';

  const clean = async () => {
    await primary.pool.query('DELETE FROM server_seen WHERE machine = ANY($1)', [MACHINES]);
    await primary.pool.query('DELETE FROM feed_copies WHERE name = $1', [COPY]);
  };
  beforeEach(clean);
  afterAll(clean);

  const seenAs = (machine: string, more: Record<string, unknown> = {}) =>
    makeSeen({ env: { MACHINE: machine, ROLE: 'fallback', RELEASE: 'rel1234', JSON_ONLY: false, COPY_URL: undefined, COPY_NAME: undefined, SEEN_EVERY_S: 30, ...more }, pool: primary.pool });

  it('reads back what each server said', async () => {
    const home = makeSeen({
      env: { MACHINE: MACHINES[0], ROLE: 'laptop', RELEASE: 'rel1234', JSON_ONLY: false, COPY_URL: undefined, COPY_NAME: undefined, SEEN_EVERY_S: 30 },
      pool: primary.pool,
      mirror: {},
      busy: () => true,
    });
    const gcp = seenAs(MACHINES[1], { JSON_ONLY: true, COPY_URL: 'postgres://x@h/db', COPY_NAME: COPY, SEEN_EVERY_S: 120 });
    gcp.heardWatcher(3);
    await home.say();
    await gcp.say();
    await gcp.say();

    const infra = await readInfra(primary.pool, MACHINES[0], null);
    expect(infra.servers.home).toMatchObject({ state: 'busy', release: 'rel1234' });
    expect(infra.servers.gcp).toMatchObject({ state: 'up', release: 'rel1234' });
    expect(infra.watcher?.missed).toBe(3);
    const { rows } = await primary.pool.query<{ detail: SeenDetail }>('SELECT detail FROM server_seen WHERE machine = $1', [MACHINES[1]]);
    expect(rows[0].detail.everyS).toBe(120);
    expect(Math.abs(new Date(infra.at).getTime() - Date.now())).toBeLessThan(60_000);
  });

  const copyNow = async () => (await readInfra(primary.pool, MACHINES[0], null)).copies.find((c) => c.name === COPY);

  it('counts a copy behind by its oldest unread change', async () => {
    // A new library is a fed change (FED_TABLES), so change_log has one to leave unread.
    await registered();
    const { rows } = await primary.pool.query<{ txid: string; id: string; age: number }>(
      'SELECT txid::text, id::text, extract(epoch FROM now() - at)::int AS age FROM change_log ORDER BY txid DESC, id DESC LIMIT 1',
    );
    const last = rows[0];
    await primary.pool.query(`INSERT INTO feed_copies (name, ack_txid, ack_id, ack_at) VALUES ($1, $2, $3, now())`, [COPY, last.txid, last.id]);
    expect((await copyNow())?.behind).toBe(0);

    // One short of the newest: that one is all it hasn't read.
    await primary.pool.query(`UPDATE feed_copies SET ack_id = ack_id - 1 WHERE name = $1`, [COPY]);
    const behind = (await copyNow())?.behind ?? -1;
    expect(Math.abs(behind - last.age)).toBeLessThanOrEqual(1);

    await primary.pool.query(`UPDATE feed_copies SET ack_at = NULL WHERE name = $1`, [COPY]);
    expect((await copyNow())?.behind).toBeNull();
  });

  it('reads R2’s use from the pool’s tables', async () => {
    const infra = await readInfra(primary.pool, MACHINES[0], { name: 'infra-test-bucket', budget: 9e9, writes: 900_000 });
    expect(infra.r2).toEqual({ bytes: 0, limitBytes: 9e9, writes: 0, writeLimit: 900_000 });
  });
});

describe('the watcher’s ask in /health', () => {
  it('is noted by the server that hears it, and nothing else is', async () => {
    const heard: number[] = [];
    const app = makeApp({ ...deps, env: { ...env }, seen: { heardWatcher: (n: number) => heard.push(n) } });
    expect((await app.request('/health', { headers: { 'x-breader-watch': '12' } })).status).toBe(200);
    expect((await app.request('/health', { headers: { 'x-breader-watch': 'lots' } })).status).toBe(200);
    expect((await app.request('/health')).status).toBe(200);
    expect(heard).toEqual([12]);
  });
});
