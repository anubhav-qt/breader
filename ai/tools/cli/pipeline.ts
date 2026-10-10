import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AiFile } from '../../../shared/src/ai.ts';
import { castPass } from '../cast.ts';
import { fetchBook } from '../fetch.ts';
import { checkFile, summary } from '../import.ts';
import { castByFile } from '../kimi.ts';
import { args, findBook, isFetched, loadBook, main, OUT, readJson, writeJson } from '../lib.ts';
import { markBook } from '../mark.ts';
import { balancers, withMusic } from '../marker.ts';
import { musicBy, scoreBook } from '../music.ts';
import { writeNotes } from '../notes.ts';
import { researchBook, researched } from '../research.ts';

/*
 * npm --prefix ai run pipeline -- <rank or key>   Runs one book through everything the marker does
 *                                                  (marker.ts), here: fetched, researched on the
 *                                                  web, its cast read, marked, its notes written and
 *                                                  its music scored, all into its file in ai/out,
 *                                                  then checked. Nothing goes to the server.
 *   --no-store   don't keep the music's tracks in the file store
 *
 * For trying the whole pipeline on a book. Run it with AI_WORK and AI_OUT set to folders of their
 * own, so its work doesn't mix with anyone else's, and run books first to list the books there.
 * Run again, it carries on where it stopped.
 */

main(async () => {
  const { rest, flags } = args();
  if (rest.length !== 1) throw new Error('Which book? npm --prefix ai run pipeline -- <rank or key> [--no-store]');
  const b = findBook(rest[0]);
  const lbs = balancers();
  const started = Date.now();

  if (!isFetched(b.key)) await fetchBook(b);
  if (!researched(b)) await researchBook(b);
  const book = loadBook(b.key);
  if (!existsSync(castByFile(book))) await castPass(book, lbs.lb);
  await markBook(b.key, lbs.lb, lbs.top, {});
  await writeNotes(b.key, lbs.notes, lbs.review, {});
  const score = await scoreBook(b, loadBook(b.key), lbs.music, flags);

  const file = join(OUT, `${b.sha256}.json`);
  const f = withMusic(readJson<AiFile>(file), score, musicBy(book));
  const c = checkFile(`${b.sha256}.json`, f);
  if (c.problems.length) throw new Error(`${b.title}: its file has ${c.problems.length} problems. The first: ${c.problems[0]}`);
  writeJson(file, f);
  const silences = score.cues.filter((cue) => cue[2] < 0).length;
  console.log(`\n${b.title}: done in ${Math.round((Date.now() - started) / 60_000)} min.`);
  console.log(`  ${summary(f)}`);
  console.log(`  music: ${score.cues.length} cues (${silences} of them silence), ${score.tracks.length} tracks`);
  console.log(`  by: ${f.by}`);
  console.log(`  file: ${file}`);
});
