import { args, findBook, main } from '../lib.ts';
import { researchBook, researched } from '../research.ts';

/*
 * npm --prefix ai run research -- <rank or key> [<book>…]   Researches books on the web with the
 *                                                             harness (research.ts), from their
 *                                                             names alone, into each one's web.md.
 *   --again   research a book again, even when it has research
 *
 * Books go one at a time, a series in order, since its volumes share their research.
 */

main(async () => {
  const { rest, flags } = args();
  if (!rest.length) throw new Error('Which book? npm --prefix ai run research -- <rank or key> [<book>…] [--again]');
  const books = rest.map((k) => findBook(k)).sort((a, b) => (a.seriesIndex ?? 0) - (b.seriesIndex ?? 0));
  for (const b of books) {
    if (researched(b) && !flags.again) {
      console.log(`${b.title}: researched already (--again to do it again)`);
      continue;
    }
    await researchBook(b);
  }
});
