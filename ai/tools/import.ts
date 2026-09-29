import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { AiFile, aiProblems } from '../../shared/src/ai.ts';
import { prodClient } from './env.ts';
import { args, count, main, OUT } from './lib.ts';

/*
 * npm --prefix ai run import                Loads every ai/out/<sha256>.json into production.
 * npm --prefix ai run import -- --dry       Writes nothing: says, per book, what would happen.
 * npm --prefix ai run import -- --verify    Reads each book back and compares it with its file.
 *
 * Every file is checked first (the schema in shared/src/ai.ts, and that its positions and people
 * are real), and if any fails, nothing is written. Then all of them go in one transaction, each
 * by its file's SHA-256: new, changed, or the same (left alone, so running it twice changes
 * nothing). A file that no library with its AI switch on holds is skipped: nobody said yes to it.
 * It needs the app update with the ai_notes table live first, and says so if it isn't.
 */

interface Loaded {
  file: string;
  data: AiFile;
}

type State = 'new' | 'changed' | 'same' | 'skipped';

/** JSON with its keys sorted, so a file and what Postgres hands back compare as text. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

function loadAll(): Loaded[] {
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
    const r = AiFile.safeParse(raw);
    if (!r.success) {
      for (const i of r.error.issues.slice(0, 10)) problems.push(`${file}: ${i.path.join('.') || '(top)'}: ${i.message}`);
      continue;
    }
    if (file !== `${r.data.sha256}.json`) problems.push(`${file}: its sha256 says ${r.data.sha256}, so its name should be ${r.data.sha256}.json`);
    for (const p of aiProblems(r.data).slice(0, 10)) problems.push(`${file}: ${p}`);
    out.push({ file, data: r.data });
  }
  if (problems.length) {
    console.error(`Nothing was imported. ${problems.length === 1 ? 'One file has a problem' : 'Some files have problems'}:\n`);
    for (const p of problems) console.error(`  ${p}`);
    console.error('\nFix them (run check and pack again), then import.');
    process.exit(1);
  }
  return out;
}

/** Stops with a clear message when the app update isn't on the server yet. */
async function live(db: pg.Client) {
  const { rows: [r] } = await db.query<{ table: boolean; column: boolean }>(`
    SELECT to_regclass('public.ai_notes') IS NOT NULL AS table,
           EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'library_items' AND column_name = 'ai') AS column`);
  if (!r.table || !r.column) {
    throw new Error('Production doesn’t have the ai_notes table yet: the app update for Revisit and 2 voices isn’t live. Nothing was imported. Ask the owner to deploy it, then run this again.');
  }
}

/** Which files some library with its AI switch on holds, of these. */
async function wanted(db: pg.Client, shas: string[]): Promise<Set<string>> {
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

async function stored(db: pg.Client, shas: string[]) {
  const { rows } = await db.query<{ sha256: string; data: unknown; made: Date; by: string }>(
    'SELECT sha256, data, made, by FROM ai_notes WHERE sha256 = ANY($1)',
    [shas],
  );
  return new Map(rows.map((r) => [r.sha256, r]));
}

const same = (a: { data: unknown; made: Date; by: string }, f: AiFile) =>
  canon(a.data) === canon(f) && new Date(a.made).getTime() === new Date(f.made).getTime() && a.by === f.by;

function summary(f: AiFile) {
  const r = f.revisit;
  const g = { M: 0, F: 0, N: 0 };
  for (const s of f.voices.spans) g[s[4]]++;
  return `${count(f.voices.spans.length)} lines (M ${count(g.M)}, F ${count(g.F)}, N ${count(g.N)}), notes ${r.people.length} people, ${r.places.length} places, ${r.terms.length} words`;
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s).padEnd(n);

function table(rows: Array<{ f: AiFile; state: string }>) {
  console.log(`${'state'.padEnd(9)} ${'title'.padEnd(44)} what`);
  for (const { f, state } of rows) console.log(`${state.padEnd(9)} ${cut(f.title, 44)} ${summary(f)}, by ${f.by}`);
}

main(async () => {
  const { flags } = args();
  const dry = !!flags.dry;
  const verify = !!flags.verify;
  if (dry && verify) throw new Error('Pick one: --dry or --verify.');
  const books = loadAll();
  const shas = books.map((b) => b.data.sha256);

  const db = await prodClient(dry || verify ? 'breader-ai-import-check' : 'breader-ai-import');
  try {
    await live(db);

    if (verify) {
      await db.query('BEGIN READ ONLY');
      const have = await stored(db, shas);
      await db.query('ROLLBACK');
      const rows = books.map(({ data: f }) => {
        const row = have.get(f.sha256);
        return { f, state: !row ? 'missing' : same(row, f) ? 'matches' : 'differs' };
      });
      table(rows);
      const bad = rows.filter((r) => r.state !== 'matches').length;
      console.log(bad ? `\n${bad} of ${rows.length} don’t match what’s in ai/out.` : `\nAll ${rows.length} match what’s in ai/out.`);
      return bad ? 1 : 0;
    }

    await db.query(dry ? 'BEGIN READ ONLY' : 'BEGIN');
    const ok = await wanted(db, shas);
    const have = await stored(db, shas);
    const rows: Array<{ f: AiFile; state: State }> = books.map(({ data: f }) => {
      const row = have.get(f.sha256);
      const state: State = !ok.has(f.sha256) ? 'skipped' : !row ? 'new' : same(row, f) ? 'same' : 'changed';
      return { f, state };
    });
    if (!dry) {
      for (const { f, state } of rows) {
        if (state !== 'new' && state !== 'changed') continue;
        await db.query(
          `INSERT INTO ai_notes (sha256, data, made, by) VALUES ($1, $2::jsonb, $3, $4)
           ON CONFLICT (sha256) DO UPDATE SET data = excluded.data, made = excluded.made, by = excluded.by, imported_at = now()`,
          [f.sha256, JSON.stringify(f), f.made, f.by],
        );
      }
    }
    await db.query(dry ? 'ROLLBACK' : 'COMMIT');

    table(rows);
    const n = (s: State) => rows.filter((r) => r.state === s).length;
    const skipped = n('skipped');
    if (skipped) console.log(`\nSkipped ${skipped}: no library with its AI switch on holds ${skipped === 1 ? 'that file' : 'those files'}.`);
    const writes = n('new') + n('changed');
    if (dry) console.log(`\nDry run, nothing written. Importing would add ${n('new')}, change ${n('changed')} and leave ${n('same')} as they are.`);
    else console.log(`\nImported: ${n('new')} new, ${n('changed')} changed, ${n('same')} already the same.${writes ? ' Check it with: npm --prefix ai run import -- --verify' : ''}`);
    return 0;
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await db.end();
  }
});
