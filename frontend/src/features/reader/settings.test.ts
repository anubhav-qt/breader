import { beforeEach, describe, expect, it, vi } from 'vitest';

const saved = new Map<string, unknown>();
vi.mock('../../lib/store', () => ({
  readLocal: (k: string, fallback: unknown) => (saved.has(k) ? saved.get(k) : fallback),
  writeLocal: (k: string, v: unknown) => saved.set(k, v),
}));
vi.mock('../../data/sync', () => ({ record: () => {} }));

const KEY = 'breader.reader.v1';
const load = async () => {
  vi.resetModules();
  return import('./settings');
};

describe('manga direction', () => {
  beforeEach(() => saved.clear());

  it('reads a new manga left to right for a new reader', async () => {
    const { loadSettings, mangaLookOf } = await load();
    const s = loadSettings();
    expect(s.mangaDir).toBe('ltr');
    expect(mangaLookOf(s, 'new', false).dir).toBe('ltr');
  });

  it('moves a reader from before to left to right, and each manga keeps its own', async () => {
    saved.set(KEY, { v: 5, mangaDir: 'rtl', mangaOwn: { one: { dir: 'rtl', layout: 'pages' } } });
    const { loadSettings, mangaLookOf } = await load();
    const s = loadSettings();
    expect(s.mangaDir).toBe('ltr');
    expect(s.v).toBe(6);
    expect(mangaLookOf(s, 'one', false).dir).toBe('rtl');
    expect(mangaLookOf(s, 'two', false).dir).toBe('ltr');
  });

  it('keeps right to left once picked after the change', async () => {
    saved.set(KEY, { v: 6, mangaDir: 'rtl' });
    const { loadSettings } = await load();
    expect(loadSettings().mangaDir).toBe('rtl');
  });
});
