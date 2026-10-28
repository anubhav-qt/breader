import { describe, expect, it } from 'vitest';
import { holdLease } from '../src/jobs/lease.ts';
import { primary } from './helpers.ts';

describe('worker lease', () => {
  it('goes to one machine at a time, and to another once it lapses', async () => {
    await primary.pool.query('DELETE FROM worker_lease');
    expect(await holdLease(primary.pool, 'laptop')).toBe(true);
    expect(await holdLease(primary.pool, 'second')).toBe(false);
    expect(await holdLease(primary.pool, 'laptop')).toBe(true);
    await primary.pool.query(`UPDATE worker_lease SET until = now() - interval '1 second'`);
    expect(await holdLease(primary.pool, 'second')).toBe(true);
    expect(await holdLease(primary.pool, 'laptop')).toBe(false);
  });
});
