import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { bookDir, isFetched, isPacked, main, marksFiles, QUEUE, readJson, writeJson, type QueueBook } from '../lib.ts';
import { listBooks } from '../library.ts';

/*
 * npm --prefix ai run books
 *
 * Lists every book whose AI switch is on (library.ts), saves the list to ai/work/queue.json and
 * prints where each book stands.
 */

export function status(b: QueueBook): string {
  if (isPacked(b)) return 'packed';
  if (!isFetched(b.key)) return 'new';
  const meta = join(bookDir(b.key), 'meta.json');
  const parts = existsSync(meta) ? readJson<{ parts: number }>(meta).parts : 0;
  const done = marksFiles(b.key).length;
  return done ? `part ${done} of ${parts}` : 'fetched';
}

main(async () => {
  const q = await listBooks();
  writeJson(QUEUE, q);
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s).padEnd(n);
  console.log(`${q.books.length} books${q.everyBook ? '' : ' with the AI switch on'}, most recently read first. Saved to ai/work/queue.json.`);
  if (q.everyBook) console.log('The server has no AI switch yet (the app update isn’t live), so this lists every book. Import will still only load the ones whose switch is on.');
  console.log('');
  console.log(`${'#'.padStart(3)}  ${'status'.padEnd(14)} ${'title'.padEnd(44)} ${'format'.padEnd(6)} ${'read'.padStart(4)}  ${'last read'.padEnd(10)}  key`);
  for (const b of q.books) {
    const read = b.started ? `${Math.round(b.progress * 100)}%` : '-';
    console.log(`${String(b.rank).padStart(3)}  ${status(b).padEnd(14)} ${cut(b.title, 44)} ${b.format.padEnd(6)} ${read.padStart(4)}  ${b.lastRead.slice(0, 10)}  ${b.key}`);
  }
  if (q.skipped.length) {
    console.log(`\nSkipped ${q.skipped.length}:`);
    for (const s of q.skipped) console.log(`  ${s}`);
  }
  const next = q.books.find((b) => !isPacked(b));
  console.log(next ? `\nNext: ${next.rank}. ${next.title} (npm --prefix ai run fetch -- next)` : '\nEvery book is packed.');
});
