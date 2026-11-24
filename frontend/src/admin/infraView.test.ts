import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Infra, ServerSeen } from '@breader/shared/infra';
import { infraNeeds, infraView, PLACES } from './infraView';
import type { Status } from './types';

/* The infra map: what each box and line shows, and what of it needs the owner. */

const NOW = new Date('2026-11-24T12:00:00Z');
const at = (s: number) => new Date(NOW.getTime() + s * 1000).toISOString();

const up = (more: Partial<ServerSeen> = {}): ServerSeen => ({ state: 'up', release: 'abc1234def', heardAt: at(-10), startedAt: at(-3600), ...more });

function calm(): Infra {
  return {
    at: at(0),
    servers: { home: up(), gcp: up({ egress: { usedMb: 10, limitMb: 800 } }), azure: { state: 'asleep', release: 'abc1234def', heardAt: at(-86400) } },
    copies: [
      { name: 'laptop', where: 'home', behind: 0 },
      { name: 'gcp-copy', where: 'gcp', behind: 5 },
    ],
    r2: { bytes: 1e9, limitBytes: 9e9, writes: 1000, writeLimit: 900_000 },
    watcher: { lastAsked: at(-30), missed: 0 },
    modal: { up: false, done: 0 },
  };
}

const status = (role: 'laptop' | 'fallback' = 'laptop') =>
  ({
    server: { role, release: 'abc', uptimeSeconds: 7200, sentry: false },
    supabase: { bytes: 100e6, freeBytes: 500e6, timeline: null },
    feed: { rows: 12, unread: 0, oldest_unread: null, ack: 1 },
  }) as unknown as Status;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('a calm day', () => {
  it('has a view of every box, and needs nothing', () => {
    const view = infraView(calm(), status());
    for (const p of PLACES) expect(view.nodes[p.key]).toBeDefined();
    expect(infraNeeds(calm())).toEqual([]);
  });

  it('draws home’s and GCP’s lines moving, and Azure’s still', () => {
    const { live } = infraView(calm(), status());
    expect(live.has('app-home')).toBe(true);
    expect(live.has('home-homeDb')).toBe(true);
    expect(live.has('app-gcp')).toBe(true);
    expect(live.has('app-azure')).toBe(false);
    expect(live.has('azure-modal')).toBe(false);
  });

  it('shows Azure asleep and Modal on call', () => {
    const { nodes } = infraView(calm(), status());
    expect(nodes.azure).toMatchObject({ state: 'asleep', now: 'Asleep', bad: false });
    expect(nodes.modal).toMatchObject({ state: 'asleep', now: 'On call' });
  });

  it('shows a copy that has every change as caught up', () => {
    const { nodes } = infraView(calm(), status());
    expect(nodes.homeDb).toMatchObject({ state: 'up', now: 'Caught up', bad: false });
    expect(nodes.gcpDb).toMatchObject({ state: 'up', now: '5 s behind' });
  });
});

describe('the ThinkPad', () => {
  it('says how long it has been up only on the ThinkPad itself', () => {
    expect(infraView(calm(), status('laptop')).nodes.home.facts.map(([k]) => k)).toContain('Up for');
    expect(infraView(calm(), status('fallback')).nodes.home.facts.map(([k]) => k)).not.toContain('Up for');
  });

  it('is away when down, and that comes first in what needs you', () => {
    const infra = calm();
    infra.servers.home = { state: 'down', release: 'abc1234def', heardAt: at(-14 * 60) };
    const { nodes, live } = infraView(infra, status('fallback'));
    expect(nodes.home).toMatchObject({ state: 'down', bad: true });
    expect(nodes.home.now).toBe('Away for 14 min');
    expect(live.has('app-home')).toBe(false);
    expect(infraNeeds(infra)[0]).toEqual({ key: 'infra-home', text: 'ThinkPad away for 14 min' });
  });

  it('is quiet when no ThinkPad ever said how it is', () => {
    const infra = calm();
    infra.servers.home = null;
    expect(infraView(infra, status()).nodes.home).toMatchObject({ state: 'quiet', now: 'Not heard from' });
    expect(infraNeeds(infra)).toEqual([]);
  });

  it('shows its engines', () => {
    const infra = calm();
    infra.servers.home = up({ engine: { up: 1, workers: 4, busy: 2, waiting: 3 } });
    expect(infraView(infra, status()).nodes.home.now).toBe('Up · 2 of 4 busy');
  });
});

