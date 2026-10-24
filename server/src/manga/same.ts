import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { MangaFound } from '@breader/shared';
import type { Store } from '../lib/cache.ts';
import type { Gemini } from '../lib/gemini.ts';
import { log } from '../log.ts';

/*
 * Which series a search found are one series, where their names don't say: "Sousou no Frieren" on
 * one site and "Frieren: Beyond Journey's End" on another, a title in Korean and its English one.
 * Gemini looks at a lot's cards the first time they come together and groups the ones that are the
 * same work. Each group's key (a G and letters, which no title keys to, as seriesName's are in
 * small letters) goes among its cards' names, so Browse, a series' sheet and the prefetch show them
 * as one card as they do series of one name (shared sameSeries). Every card Gemini has looked at
 * is kept with its group in Supabase (series_matches), a card with no other copy as a group of its
 * own, so each is asked about once, on either server. A lot whose groups have been looked at
 * together before isn't asked about again (kept by its groups, in Redis).
 */

/** Cards kept in memory, by their id: their group's key. */
const MOST_KEPT = 50_000;
/** A card nobody has looked at yet is looked up again after this. */
const UNKNOWN_FOR = 2 * 60_000;
/** How long a lot's groups are remembered as looked at together. */
const LOOKED_FOR = 30 * 86_400_000;
/** The most cards one call looks at. */
const MOST_CARDS = 80;
/** How long a call may take, when nobody's waiting on it. */
const BEHIND = 60_000;
/** The other names a group goes by, kept this long. */
const WIDE_FOR = 10 * 60_000;

export interface Same {
  /**
   * The lot, each card with its group's key among its names. Cards not looked at yet, or not
   * together, are asked about first, for up to `wait`; the answer is kept either way, for next time.
   */
  settle(items: MangaFound[], wait: number): Promise<MangaFound[]>;
  /** Only what's known already, from memory, at once: for what a search shows before its lot's whole. */
  known(items: MangaFound[]): MangaFound[];
  /** These names and every other name their groups go by: a sheet looking for its series' other copies. */
  widen(names: string[]): Promise<string[]>;
}

/** Where the groups are kept. */
export interface Groups {
  /** The groups of those of these cards that have one. */
  get(cards: string[]): Promise<Map<string, string>>;
  /** Puts cards in groups, and the groups in `into` into theirs. */
  put(rows: Array<{ card: string; canon: string; names: string[] }>, into: Map<string, string>, by: string): Promise<void>;
  /** Every name of the groups going by one of these names, or with one of these keys. */
  names(names: string[]): Promise<string[]>;
}

/** A group's key, from its first card: a G, then 12 capitals and digits. */
export function groupKey(card: string): string {
  return `G${createHash('sha256').update(card).digest('hex').slice(0, 12).toUpperCase()}`;
}

const isGroupKey = (k: string) => /^G[0-9A-F]{12}$/.test(k);

