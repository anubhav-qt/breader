import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Archive } from '../src/lib/archive.ts';
import { archiveTo, Memo, MemoryStore } from '../src/lib/cache.ts';
import { Disk } from '../src/manga/disk.ts';

const HOUR = 3_600_000;
const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, n, n, n]);
const until = async (ok: () => Promise<boolean>) => {
  for (let i = 0; i < 100 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 10));
};

let dir: string;
let archive: Archive;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'archive-'));
  archive = new Archive(join(dir, 'archive'), 64 * 1024 * 1024);
  archiveTo(archive);
});
afterEach(async () => {
  archiveTo(null);
  await rm(dir, { recursive: true, force: true });
});

describe('the archive', () => {
  it('keeps every answer, and gives it when the site stops answering', async () => {
    const memo = new Memo<{ title: string }>(new MemoryStore(10), 'anilist:v1:card', HOUR);
    expect(await memo.get('30656', async () => ({ title: 'Vagabond' }))).toEqual({ title: 'Vagabond' });
    await until(async () => (await archive.find('anilist:v1:card', '30656')) !== undefined);

    // A new server, its memory empty, with AniList down.
    const after = new Memo<{ title: string }>(new MemoryStore(10), 'anilist:v1:card', HOUR);
    const down = async (): Promise<{ title: string }> => {
      throw new Error('AniList is down');
    };
    expect(await after.get('30656', down)).toEqual({ title: 'Vagabond' });
    await expect(after.get('1', down)).rejects.toThrow('AniList is down');
  });

  it('leaves out answers that go stale in minutes', async () => {
    const memo = new Memo<string>(new MemoryStore(10), 'manga:v1:home', 60_000);
    await memo.get('c1', async () => 'https://uploads.example/at-home');
    await new Promise((r) => setTimeout(r, 50));
    expect(await archive.find('manga:v1:home', 'c1')).toBeUndefined();
  });

  it('keeps every page fetched, and puts back a page the cache let go', async () => {
    const cache = new Disk(join(dir, 'cache'), 1024 * 1024, undefined, archive.pages);
    await cache.keep('page:c1:d:0', async () => ({ data: png(1), type: 'image/png' }));
    await until(() => archive.pages.has('page:c1:d:0'));

    const fresh = new Disk(join(dir, 'cache2'), 1024 * 1024, undefined, archive.pages);
    let asked = 0;
    const pic = await fresh.keep('page:c1:d:0', async () => {
      asked++;
      return { data: png(2), type: 'image/png' };
    });
    expect(asked).toBe(0);
    expect([...pic.data]).toEqual([...png(1)]);
    expect(await fresh.has('page:c1:d:0')).toBe(true);
  });
});
