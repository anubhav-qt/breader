import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AI, isPacked, loadQueue, main, WORK } from '../lib.ts';

/*
 * npm --prefix ai run mark-all   Marks every book in ai/work/research-ready.txt that isn't packed
 *                                yet, all in one mark run, and runs it again for whatever is left
 *                                until every one is packed.
 *
 * research-ready.txt has a line `<n> <key>` for each book whose research passes check; n is only an
 * order (a series' volume number, say). One mark run for every book means one balancer, so all
 * their calls queue together at Kimi's limit. A run for each book would hit NVIDIA all at once and
 * bring the 429s back. A book that fails waits for the next round, two minutes later, which picks
 * up where it stopped. Rounds go on until every book is in, so this can take hours: start it in a
 * terminal, not as a background job with a time limit.
 */

const READY = join(WORK, 'research-ready.txt');
const PAUSE_S = 120;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clock = () => new Date().toTimeString().slice(0, 5);

/** The keys in research-ready.txt not packed yet, in its order. */
function waiting(): string[] {
  const queue = loadQueue();
  const keys = readFileSync(READY, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[1])
    .filter(Boolean);
  const left: string[] = [];
  for (const key of keys) {
    const book = queue.books.find((b) => b.key === key);
    if (!book) throw new Error(`${key} is in research-ready.txt but not in the queue. Run books first.`);
    if (!isPacked(book)) left.push(key);
  }
  return left;
}

main(async () => {
  if (!existsSync(READY)) throw new Error('No ai/work/research-ready.txt yet: research a book first (procedure.md, Research only).');
  for (let round = 1; ; round++) {
    const keys = waiting();
    if (!keys.length) {
      console.log(`${clock()} Every book in research-ready.txt is packed.`);
      return 0;
    }
    console.log(`\n${clock()} Round ${round}: marking ${keys.length} ${keys.length === 1 ? 'book' : 'books'} at once.`);
    const run = spawnSync('npm', ['--prefix', AI, 'run', '--silent', 'mark', '--', ...keys], { stdio: 'inherit' });
    if (run.status === 0) continue;
    console.log(`${clock()} Round ${round} left some books unpacked. Again in ${PAUSE_S / 60} minutes.`);
    await sleep(PAUSE_S * 1000);
  }
});
