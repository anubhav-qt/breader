import type { AiFile } from '../../../shared/src/ai.ts';
import { prodClient } from '../env.ts';
import { live, loadAll, same, stored, table, upsert, wanted, type State } from '../import.ts';
import { args, main } from '../lib.ts';

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
        await upsert(db, f);
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
