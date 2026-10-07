import { MANGA_PAGE } from '@breader/shared';

/*
 * How long each source takes over a lot it hasn't seen, so browsing (a list, not a search by name)
 * can leave out the slow ones: a lot waits for its slowest place (find.ts). Some sites let only so
 * many calls through, however they're asked. A lot answered mostly from what's kept says little
 * of its site, so lots are judged by the calls they made of it, as if they'd made every one.
 */

const HOUR = 3_600_000;
/** The calls a lot makes when its site has to be asked all of it: its list, then two for each series. */
const ALL_CALLS = 1 + 2 * MANGA_PAGE;
/** A lot that made fewer calls than this is left out. */
const FEWEST_CALLS = 8;
/** A source is judged by its last few lots... */
const LAST = 3;
/** ...from this long ago at most, so a slow one is tried again in time. */
const FORGET = 6 * HOUR;

interface Timed {
  /** How long the lot would have taken making every call. */
  ms: number;
  at: number;
}

export class Speeds {
  private lots = new Map<string, Timed[]>();

  /** A source's lot took this long, making this many calls of its site. */
  took(source: string, ms: number, calls: number, now = Date.now()): void {
    if (calls < FEWEST_CALLS) return;
    const kept = this.recent(source, now);
    kept.push({ ms: Math.round((ms * ALL_CALLS) / calls), at: now });
    this.lots.set(source, kept.slice(-LAST));
  }

  /** How long a lot it hasn't seen takes the source, as of late: the middle of its last few, the slower of two. Null when not known. */
  lotTime(source: string, now = Date.now()): number | null {
    const times = this.recent(source, now).map((t) => t.ms);
    if (times.length === 0) return null;
    times.sort((a, b) => a - b);
    return times[Math.floor(times.length / 2)];
  }

  /** Quick enough to browse: its lots come in time, or it hasn't been timed yet. */
  quick(source: string, within: number, now = Date.now()): boolean {
    const ms = this.lotTime(source, now);
    if (ms === null) return true;
    return ms <= within;
  }

  private recent(source: string, now: number): Timed[] {
    const all = this.lots.get(source) ?? [];
    return all.filter((t) => now - t.at < FORGET);
  }
}