/** The cards' groups, kept in Supabase. */
export function pgGroups(pool: pg.Pool): Groups {
  return {
    async get(cards) {
      const { rows } = await pool.query<{ card: string; canon: string }>('SELECT card, canon FROM series_matches WHERE card = ANY($1::text[])', [cards]);
      return new Map(rows.map((r) => [r.card, r.canon]));
    },
    async put(rows, into, by) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const [from, to] of into) await client.query('UPDATE series_matches SET canon = $2 WHERE canon = $1', [from, to]);
        for (const r of rows) {
          await client.query(
            `INSERT INTO series_matches (card, canon, names, by) VALUES ($1, $2, $3::text[], $4)
             ON CONFLICT (card) DO UPDATE SET canon = excluded.canon, names = excluded.names, by = excluded.by, at = now()`,
            [r.card, r.canon, r.names, by],
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async names(names) {
      const { rows } = await pool.query<{ name: string }>(
        `SELECT DISTINCT unnest(names) AS name FROM series_matches
          WHERE canon IN (SELECT canon FROM series_matches WHERE names && $1::text[] OR canon = ANY($1::text[]))
          LIMIT 200`,
        [names],
      );
      return rows.map((r) => r.name);
    },
  };
}

/** A card as Gemini is shown it. */
interface Shown {
  i: number;
  title: string;
  /** Its other names, keyed: letters and digits only. */
  names: string[];
  people: string[];
  kind: string | null;
  year: number | null;
  status: string | null;
  site: string;
  /** Its group, where it has one: those already in one group are the same series. */
  group?: string;
  side: boolean;
}

const SYSTEM = `You group search results from manga sites. Each line is one series as one site lists it.
Put cards in a group only when they are the same work: the same story by the same people, listed by another site, in another language or script, under a translated or romanized title, or with or without a subtitle. Authors may be missing or spelt differently.
Never group: a sequel, prequel or spin-off with its original; an anthology, doujinshi or fan work with what it is based on; a light novel or novel with its manga or manhwa; different works that share a word. When unsure, leave them apart.
Cards that already share a "group" are the same series; you may add cards to that group.
Answer JSON only: {"groups": [[i, i, ...], ...]}, listing only groups of two or more cards, each card at most once.`;

/** What Gemini is told about each card. */
function shown(list: MangaFound[], groups: Map<string, string>): Shown[] {
  return list.map((f, i) => {
    const s: Shown = {
      i,
      title: f.card.title,
      names: f.keys.filter((k) => !isGroupKey(k)).slice(0, 8),
      people: f.people.slice(0, 4),
      kind: f.card.kind,
      year: 'year' in f.card ? f.card.year : null,
      status: f.card.status,
      site: f.source,
      side: f.card.side,
    };
    const g = groups.get(f.card.id);
    if (g) s.group = g;
    return s;
  });
}

/** Gemini's groups, checked: indices in range, each once, groups of two or more. */
export function checkedGroups(answer: unknown, size: number): number[][] {
  const raw = (answer as { groups?: unknown })?.groups;
  if (!Array.isArray(raw)) return [];
  const used = new Set<number>();
  const out: number[][] = [];
  for (const g of raw) {
    if (!Array.isArray(g)) continue;
    const members: number[] = [];
    for (const i of g) {
      if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= size || used.has(i)) continue;
      used.add(i);
      members.push(i);
    }
    if (members.length >= 2) out.push(members);
  }
  return out;
}

/** A lot's key as a set of groups (a card with none counts as its own), to tell it was looked at together before. */
function lotKey(list: MangaFound[], groupOf: (card: string) => string | undefined): string {
  const ids = [...new Set(list.map((f) => groupOf(f.card.id) ?? f.card.id))].sort().join(',');
  return `same:v1:${createHash('sha256').update(ids).digest('base64url')}`;
}

/** With its group's key among its names. */
function withGroup(f: MangaFound, canon: string | undefined): MangaFound {
  if (!canon || f.keys.includes(canon)) return f;
  return { ...f, keys: [...f.keys, canon] };
}

