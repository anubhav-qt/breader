import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { advance, makeEgress, nearIn, sentBy } from '../src/lib/egress.ts';

/* How much a GCP machine has sent this month, from its network card's own count. */

const MB = 1024 * 1024;
/** /proc/net/dev with `sent` bytes sent on ens4. */
const dev = (sent: number) => `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 5000      10    0    0    0     0          0         0     5000      10    0    0    0     0       0          0
  ens4: 999999    500    0    0    0     0          0         0 ${sent}      400    0    0    0     0       0          0
`;

describe('the network card’s count', () => {
  it('reads the bytes a card sent, and none for a card not listed', () => {
    expect(sentBy(dev(1234), 'ens4')).toBe(1234);
    expect(sentBy(dev(1234), 'lo')).toBe(5000);
    expect(sentBy(dev(1234), 'eth0')).toBeNull();
    expect(sentBy('', 'ens4')).toBeNull();
  });

  it('adds each difference, all of it after the machine starts again, and starts again each month', () => {
    let c = advance(null, 100, '2026-11');
    expect(c.bytes).toBe(100);
    c = advance(c, 250, '2026-11');
    expect(c.bytes).toBe(250);
    // Started again: the card counts from 0.
    c = advance(c, 40, '2026-11');
    expect(c.bytes).toBe(290);
    c = advance(c, 90, '2026-12');
    expect(c).toEqual({ month: '2026-12', bytes: 50, raw: 90 });
  });
});

describe('the month’s egress', () => {
  it('keeps its count in a file across starts, and says when it’s at the limit', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'breader-egress-')), 'egress.json');
    let sent = 300 * MB;
    const now = () => Date.UTC(2026, 10, 24);
    const first = makeEgress({ file, card: 'ens4', limitMb: 500, read: async () => dev(sent), now });
    await first.tick();
    expect(first.usedMb()).toBe(300);
    expect(first.near()).toBe(false);
    // The machine started again: the card counts from 0, the file remembers.
    sent = 200 * MB;
    const again = makeEgress({ file, card: 'ens4', limitMb: 500, read: async () => dev(sent), now });
    await again.tick();
    expect(again.usedMb()).toBe(500);
    expect(again.near()).toBe(true);
    expect(await nearIn(file, 500, now())).toBe(true);
    expect(await nearIn(file, 600, now())).toBe(false);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ month: '2026-11', bytes: 500 * MB, raw: 200 * MB });
  });

  it('counts nothing for a month it hasn’t read yet', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'breader-egress-')), 'egress.json');
    let at = Date.UTC(2026, 10, 30);
    const e = makeEgress({ file, card: 'ens4', limitMb: 1, read: async () => dev(2 * MB), now: () => at });
    await e.tick();
    expect(e.near()).toBe(true);
    at = Date.UTC(2026, 11, 1);
    expect(e.usedMb()).toBe(0);
    expect(await nearIn(file, 1, at)).toBe(false);
  });

  it('leaves the count alone when the card isn’t listed', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'breader-egress-')), 'egress.json');
    const e = makeEgress({ file, card: 'eth9', limitMb: 1, read: async () => dev(2 * MB) });
    await e.tick();
    expect(e.usedMb()).toBe(0);
  });
});
