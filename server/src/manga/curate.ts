import type pg from 'pg';
import { MANGA_KINDS, type MangaFound, type MangaKind, type MangaSort } from '@breader/shared';
import type { Gemini } from '../lib/gemini.ts';
import { log } from '../log.ts';

/*
 * Browse's tabs (Popular, Updated, Top rated) hold what their sites list, which isn't always what
 * the tab says: a scanlator's recruitment post, a placeholder, a fan work in a list of real
 * series, explicit series in a list without 18+, a series of another kind. Each list is shown as
 * it's fetched; behind it, Gemini (thinking medium) looks at the cards it hasn't seen in that tab
 * and says which don't belong. Those are left out of the tab from then on, on either server
 * (rec_checks, in Supabase), and each card is looked at once per tab. A search by name shows
 * whatever it finds: only the tabs are checked.
 */

/** Cards one call looks at. */
const PER_CALL = 60;
const CALL_TIMEOUT = 120_000;
/** Checks kept in memory, by tab and card. */
const MOST_KEPT = 100_000;
/** A card not looked at yet in a tab is looked up again after this. */
const UNKNOWN_FOR = 2 * 60_000;

/** A Browse tab, as a search without a name asks for it. */
export interface Tab {
  sort: MangaSort;
  lang: string;
  kinds: MangaKind[];
  adult: boolean;
  adultOnly: boolean;
  doujinshi: boolean;
}

export interface Curate {
  /** The tab's cards without those Gemini said don't belong, and the ones it hasn't seen asked about behind. */
  check(tab: Tab, items: MangaFound[]): Promise<MangaFound[]>;
  /** Only what's known already, from memory, at once: for what a list shows before its lot's whole. */
  known(tab: Tab, items: MangaFound[]): MangaFound[];
}

/** Where the checks are kept. */
export interface Checks {
  /** Each of these cards looked at in the tab, and whether it's left out. */
  get(tab: string, cards: string[]): Promise<Map<string, boolean>>;
  put(tab: string, rows: Array<{ card: string; hide: boolean; why: string }>, by: string): Promise<void>;
}

export function tabKey(t: Tab): string {
  let age = 'safe';
  if (t.adultOnly) age = 'only18';
  else if (t.adult) age = '18';
  return [t.sort, t.lang, [...t.kinds].sort().join('+'), age, t.doujinshi ? 'dj' : 'nodj'].join(':');
}

export function pgChecks(pool: pg.Pool): Checks {
  return {
    async get(tab, cards) {
      const { rows } = await pool.query<{ card: string; hide: boolean }>('SELECT card, hide FROM rec_checks WHERE tab = $1 AND card = ANY($2::text[])', [tab, cards]);
      return new Map(rows.map((r) => [r.card, r.hide]));
    },
    async put(tab, rows, by) {
      for (const r of rows) {
        await pool.query(
          `INSERT INTO rec_checks (tab, card, hide, why, by) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tab, card) DO UPDATE SET hide = excluded.hide, why = excluded.why, by = excluded.by, at = now()`,
          [tab, r.card, r.hide, r.why, by],
        );
      }
    },
  };
}

const SORTS: Record<MangaSort, string> = {
  popular: 'Popular: the series most read right now',
  latest: 'Updated: series with new chapters lately',
  new: 'New: series added lately',
  rated: 'Top rated: the best rated series',
  relevance: 'Relevance',
};

/** What Gemini is told about the tab. */
function about(t: Tab): string {
  const kinds = t.kinds.length === MANGA_KINDS.length ? 'every kind (manga, manhwa, manhua, comics)' : `only ${t.kinds.join(', ')}`;
  let age = 'no 18+ series (no explicit sexual content)';
  if (t.adultOnly) age = '18+ series only';
  else if (t.adult) age = '18+ series allowed';
  const dj = t.doujinshi ? 'doujinshi and anthologies allowed' : 'no doujinshi, fan works or anthologies';
  return `Tab: ${SORTS[t.sort]}. Shows ${kinds}; ${age}; ${dj}. Language: ${t.lang}.`;
}

const SYSTEM = `You check the cards in one tab of a manga reading app's Browse page, which lists what manga sites list. Readers judge the app by these tabs, so a card that plainly doesn't belong is a bad recommendation.
Say a card doesn't belong only when it clearly:
- isn't a series: a site's announcement, recruitment or donation post, a placeholder, a test entry, a garbled or broken title;
- breaks the tab's rules: a kind it doesn't show, explicit sexual content where 18+ isn't allowed, a doujinshi, fan work or anthology where they aren't allowed;
- doesn't fit the tab at all: in Popular or Top rated, a low-effort or spam entry no one would call popular or well rated.
A series you don't recognise still belongs. When unsure, it belongs.
Answer JSON only: {"out": [{"i": 0, "why": "a few words"}]}, listing only the cards that don't belong.`;

