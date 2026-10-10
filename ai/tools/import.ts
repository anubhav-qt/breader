import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { AiFile, aiProblems } from '../../shared/src/ai.ts';
import { count, OUT } from './lib.ts';

/*
 * The server's copy of each book's file, in ai_notes: checking a file before it goes in, reading
 * what's there, and writing it. A file goes in by its SHA-256, and only while some library with
 * its AI switch on holds that file: nobody else said yes to it.
 */

export interface Loaded {
  file: string;
  data: AiFile;
}

export type State = 'new' | 'changed' | 'same' | 'skipped';

/** JSON with its keys sorted, so a file and what Postgres hands back compare as text. */
export function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** One file checked: the schema in shared/src/ai.ts, and that its positions and people are real. */
export function checkFile(file: string, raw: unknown): { data?: AiFile; problems: string[] } {
  const r = AiFile.safeParse(raw);
  if (!r.success) return { problems: r.error.issues.slice(0, 10).map((i) => `${file}: ${i.path.join('.') || '(top)'}: ${i.message}`) };
  const problems: string[] = [];
  if (file !== `${r.data.sha256}.json`) problems.push(`${file}: its sha256 says ${r.data.sha256}, so its name should be ${r.data.sha256}.json`);
  for (const p of aiProblems(r.data).slice(0, 10)) problems.push(`${file}: ${p}`);
  return { data: r.data, problems };
}

/** Every file in ai/out, checked. If any has a problem, it says which and loads none. */
export function loadAll(): Loaded[] {
  if (!existsSync(OUT)) throw new Error('There’s no ai/out yet: pack a book first.');
  const names = readdirSync(OUT).filter((f) => f.endsWith('.json')).sort();
  if (!names.length) throw new Error('ai/out has no books in it: pack a book first.');
  const out: Loaded[] = [];
  const problems: string[] = [];
  for (const file of names) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(OUT, file), 'utf8'));
    } catch (e) {
      problems.push(`${file}: isn’t valid JSON (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    const c = checkFile(file, raw);
    problems.push(...c.problems);
    if (c.data) out.push({ file, data: c.data });
  }
  if (problems.length) {
    const list = problems.map((p) => `  ${p}`).join('\n');
    throw new Error(`Nothing was imported. ${problems.length === 1 ? 'One file has a problem' : 'Some files have problems'}:\n\n${list}\n\nFix them (run check and pack again), then import.`);
  }
  return out;
}

/** One book's file from ai/out, checked. */
export function loadOne(sha256: string): AiFile {
  const file = `${sha256}.json`;
  const c = checkFile(file, JSON.parse(readFileSync(join(OUT, file), 'utf8')));
  if (!c.data || c.problems.length) throw new Error(`ai/out/${file} has problems, so it wasn’t imported. The first: ${c.problems[0]}`);
  return c.data;
}

/** Stops with a clear message when the app update isn't on the server yet. */
export async function live(db: pg.Client) {
  const { rows: [r] } = await db.query<{ table: boolean; column: boolean }>(`
    SELECT to_regclass('public.ai_notes') IS NOT NULL AS table,
           EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'library_items' AND column_name = 'ai') AS column`);
  if (!r.table || !r.column) {
    throw new Error('Production doesn’t have the ai_notes table yet: the app update for Revisit and 2 voices isn’t live. Nothing was imported. Ask the owner to deploy it, then run this again.');
  }
}

/** Which files some library with its AI switch on holds, of these. */
export async function wanted(db: pg.Client, shas: string[]): Promise<Set<string>> {
  const { rows } = await db.query<{ sha256: string }>(
    `SELECT DISTINCT b.sha256
       FROM library_items li
       JOIN libraries l ON l.id = li.library_id
       JOIN blobs b ON b.id = li.file_id
      WHERE b.sha256 = ANY($1) AND b.status = 'ready' AND li.ai AND li.removed_at IS NULL AND l.retired_at IS NULL`,
    [shas],
  );
  return new Set(rows.map((r) => r.sha256));
}

export async function stored(db: pg.Client, shas: string[]) {
  const { rows } = await db.query<{ sha256: string; data: unknown; made: Date; by: string }>(
    'SELECT sha256, data, made, by FROM ai_notes WHERE sha256 = ANY($1)',
    [shas],
  );
  return new Map(rows.map((r) => [r.sha256, r]));
}

export const same = (a: { data: unknown; made: Date; by: string }, f: AiFile) =>
  canon(a.data) === canon(f) && new Date(a.made).getTime() === new Date(f.made).getTime() && a.by === f.by;

export function summary(f: AiFile) {
  const r = f.revisit;
  const g = { M: 0, F: 0, N: 0 };
  for (const s of f.voices.spans) g[s[4]]++;
  return `${count(f.voices.spans.length)} lines (M ${count(g.M)}, F ${count(g.F)}, N ${count(g.N)}), notes ${r.people.length} people, ${r.places.length} places, ${r.terms.length} words`;
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s).padEnd(n);

export function table(rows: Array<{ f: AiFile; state: string }>) {
  console.log(`${'state'.padEnd(9)} ${'title'.padEnd(44)} what`);
  for (const { f, state } of rows) console.log(`${state.padEnd(9)} ${cut(f.title, 44)} ${summary(f)}, by ${f.by}`);
}

/** Writes a file into ai_notes, new or in place of what's there. */
export async function upsert(db: pg.Client, f: AiFile) {
  await db.query(
    `INSERT INTO ai_notes (sha256, data, made, by) VALUES ($1, $2::jsonb, $3, $4)
     ON CONFLICT (sha256) DO UPDATE SET data = excluded.data, made = excluded.made, by = excluded.by, imported_at = now()`,
    [f.sha256, JSON.stringify(f), f.made, f.by],
  );
}

/** Writes a file in place of the one made at `was`, and says whether that one was still there. */
export async function replace(db: pg.Client, f: AiFile, was: string): Promise<boolean> {
  const r = await db.query(
    'UPDATE ai_notes SET data = $2::jsonb, made = $3, by = $4, imported_at = now() WHERE sha256 = $1 AND made = $5',
    [f.sha256, JSON.stringify(f), f.made, f.by, was],
  );
  return r.rowCount === 1;
}

/** What the server has for these files: when each was made, by whom, how many Revisit entries it has, and whether it has music. */
export async function onServer(db: pg.Client, shas: string[]) {
  const { rows } = await db.query<{ sha256: string; made: Date; by: string; notes: number; music: boolean }>(
    `SELECT sha256, made, by,
            jsonb_array_length(data->'revisit'->'people') + jsonb_array_length(data->'revisit'->'places') + jsonb_array_length(data->'revisit'->'terms') AS notes,
            data ? 'music' AS music
       FROM ai_notes WHERE sha256 = ANY($1)`,
    [shas],
  );
  return new Map(rows.map((r) => [r.sha256, { made: new Date(r.made).toISOString(), by: r.by, notes: Number(r.notes), music: r.music }]));
}

/** One book's whole file as the server has it. */
export async function fileOnServer(db: pg.Client, sha256: string): Promise<AiFile | null> {
  const { rows } = await db.query<{ data: AiFile }>('SELECT data FROM ai_notes WHERE sha256 = $1', [sha256]);
  return rows[0]?.data ?? null;
}
