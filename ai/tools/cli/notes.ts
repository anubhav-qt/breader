import { existsSync } from 'node:fs';
import { Balancer } from '../balancer.ts';
import { LADDER, PRIMARY } from '../kimi.ts';
import { args, loadBook, loadQueue, main, QUEUE, type Book } from '../lib.ts';
import { writeNotes } from '../notes.ts';

/*
 * npm --prefix ai run notes -- <book> [<book>…]   Writes a book's Revisit notes, checks them,
 *                                                  reads them through as a reader and packs.
 *   --again       start over, setting any notes it has aside in notes.before.json
 *   --no-pack     don't pack at the end
 *
 * The work itself is notes.ts. Volumes of one series run in order, each after the ones before it,
 * so a later volume can say what the earlier ones showed.
 */

main(async () => {
  const { rest, flags } = args();
  if (!rest.length) throw new Error('Which book? npm --prefix ai run notes -- <rank or key> [<book>…] [--again] [--no-pack]');
  const lb = new Balancer(LADDER);
  // The read-through is Kimi's, waited for however long it takes.
  const top = new Balancer(PRIMARY, { waitForTopS: Infinity, strikesToFall: Infinity, maxTries: 40 });
  // A volume waits for the earlier volumes of its series in this run, to read what they showed,
  // so earlier volumes start first and each later one finds theirs in `runs`.
  const queue = existsSync(QUEUE) ? loadQueue().books : [];
  const place = (b: Book) => queue.find((q) => q.sha256 === b.sha256);
  const books = rest.map((k) => loadBook(k)).sort((a, b) => (place(a)?.seriesIndex ?? 0) - (place(b)?.seriesIndex ?? 0));
  const runs = new Map<string, Promise<void>>();
  for (const b of books) {
    const me = place(b);
    const before = books.filter((o) => {
      const it = place(o);
      return o !== b && me?.series && it?.series?.toLowerCase() === me.series.toLowerCase() && (it.seriesIndex ?? Infinity) < (me.seriesIndex ?? -Infinity);
    });
    runs.set(b.key, (async () => {
      if (before.length) {
        console.log(`${b.title}: waits for ${before.map((o) => o.title).join(', ')}`);
        const done = await Promise.allSettled(before.map((o) => runs.get(o.key) ?? Promise.resolve()));
        const failed = before.filter((_, i) => done[i].status === 'rejected');
        if (failed.length) throw new Error(`${b.title}: not started, since ${failed.map((o) => o.title).join(', ')} failed first and its notes are what this one builds on. Run notes again.`);
      }
      try {
        await writeNotes(b.key, lb, top, flags);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(msg.startsWith(b.title) ? msg : `${b.title}: ${msg}`);
      }
    })());
  }
  const results = await Promise.allSettled([...runs.values()]);
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  for (const f of failed) console.error(`\n${f.reason instanceof Error ? f.reason.message : String(f.reason)}`);
  return failed.length ? 1 : 0;
});
