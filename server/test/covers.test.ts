import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../src/lib/cache.ts';
import { Covers, webp } from '../src/manga/covers.ts';
import { Disk, type Picture } from '../src/manga/disk.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A clock the test moves. */
function clock(start = 1_000_000) {
  const t = { now: start };
  vi.spyOn(Date, 'now').mockImplementation(() => t.now);
  return t;
}

async function jpeg(width: number, height: number, background = 'red'): Promise<Picture> {
  return { data: await sharp({ create: { width, height, channels: 3, background } }).jpeg().toBuffer(), type: 'image/jpeg' };
}

const widthOf = async (pic: Picture) => (await sharp(pic.data).metadata()).width;

/** A site's cover, counted each time it's fetched; held, it waits for release(). */
function site() {
  const s = { n: 0, held: false, colour: 'red', release: () => {} };
  const original = async () => {
    s.n += 1;
    if (s.held) await new Promise<void>((done) => { s.release = done; });
    return jpeg(600, 852, s.colour);
  };
  return { s, original };
}

describe('covers', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'breader-covers-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('are made WebP no wider than asked, never wider than they came, and as they came when they can’t be', async () => {
    const big = await webp(await jpeg(1000, 1420), 512);
    expect(big.type).toBe('image/webp');
    expect(await widthOf(big)).toBe(512);
    expect(await widthOf(await webp(await jpeg(300, 426), 512))).toBe(300);
    const broken: Picture = { data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]), type: 'image/jpeg' };
    expect(await webp(broken, 256)).toBe(broken);
  });

  it('are fetched once for every width, and again once kept as long as their list says, the old one sent meanwhile', async () => {
    const t = clock();
    const covers = new Covers(new Disk(dir, 50_000_000), new MemoryStore(100));
    const { s, original } = site();
    await covers.listed('s', DAY);

    const small = await covers.get('k', 's', 256, original);
    expect(small.pic.type).toBe('image/webp');
    expect(await widthOf(small.pic)).toBe(256);
    expect(small.maxAge).toBe(DAY / 1000);
    const wide = await covers.get('k', 's', 512, original);
    expect(await widthOf(wide.pic)).toBe(512);
    expect(s.n).toBe(1);

    // A day on: the old one at once, asked after again soon, while the new one's fetched behind it.
    t.now += DAY;
    s.held = true;
    s.colour = 'blue';
    const stale = await covers.get('k', 's', 256, original);
    expect(stale.tag).toBe(small.tag);
    expect(stale.maxAge).toBe(60);
    await covers.get('k', 's', 512, original);
    expect(s.n).toBe(2);
    s.release();
    await vi.waitFor(async () => expect((await covers.get('k', 's', 256, original)).tag).not.toBe(small.tag));
    expect(s.n).toBe(2);
    const fresh = await covers.get('k', 's', 256, original);
    expect(fresh.maxAge).toBe(DAY / 1000);
  });

  it('are fetched again ahead of time, and waited for, by the prefetch; a series in no list keeps them a week', async () => {
    const t = clock();
    const covers = new Covers(new Disk(dir, 50_000_000), new MemoryStore(100));
    const { s, original } = site();
    const first = await covers.get('k', 's', 512, original);
    expect(first.maxAge).toBe((7 * DAY) / 1000);

    await covers.listed('s', 3 * DAY);
    t.now += 2 * DAY;
    // Due in a day: kept.
    expect((await covers.get('k', 's', 512, original, 6 * HOUR)).tag).toBe(first.tag);
    t.now += 20 * HOUR;
    // Due in four hours: fetched now, and this waits for it. The prefetch says the list each day.
    await covers.listed('s', 3 * DAY);
    const early = await covers.get('k', 's', 512, original, 6 * HOUR);
    expect(s.n).toBe(2);
    expect(early.tag).not.toBe(first.tag);
    expect(early.maxAge).toBe((3 * DAY) / 1000);
  });
});
