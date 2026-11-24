import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { log } from '../log.ts';

/*
 * How much this machine has sent to the internet this month, for a server on GCP's free e2-micro,
 * whose free egress is small (ADR 0004). It reads the network card's own count of bytes sent
 * (/proc/net/dev; the container shares the machine's network), so the tunnel, WARP and the feed to
 * other copies all count, not only answers. The count starts again when the machine does, so the
 * month's total is kept in a file (EGRESS_FILE) and grows by each difference. Near the owner's
 * limit (GCP_EGRESS_LIMIT_MB), /health says so and the app stops choosing this server.
 */

const MB = 1024 * 1024;

export interface EgressCount {
  /** The month counted, as 2026-11. */
  month: string;
  /** Bytes sent this month. */
  bytes: number;
  /** The card's own count when last read. */
  raw: number;
}

export const monthOf = (now: number) => new Date(now).toISOString().slice(0, 7);

/** Bytes a network card has sent, from /proc/net/dev's text; null when it isn't listed. */
export function sentBy(procNetDev: string, card: string): number | null {
  for (const line of procNetDev.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    if (line.slice(0, colon).trim() !== card) continue;
    const fields = line.slice(colon + 1).trim().split(/\s+/);
    // Received: 8 fields, then sent: bytes first.
    const sent = Number(fields[8]);
    if (!Number.isFinite(sent)) return null;
    return sent;
  }
  return null;
}

/**
 * The month's count after reading the card's count `raw`. A count lower than the last means the
 * machine started again, and all of it is new. With nothing kept, all of it counts too: more is
 * safer than less.
 */
export function advance(kept: EgressCount | null, raw: number, month: string): EgressCount {
  if (!kept) return { month, bytes: raw, raw };
  let added = raw;
  if (raw >= kept.raw) added = raw - kept.raw;
  let bytes = kept.bytes + added;
  if (kept.month !== month) bytes = added;
  return { month, bytes, raw };
}

/** The month's count kept in `file`, or null when there's none or it's unreadable. */
export async function readCount(file: string): Promise<EgressCount | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const v = JSON.parse(text) as Partial<EgressCount>;
    if (typeof v.month !== 'string' || typeof v.bytes !== 'number' || typeof v.raw !== 'number') return null;
    return { month: v.month, bytes: v.bytes, raw: v.raw };
  } catch {
    return null;
  }
}

async function writeCount(file: string, count: EgressCount) {
  await mkdir(dirname(file), { recursive: true });
  const part = `${file}.part`;
  await writeFile(part, JSON.stringify(count));
  await rename(part, file);
}

export interface EgressOptions {
  file: string;
  card: string;
  limitMb: number;
  /** /proc/net/dev's text; tests give their own. */
  read?: () => Promise<string>;
  now?: () => number;
}

export function makeEgress(opts: EgressOptions) {
  const read = opts.read ?? (() => readFile('/proc/net/dev', 'utf8'));
  const now = opts.now ?? Date.now;
  let count: EgressCount | null = null;
  let loaded = false;

  /** Megabytes sent this month, as far as counted. */
  function usedMb(): number {
    if (!count || count.month !== monthOf(now())) return 0;
    return Math.round((count.bytes / MB) * 10) / 10;
  }

  return {
    limitMb: opts.limitMb,

    /** Reads the card's count and keeps the month's total. */
    async tick() {
      if (!loaded) {
        count = await readCount(opts.file);
        loaded = true;
      }
      const raw = sentBy(await read(), opts.card);
      if (raw === null) {
        log.warn({ card: opts.card }, 'the network card to count egress on isn’t listed in /proc/net/dev');
        return;
      }
      count = advance(count, raw, monthOf(now()));
      await writeCount(opts.file, count);
    },

    usedMb,

    /** At or past the owner's limit: the app should choose another server. */
    near(): boolean {
      return usedMb() >= opts.limitMb;
    },
  };
}

export type Egress = ReturnType<typeof makeEgress>;

/** Whether the count in `file` is at or past `limitMb` this month (the standby reads the API's count). */
export async function nearIn(file: string, limitMb: number, now = Date.now()): Promise<boolean> {
  const count = await readCount(file);
  if (!count || count.month !== monthOf(now)) return false;
  return count.bytes / MB >= limitMb;
}
