import { Hono } from 'hono';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.ts';
import { copyWill, lookUp, makeReads, MARGIN, onlyPrimary, STALE, WROTE, type Source } from '../src/db/reads.ts';

/** A stand-in database: its pool answers the copy's "how current" question as `at` says. */
function fake(name: string, at: () => Date | null | Error = () => null) {
  let asked = 0;
  const pool = {
    name,
    query: async () => {
      asked++;
      const v = at();
      if (v instanceof Error) throw v;
      return { rows: [{ at: v }] };
    },
  } as unknown as pg.Pool;
  const source: Source = { db: { name } as unknown as Db, pool };
  return { source, asked: () => asked };
}

/** What `pick` chose for a request carrying `cookie`. */
async function picked(reads: ReturnType<typeof makeReads>, cookie?: string): Promise<Source> {
  let out: Source | null = null;
  const app = new Hono();
  app.get('/', async (c) => {
    out = await reads.pick(c);
    return c.text('ok');
  });
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  await app.request('/', { headers });
  return out!;
}

describe('copyWill', () => {
  const now = 1_000_000_000;

  it('says no for a copy that never caught up', () => {
    expect(copyWill(now, null, null)).toBe(false);
  });

  it('says yes for a current copy and a reader who wrote nothing lately', () => {
    expect(copyWill(now, now - 1000, null)).toBe(true);
  });

  it('says no once the copy has been behind for longer than STALE', () => {
    expect(copyWill(now, now - STALE, null)).toBe(true);
    expect(copyWill(now, now - STALE - 1, null)).toBe(false);
  });

  it('says no until the copy has caught up past the reader’s last write, with the margin', () => {
    const wrote = now - 5000;
    expect(copyWill(now, wrote, wrote)).toBe(false);
    expect(copyWill(now, wrote + MARGIN, wrote)).toBe(false);
    expect(copyWill(now, wrote + MARGIN + 1, wrote)).toBe(true);
  });
});

describe('makeReads', () => {
  it('reads from the primary on a server with no copy', async () => {
    const primary = fake('primary');
    expect(await picked(makeReads(primary.source, null))).toBe(primary.source);
    expect(await picked(onlyPrimary(primary.source))).toBe(primary.source);
  });

  it('reads from a copy that is current', async () => {
    const primary = fake('primary');
    const copy = fake('copy', () => new Date());
    expect(await picked(makeReads(primary.source, copy.source))).toBe(copy.source);
  });

  it('reads from the primary while the copy never caught up', async () => {
    const primary = fake('primary');
    const copy = fake('copy', () => null);
    expect(await picked(makeReads(primary.source, copy.source))).toBe(primary.source);
  });

  it('reads from the primary when the copy can’t be asked', async () => {
    const primary = fake('primary');
    const copy = fake('copy', () => new Error('gone'));
    expect(await picked(makeReads(primary.source, copy.source))).toBe(primary.source);
  });

  it('sends a reader who just wrote to the primary, and others to the copy', async () => {
    const primary = fake('primary');
    const copy = fake('copy', () => new Date(Date.now() - 1000));
    const reads = makeReads(primary.source, copy.source);
    expect(await picked(reads, `${WROTE}=${Date.now()}`)).toBe(primary.source);
    expect(await picked(reads, `${WROTE}=${Date.now() - 60_000}`)).toBe(copy.source);
    expect(await picked(reads)).toBe(copy.source);
  });

  it('ignores a cookie that is not a time', async () => {
    const primary = fake('primary');
    const copy = fake('copy', () => new Date());
    const reads = makeReads(primary.source, copy.source);
    for (const bad of ['', 'abc', '-5', '0', '1e400', '12.5']) {
      expect(await picked(reads, `${WROTE}=${bad}`), bad).toBe(copy.source);
    }
  });

  it('asks the copy once for many requests at once, and not again for a while', async () => {
    const primary = fake('primary');
    const copy = fake('copy', () => new Date());
    const reads = makeReads(primary.source, copy.source);
    await Promise.all(Array.from({ length: 20 }, () => picked(reads)));
    await picked(reads);
    expect(copy.asked()).toBe(1);
  });
});

describe('lookUp', () => {
  it('takes what the copy has', async () => {
    const primary = fake('primary');
    const copy = fake('copy');
    const seen: Source[] = [];
    const found = await lookUp(copy.source, primary.source, async (from) => {
      seen.push(from);
      return 'there';
    });
    expect(found).toBe('there');
    expect(seen).toEqual([copy.source]);
  });

  it('asks the primary when the copy hasn’t it yet', async () => {
    const primary = fake('primary');
    const copy = fake('copy');
    const found = await lookUp(copy.source, primary.source, async (from) => {
      if (from === primary.source) return 'new';
      return undefined;
    });
    expect(found).toBe('new');
  });

  it('asks the primary only once when the request already reads from it', async () => {
    const primary = fake('primary');
    let asks = 0;
    const found = await lookUp(primary.source, primary.source, async () => {
      asks++;
      return undefined;
    });
    expect(found).toBeUndefined();
    expect(asks).toBe(1);
  });
});
