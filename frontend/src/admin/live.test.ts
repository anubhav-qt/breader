import { describe, expect, it, vi } from 'vitest';
import type { Infra } from '@breader/shared/infra';
import type { Snapshot } from './types';

/* What the page keeps of each snapshot the server sends. In Node, with a page address of its own. */

vi.stubGlobal('location', { protocol: 'http:', hostname: 'localhost' });
const { snapshotOf } = await import('./live');

const status = { server: { role: 'laptop', release: 'abc', uptimeSeconds: 1, sentry: false } } as unknown as Snapshot['status'];

const infra: Infra = {
  at: '2026-11-24T12:00:00Z',
  servers: { home: null, gcp: null, azure: null },
  copies: [],
  r2: null,
  watcher: null,
  modal: null,
};

describe('a snapshot from the server', () => {
  it('keeps the infra map’s report', () => {
    expect(snapshotOf({ status, marker: null, accounts: null, infra }).infra).toEqual(infra);
  });

  it('has no infra from an older server that sends none', () => {
    expect(snapshotOf({ status, marker: null, accounts: null }).infra).toBeNull();
  });
});