describe('Azure and Modal', () => {
  it('is awake for so long, its lines moving, and Modal reading aloud', () => {
    const infra = calm();
    infra.servers.azure = up({ startedAt: at(-4 * 60) });
    infra.modal = { up: true, done: 6 };
    const { nodes, live } = infraView(infra, status());
    expect(nodes.azure.now).toBe('Awake for 4 min');
    expect(nodes.modal).toMatchObject({ state: 'up', facts: [['Jobs done since Azure woke', '6']] });
    expect(live.has('watcher-azure')).toBe(true);
    expect(live.has('azure-modal')).toBe(true);
  });

  it('woken but not answering needs you', () => {
    const infra = calm();
    infra.servers.azure = { state: 'down', release: 'abc1234def', heardAt: at(-3600) };
    expect(infraView(infra, status()).nodes.azure).toMatchObject({ state: 'down', bad: true });
    expect(infraNeeds(infra).map((n) => n.key)).toContain('infra-azure');
  });

  it('shows Modal as on call while Azure is up without it', () => {
    const infra = calm();
    infra.servers.azure = up();
    expect(infraView(infra, status()).nodes.modal.state).toBe('asleep');
  });

  it('shows neither as set up when they aren’t', () => {
    const infra = calm();
    infra.servers.azure = null;
    infra.modal = null;
    const { nodes } = infraView(infra, status());
    expect(nodes.azure.state).toBe('quiet');
    expect(nodes.modal.state).toBe('quiet');
  });
});

describe('GCP', () => {
  it('near its egress limit needs you, with a meter', () => {
    const infra = calm();
    infra.servers.gcp = up({ state: 'busy', egress: { usedMb: 742, limitMb: 800 } });
    const { gcp } = infraView(infra, status()).nodes;
    expect(gcp).toMatchObject({ now: 'Near its egress limit', bad: true });
    expect(Math.round(gcp.meter!.value)).toBe(93);
    expect(infraNeeds(infra).map((n) => n.key)).toEqual(['infra-egress']);
  });

  it('shows no meter for a zero limit, and doesn’t divide by it', () => {
    const infra = calm();
    infra.servers.gcp = up({ egress: { usedMb: 5, limitMb: 0 } });
    expect(infraView(infra, status()).nodes.gcp.meter?.value).toBe(0);
  });
});

describe('the read copies', () => {
  it('a copy far behind needs you, the ThinkPad’s left to the status', () => {
    const infra = calm();
    infra.copies = [
      { name: 'laptop', where: 'home', behind: 900 },
      { name: 'gcp-copy', where: 'gcp', behind: 214 },
      { name: 'odd', where: 'other', behind: null },
    ];
    const needs = infraNeeds(infra);
    expect(needs).toContainEqual({ key: 'infra-copy-gcp-copy', text: 'GCP copy 4 min behind' });
    expect(needs).toContainEqual({ key: 'infra-copy-odd', text: 'Read copy odd never caught up' });
    expect(needs.map((n) => n.key)).not.toContain('infra-copy-laptop');
  });

  it('shows no copy when there is none', () => {
    const infra = calm();
    infra.copies = [];
    const { nodes, live } = infraView(infra, status());
    expect(nodes.homeDb).toMatchObject({ state: 'quiet', now: 'No copy' });
    expect(live.has('feed-homeDb')).toBe(false);
  });
});

describe('the watcher', () => {
  it('counts home’s misses', () => {
    const infra = calm();
    infra.watcher = { lastAsked: at(-20), missed: 4 };
    expect(infraView(infra, status()).nodes.watcher).toMatchObject({ state: 'busy', now: 'Home missed 4 min' });
  });

  it('has stopped when home answers and hasn’t heard it', () => {
    const infra = calm();
    infra.watcher = { lastAsked: at(-600), missed: 0 };
    expect(infraView(infra, status()).nodes.watcher).toMatchObject({ state: 'down', bad: true });
    expect(infraNeeds(infra).map((n) => n.key)).toContain('infra-watcher');
  });

  it('says nothing of itself while home is away and nobody can hear it', () => {
    const infra = calm();
    infra.servers.home = { state: 'down', release: null, heardAt: at(-600) };
    infra.watcher = { lastAsked: at(-600), missed: 0 };
    expect(infraView(infra, status()).nodes.watcher).toMatchObject({ state: 'quiet', bad: false });
    expect(infraNeeds(infra).map((n) => n.key)).not.toContain('infra-watcher');
  });
});

describe('R2', () => {
  it('near either free limit needs you', () => {
    const infra = calm();
    infra.r2 = { bytes: 1e9, limitBytes: 9e9, writes: 850_000, writeLimit: 900_000 };
    expect(infraView(infra, status()).nodes.r2.bad).toBe(true);
    expect(infraNeeds(infra).map((n) => n.key)).toEqual(['infra-r2']);
  });

  it('with no write limit counts its writes alone', () => {
    const infra = calm();
    infra.r2 = { bytes: 1e9, limitBytes: 9e9, writes: 5_000_000, writeLimit: null };
    const { r2 } = infraView(infra, status()).nodes;
    expect(r2.bad).toBe(false);
    expect(r2.facts).toContainEqual(['Writes this month', '5,000,000']);
  });

  it('is off when not in the pool', () => {
    const infra = calm();
    infra.r2 = null;
    expect(infraView(infra, status()).nodes.r2).toMatchObject({ state: 'quiet', now: 'Off' });
  });
});