/** Gemini's cards that don't belong, checked: indices in range, each once, with a short why. */
export function checkedOut(answer: unknown, size: number): Map<number, string> {
  const raw = (answer as { out?: unknown })?.out;
  const out = new Map<number, string>();
  if (!Array.isArray(raw)) return out;
  for (const x of raw) {
    const i = (x as { i?: unknown })?.i;
    if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= size) continue;
    const why = (x as { why?: unknown }).why;
    out.set(i, typeof why === 'string' ? why.slice(0, 200) : '');
  }
  return out;
}

export function makeCurate(o: { checks: Checks; gemini: Gemini | null }): Curate {
  const kept = new Map<string, boolean>();
  const unknownUntil = new Map<string, number>();
  /** Cards being looked at, by tab and card. */
  const looking = new Set<string>();

  const at = (tab: string, card: string) => `${tab}|${card}`;
  function keep(key: string, hide: boolean) {
    kept.delete(key);
    kept.set(key, hide);
    unknownUntil.delete(key);
    while (kept.size > MOST_KEPT) kept.delete(kept.keys().next().value!);
  }

  /** Asks Gemini about these cards in the tab, a lot at a time, and keeps what it says. */
  async function look(t: Tab, tab: string, cards: MangaFound[]) {
    for (let i = 0; i < cards.length; i += PER_CALL) {
      const lot = cards.slice(i, i + PER_CALL);
      const shown = lot.map((f, n) => ({
        i: n,
        title: f.card.title,
        site: f.source,
        kind: f.card.kind,
        status: f.card.status,
        year: 'year' in f.card ? f.card.year : null,
        rating: 'rating' in f.card ? f.card.rating : f.card.adult ? 'adult' : null,
        side: f.card.side,
        people: f.people.slice(0, 3),
      }));
      try {
        const answer = await o.gemini!.json<unknown>(SYSTEM, `${about(t)}\n${JSON.stringify(shown)}`, { timeout: CALL_TIMEOUT, thinking: 'medium' });
        const out = checkedOut(answer, lot.length);
        const rows = lot.map((f, n) => ({ card: f.card.id, hide: out.has(n), why: out.get(n) ?? '' }));
        await o.checks.put(tab, rows, o.gemini!.model('medium'));
        for (const r of rows) keep(at(tab, r.card), r.hide);
        if (out.size) log.info({ tab, out: [...out].map(([n, why]) => `${lot[n].card.title}: ${why}`) }, 'Gemini left cards out of a Browse tab');
      } catch (err) {
        log.warn({ err, tab }, 'Gemini couldn’t check a Browse tab’s cards, so they’re shown as fetched');
      } finally {
        for (const f of lot) looking.delete(at(tab, f.card.id));
      }
    }
  }

  return {
    known(t, items) {
      const tab = tabKey(t);
      return items.filter((f) => kept.get(at(tab, f.card.id)) !== true);
    },

    async check(t, items) {
      const tab = tabKey(t);
      const now = Date.now();
      const ask: string[] = [];
      for (const f of items) {
        const key = at(tab, f.card.id);
        if (!kept.has(key) && (unknownUntil.get(key) ?? 0) < now) ask.push(f.card.id);
      }
      if (ask.length) {
        try {
          const found = await o.checks.get(tab, [...new Set(ask)]);
          for (const card of ask) {
            const hide = found.get(card);
            if (hide === undefined) unknownUntil.set(at(tab, card), now + UNKNOWN_FOR);
            else keep(at(tab, card), hide);
          }
        } catch (err) {
          log.warn({ err }, 'Browse’s checks couldn’t be read, so the tab is shown as fetched');
        }
      }
      // What Gemini hasn't seen in this tab is looked at behind the reader, once.
      if (o.gemini) {
        const fresh: MangaFound[] = [];
        for (const f of items) {
          const key = at(tab, f.card.id);
          if (kept.has(key) || looking.has(key)) continue;
          looking.add(key);
          fresh.push(f);
        }
        if (fresh.length) void look(t, tab, fresh);
      }
      return items.filter((f) => kept.get(at(tab, f.card.id)) !== true);
    },
  };
}
