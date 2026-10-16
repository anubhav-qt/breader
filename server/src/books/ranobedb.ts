import { seriesName } from '@breader/shared';
import type { Store } from '../lib/cache.ts';
import { log } from '../log.ts';

/*
 * RanobeDB (ranobedb.org, free for non-commercial use), the light novels it knows: every series'
 * names, in English, romaji and its own script. A novel found on a site that goes by one of them is
 * a light novel, any other a web novel, and it goes by RanobeDB's other names too, so the same
 * novel under another name on another site is shown as one. Its whole list is read once a week, a
 * page every two seconds, and kept in the store; until it's first read, a novel's kind isn't known.
 */

const API = 'https://ranobedb.org/api/v0/series';
const PER_PAGE = 100;
/** Between its pages, as it's a small site run for free. */
const GAP = 2_000;
const DAY = 24 * 3_600_000;
/** How often its list is read again. */
const EVERY = 7 * DAY;
/** How long the list is kept: past a few missed reads. */
const KEPT = 30 * DAY;
const KEY = 'books:v1:ranobedb';
/** Names this short say too little to tell one novel from another ("Re"). */
const SHORTEST = 4;
/** Its pages at most, should it say more than it has. */
const MOST_PAGES = 2_000;

interface RawSeries {
  id: number;
  title: string | null;
  title_orig: string | null;
  romaji: string | null;
  romaji_orig: string | null;
}

interface RawPage {
  series: RawSeries[];
  totalPages: number;
}

/** The list as kept: when it was read, and each series' id and names. */
interface Kept {
  at: number;
  series: Array<[number, string[]]>;
}

export interface Ranobe {
  /** The RanobeDB series going by one of these names (seriesName keys), or null: none, or the list isn't read yet. */
  seriesOf(keys: string[]): number | null;
  /** A series' names. */
  namesOf(id: number): string[];
  /** Whether its list has been read, so a novel it doesn't know is a web novel. */
  ready(): boolean;
  /** Its list read again, when it's a week old or was never read (the books' warm). */
  refresh(signal?: AbortSignal): Promise<void>;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((done) => {
    const t = setTimeout(done, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); done(); }, { once: true });
  });

export function makeRanobe(opts: { store: Store; fetch?: typeof fetch; gap?: number }): Ranobe {
  const fetchFn = opts.fetch ?? fetch;
  const gap = opts.gap ?? GAP;
  let byKey = new Map<string, number>();
  let names = new Map<number, string[]>();
  let readAt = 0;
  let loaded = false;
  let reading: Promise<void> | null = null;

  function use(kept: Kept) {
    const keys = new Map<string, number>();
    const all = new Map<number, string[]>();
    for (const [id, titles] of kept.series) {
      all.set(id, titles);
      for (const t of titles) {
        const key = seriesName(t).key;
        if (key.length < SHORTEST) continue;
        if (!keys.has(key)) keys.set(key, id);
      }
    }
    byKey = keys;
    names = all;
    readAt = kept.at;
  }

  async function page(n: number): Promise<RawPage> {
    let last: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetchFn(`${API}?limit=${PER_PAGE}&page=${n}`, {
          headers: { accept: 'application/json', 'user-agent': 'Breader (https://breader.site)' },
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new Error(`RanobeDB answered ${res.status}`);
        return (await res.json()) as RawPage;
      } catch (err) {
        last = err;
        await sleep(gap * 5);
      }
    }
    throw last;
  }

  async function read(signal?: AbortSignal) {
    const series: Kept['series'] = [];
    let total = 1;
    for (let n = 1; n <= total && n <= MOST_PAGES; n++) {
      if (signal?.aborted) return;
      const p = await page(n);
      total = p.totalPages;
      for (const s of p.series) {
        const titles: string[] = [];
        for (const t of [s.title, s.romaji, s.title_orig, s.romaji_orig]) {
          if (t && !titles.includes(t)) titles.push(t);
        }
        if (titles.length > 0) series.push([s.id, titles]);
      }
      if (n < total) await sleep(gap, signal);
    }
    const kept: Kept = { at: Date.now(), series };
    use(kept);
    await opts.store.set(KEY, kept, KEPT);
    log.info({ series: series.length }, 'RanobeDB’s light novels read');
  }

  return {
    seriesOf(keys) {
      for (const k of keys) {
        const id = byKey.get(k);
        if (id !== undefined) return id;
      }
      return null;
    },

    namesOf(id) {
      return names.get(id) ?? [];
    },

    ready() {
      return readAt > 0;
    },

    refresh(signal) {
      if (reading) return reading;
      reading = (async () => {
        if (!loaded) {
          loaded = true;
          const kept = (await opts.store.get(KEY)) as Kept | undefined;
          if (kept?.series) use(kept);
        }
        if (Date.now() - readAt < EVERY) return;
        try {
          await read(signal);
        } catch (err) {
          log.warn({ err }, 'RanobeDB’s list couldn’t be read; the last one stays');
        }
      })().finally(() => {
        reading = null;
      });
      return reading;
    },
  };
}
