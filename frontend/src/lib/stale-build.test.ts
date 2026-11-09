import { describe, expect, it, vi } from 'vitest';
import { reloadOnce } from './stale-build';

/* A page from before a release reloads onto the new one, once a minute at most. */

function store(start: Record<string, string> = {}) {
  const m = new Map(Object.entries(start));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
}

describe('reloading onto a new build', () => {
  it('reloads the first time a file is missing', () => {
    const reload = vi.fn();
    expect(reloadOnce(store(), 1_000_000, reload)).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('shows the error instead within a minute of the last reload', () => {
    const s = store();
    const reload = vi.fn();
    reloadOnce(s, 1_000_000, reload);
    expect(reloadOnce(s, 1_000_000 + 59_000, reload)).toBe(false);
    expect(reloadOnce(s, 1_000_000 + 61_000, reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('reloads after a clock set back, and never where nothing can be remembered', () => {
    const reload = vi.fn();
    expect(reloadOnce(store({ 'breader.reloaded-at': '5000000' }), 1_000_000, reload)).toBe(true);
    const blocked = { getItem: () => null, setItem: () => { throw new Error('blocked'); } };
    expect(reloadOnce(blocked, 1_000_000, reload)).toBe(false);
    expect(reload).toHaveBeenCalledOnce();
  });
});
