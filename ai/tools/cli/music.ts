import { Balancer } from '../balancer.ts';
import { fetchBook } from '../fetch.ts';
import { LADDER } from '../kimi.ts';
import { args, findBook, isFetched, loadBook, main } from '../lib.ts';
import { scoreBook } from '../music.ts';
import { researchBook, researched } from '../research.ts';

/*
 * npm --prefix ai run music -- <rank or key> [<book>…]   Scores books' background music
 *                                                          (music.ts) into each one's music.json.
 *   --again      score a book again from the start
 *   --no-store   don't keep its tracks in the file store
 *
 * A book is fetched and researched on the web first when it hasn't been. The series' soundtrack is
 * gathered by the harness when it has none or it's a month old. Books go one at a time, a series
 * in order, so its soundtrack is gathered once. The marker puts the music into each book's file
 * on the server; this doesn't.
 */

main(async () => {
  const { rest, flags } = args();
  if (!rest.length) throw new Error('Which book? npm --prefix ai run music -- <rank or key> [<book>…] [--again] [--no-store]');
  const lb = new Balancer(LADDER);
  const books = rest.map((k) => findBook(k)).sort((a, b) => (a.seriesIndex ?? 0) - (b.seriesIndex ?? 0));
  for (const b of books) {
    if (!isFetched(b.key)) await fetchBook(b);
    if (!researched(b)) await researchBook(b);
    await scoreBook(b, loadBook(b.key), lb, flags);
  }
});
