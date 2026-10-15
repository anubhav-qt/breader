import type pg from 'pg';
import type { PagePanels } from '@breader/shared';
import { log } from '../log.ts';

/*
 * Manga pages' panels kept for every reader (page_panels), so a page whose panels anyone has had is
 * a lookup for everyone after, with no seat and no model: found on the laptop for a reader with a
 * seat, or found on a reader's own device and sent. A device's are kept once another library's
 * device sends the same, as two devices agreeing is the same model having read the same page, while
 * one alone could say anything; the owner's are kept at once. Until then they wait in
 * page_panel_offers.
 *
 * Readers asking for the same page at once share one lookup, and one run of the model, whose
 * answer is kept for them all. The last few thousand pages are kept in memory too.
 */

/** Who vouches for a page's panels. */
export type By = 'server' | 'owner' | 'agreed';
type Data = Omit<PagePanels, 'round'>;

export interface Kept {
  /** Page n of a chapter's panels, kept by anyone; null where nobody's are yet. */
  get(chapter: string, n: number): Promise<PagePanels | null>;
  /** A chapter's kept pages' panels, by page. */
  chapter(chapter: string): Promise<Record<number, PagePanels>>;
  /**
   * The page's panels: kept already from `round` or later, or else found by `find` and kept, once
   * however many readers ask at once.
   */
  find(chapter: string, n: number, round: number, find: () => Promise<PagePanels>): Promise<PagePanels>;
  /** A device's panels for the page, from `libraryId`, the owner's or not; true once they're kept. */
  offer(chapter: string, n: number, libraryId: string, owner: boolean, p: PagePanels): Promise<boolean>;
}

/** Pages kept in memory, a few hundred bytes each. */
const MEMO = 5000;
/** How alike two devices' panels must be: every one's box overlapping its match by this much. */
const AGREE = 0.9;

/** Whole pixels and three places of sureness: as good as found, and half the size. */
function dataOf(p: PagePanels): Data {
  return {
    w: p.w,
    h: p.h,
    panels: p.panels.map((q) => q.map(([x, y]) => [Math.round(x), Math.round(y)] as [number, number])),
    sure: p.sure.map((s) => Math.round(s * 1000) / 1000),
  };
}

/** A panel's box as shares of its page, so either size of a page compares with the other. */
function boxOf(q: Array<[number, number]>, w: number, h: number) {
  const xs = q.map((c) => c[0] / w);
  const ys = q.map((c) => c[1] / h);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function overlap(a: number[], b: number[]) {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const both = w * h;
  const either = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - both;
  return either > 0 ? both / either : 0;
}

/** Two findings of a page say the same: as many panels, in the same order, each where the other's is. */
export function alike(a: Data, b: Data): boolean {
  return a.panels.length === b.panels.length && a.panels.every((q, i) => overlap(boxOf(q, a.w, a.h), boxOf(b.panels[i], b.w, b.h)) >= AGREE);
}

export function makeKept(pool: pg.Pool): Kept {
  const memo = new Map<string, PagePanels>();
  const looking = new Map<string, Promise<PagePanels | null>>();
  const finding = new Map<string, Promise<PagePanels>>();
  const keyOf = (chapter: string, n: number) => `${chapter}:${n}`;

  function remember(key: string, p: PagePanels) {
    memo.delete(key);
    memo.set(key, p);
    if (memo.size > MEMO) memo.delete(memo.keys().next().value!);
  }

  /** Shared by whoever asks for the same page while it's going. */
  function once<T>(going: Map<string, Promise<T>>, key: string, fn: () => Promise<T>): Promise<T> {
    let p = going.get(key);
    if (p) return p;
    p = fn();
    going.set(key, p);
    const done = () => going.delete(key);
    p.then(done, done);
    return p;
  }

  function get(chapter: string, n: number): Promise<PagePanels | null> {
    const key = keyOf(chapter, n);
    const had = memo.get(key);
    if (had) {
      remember(key, had);
      return Promise.resolve(had);
    }
    return once(looking, key, async () => {
      const { rows } = await pool.query<{ round: number; data: Data }>('SELECT round, data FROM page_panels WHERE chapter = $1 AND n = $2', [chapter, n]);
      if (!rows[0]) return null;
      const p = { round: rows[0].round, ...rows[0].data };
      remember(key, p);
      return p;
    });
  }

  /** Keeps the page's panels for everyone, unless they're kept from this round or a later one already. */
  async function save(chapter: string, n: number, p: PagePanels, by: By) {
    const r = await pool.query(
      `INSERT INTO page_panels (chapter, n, round, data, by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (chapter, n) DO UPDATE SET round = EXCLUDED.round, data = EXCLUDED.data, by = EXCLUDED.by, at = now()
       WHERE page_panels.round < EXCLUDED.round`,
      [chapter, n, p.round, JSON.stringify(dataOf(p)), by],
    );
    if (r.rowCount) remember(keyOf(chapter, n), { round: p.round, ...dataOf(p) });
  }

  return {
    get,
    async chapter(chapter) {
      const { rows } = await pool.query<{ n: number; round: number; data: Data }>('SELECT n, round, data FROM page_panels WHERE chapter = $1', [chapter]);
      return Object.fromEntries(rows.map((r) => [r.n, { round: r.round, ...r.data }]));
    },
    find(chapter, n, round, find) {
      return once(finding, keyOf(chapter, n), async () => {
        const had = await get(chapter, n);
        if (had && had.round >= round) return had;
        const found = await find();
        // The reader has them whether or not they could be kept just now.
        remember(keyOf(chapter, n), { ...found, ...dataOf(found) });
        await save(chapter, n, found, 'server').catch((err: unknown) => log.warn({ err, chapter, n }, 'couldn’t keep a page’s panels'));
        return found;
      });
    },
    async offer(chapter, n, libraryId, owner, p) {
      const had = await get(chapter, n);
      if (had && had.round >= p.round) return true;
      if (owner) {
        await save(chapter, n, p, 'owner');
        return true;
      }
      const data = dataOf(p);
      await pool.query(
        `INSERT INTO page_panel_offers (chapter, n, library_id, round, data) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (chapter, n, library_id) DO UPDATE SET round = EXCLUDED.round, data = EXCLUDED.data, at = now()`,
        [chapter, n, libraryId, p.round, JSON.stringify(data)],
      );
      const { rows } = await pool.query<{ data: Data }>(
        'SELECT data FROM page_panel_offers WHERE chapter = $1 AND n = $2 AND round = $3 AND library_id <> $4',
        [chapter, n, p.round, libraryId],
      );
      if (!rows.some((r) => alike(r.data, data))) return false;
      await save(chapter, n, p, 'agreed');
      await pool.query('DELETE FROM page_panel_offers WHERE chapter = $1 AND n = $2 AND round <= $3', [chapter, n, p.round]);
      return true;
    },
  };
}
