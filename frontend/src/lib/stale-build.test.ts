import { describe, expect, it, vi } from 'vitest';
import { isFailedPiece, reloadOnce } from './stale-build';

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

describe('a piece of the app that couldn’t be fetched', () => {
  it('is known by what Safari, Chrome and Firefox say', () => {
    expect(isFailedPiece(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isFailedPiece(new TypeError('Failed to fetch dynamically imported module: https://breader.site/assets/epub-1.js'))).toBe(true);
    expect(isFailedPiece(new TypeError('error loading dynamically imported module: https://breader.site/assets/pdf-2.js'))).toBe(true);
  });

  it('is never another error, a string or nothing', () => {
    expect(isFailedPiece(new TypeError('Failed to fetch'))).toBe(false);
    expect(isFailedPiece(new Error('Couldn’t open this book.'))).toBe(false);
    expect(isFailedPiece('Importing a module script failed.')).toBe(false);
    expect(isFailedPiece(undefined)).toBe(false);
    expect(isFailedPiece(null)).toBe(false);
  });

  const failed = new TypeError('Importing a module script failed.');

  /** A fresh page: the module loaded anew, with this tab's storage and a reload to count. */
  async function page(start: Record<string, string> = {}) {
    const reload = vi.fn();
    vi.stubGlobal('window', { location: { reload } });
    vi.stubGlobal('sessionStorage', store(start));
    vi.resetModules();
    const { reloadsForPiece } = await import('./stale-build');
    return { reload, reloadsForPiece };
  }

  it('reloads the tab once, and every error after it waits for that reload', async () => {
    try {
      const { reload, reloadsForPiece } = await page();
      expect(reloadsForPiece(new Error('something else'))).toBe(false);
      expect(reloadsForPiece(failed)).toBe(true);
      expect(reloadsForPiece(failed)).toBe(true);
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('lets the error through on the next page, within a minute of the reload', async () => {
    try {
      const { reload, reloadsForPiece } = await page({ 'breader.reloaded-at': String(Date.now() - 1_000) });
      expect(reloadsForPiece(failed)).toBe(false);
      expect(reload).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