export function makeSame(o: { groups: Groups; gemini: Gemini | null; store: Store }): Same {
  const kept = new Map<string, string>();
  const unknownUntil = new Map<string, number>();
  const asking = new Map<string, Promise<void>>();
  const wide = new Map<string, { names: string[]; until: number }>();

  function keep(card: string, canon: string) {
    kept.delete(card);
    kept.set(card, canon);
    unknownUntil.delete(card);
    while (kept.size > MOST_KEPT) kept.delete(kept.keys().next().value!);
  }

  /** The groups of these cards, from memory and then Supabase. */
  async function groupsOf(cards: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const now = Date.now();
    const look: string[] = [];
    for (const c of cards) {
      const g = kept.get(c);
      if (g) out.set(c, g);
      else if ((unknownUntil.get(c) ?? 0) < now) look.push(c);
    }
    if (look.length) {
      try {
        const found = await o.groups.get(look);
        for (const c of look) {
          const g = found.get(c);
          if (g) {
            keep(c, g);
            out.set(c, g);
          } else unknownUntil.set(c, now + UNKNOWN_FOR);
        }
      } catch (err) {
        log.warn({ err }, 'series groups couldn’t be read, so the lot is shown as its names group it');
      }
    }
    return out;
  }

  /** Asks Gemini about one lot's cards, and keeps what it says. */
  async function ask(list: MangaFound[], groups: Map<string, string>) {
    const answer = await o.gemini!.json<unknown>(SYSTEM, JSON.stringify(shown(list, groups)), { timeout: BEHIND, thinking: 'low' });
    const told = checkedGroups(answer, list.length);
    const target = new Map<number, string>();
    const into = new Map<string, string>();
    for (const members of told) {
      const theirs = [...new Set(members.map((i) => groups.get(list[i].card.id)).filter((g): g is string => !!g))].sort();
      const canon = theirs[0] ?? groupKey(list[members[0]].card.id);
      for (const g of theirs.slice(1)) into.set(g, canon);
      for (const i of members) target.set(i, canon);
    }
    const rows: Array<{ card: string; canon: string; names: string[] }> = [];
    for (const [i, f] of list.entries()) {
      const was = groups.get(f.card.id);
      let canon = target.get(i) ?? was ?? groupKey(f.card.id);
      canon = into.get(canon) ?? canon;
      if (was === canon) continue;
      rows.push({ card: f.card.id, canon, names: f.keys.filter((k) => !isGroupKey(k)) });
    }
    if (rows.length || into.size) await o.groups.put(rows, into, o.gemini!.model('low'));
    for (const r of rows) keep(r.card, r.canon);
    if (into.size) {
      for (const [card, g] of kept) {
        const to = into.get(g);
        if (to) kept.set(card, to);
      }
    }
    // Kept by the groups the lot has now, as the next lot like it will be.
    await o.store.set(lotKey(list, (c) => kept.get(c)), true, LOOKED_FOR);
    if (told.length) log.info({ groups: told.length, cards: list.length, model: o.gemini!.model('low') }, 'Gemini grouped a lot’s series');
  }

  return {
    known(items) {
      return items.map((f) => withGroup(f, kept.get(f.card.id)));
    },

    async settle(items, wait) {
      const byCard = new Map<string, MangaFound>();
      for (const f of items) if (!byCard.has(f.card.id)) byCard.set(f.card.id, f);
      const list = [...byCard.values()].slice(0, MOST_CARDS);
      let groups = await groupsOf(list.map((f) => f.card.id));

      if (o.gemini && list.length >= 2) {
        // Looked at together before when every card has a group and those groups were in one lot.
        const all = list.every((f) => groups.has(f.card.id));
        const look = lotKey(list, (c) => groups.get(c));
        const seen = all && (await o.store.get(look)) === true;
        if (!seen) {
          let going = asking.get(look);
          if (!going) {
            going = ask(list, groups).catch((err) => log.warn({ err }, 'Gemini couldn’t group a lot’s series, so they’re shown as their names group them'));
            asking.set(look, going);
            void going.finally(() => asking.delete(look));
          }
          let timer: NodeJS.Timeout | undefined;
          await Promise.race([going, new Promise<void>((done) => { timer = setTimeout(done, Math.max(0, wait)); })]);
          clearTimeout(timer);
          groups = new Map(list.flatMap((f) => { const g = kept.get(f.card.id); return g ? [[f.card.id, g] as const] : []; }));
        }
      }
      return items.map((f) => withGroup(f, groups.get(f.card.id)));
    },

    async widen(names) {
      const key = [...names].sort().join(',');
      const hit = wide.get(key);
      if (hit && hit.until > Date.now()) return hit.names;
      let out = names;
      try {
        const more = await o.groups.names(names);
        out = [...new Set([...names, ...more])].slice(0, 200);
      } catch (err) {
        log.warn({ err }, 'a series group’s other names couldn’t be read');
      }
      wide.set(key, { names: out, until: Date.now() + WIDE_FOR });
      if (wide.size > 2_000) wide.delete(wide.keys().next().value!);
      return out;
    },
  };
}
