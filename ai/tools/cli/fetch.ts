import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fetchBook } from '../fetch.ts';
import { args, bookDir, count, findBook, isFetched, isPacked, loadQueue, main, partName } from '../lib.ts';
import { STYLE_NAMES } from '../quotes.ts';

/*
 * npm --prefix ai run fetch -- next | <rank or key> [--again]
 *
 * Downloads a book's file from R2 (read only), checks it's the file the server recorded, and
 * extracts it into ai/work/<key>/ with everything the agent starts from: the text in parts, a cast
 * with the generic speakers (and the cast of another volume in the series, when one exists),
 * empty notes, and the research and ledger templates. Never overwrites the agent's own files.
 */

main(async () => {
  const { rest, flags } = args();
  const which = rest[0] ?? 'next';
  const q = loadQueue();
  const b = which === 'next' ? q.books.find((x) => !isPacked(x)) : findBook(which);
  if (!b) {
    console.log('Every book in the queue is packed. Run books to look for new ones.');
    return;
  }
  const dir = bookDir(b.key);
  if (isFetched(b.key) && !flags.again) {
    console.log(`${b.rank}. ${b.title} is already fetched: ai/work/${b.key}`);
    console.log('Carry on from its ledger.md (check says which part is next).');
    return;
  }
  if (flags.again && existsSync(join(dir, 'marks')) && readdirSync(join(dir, 'marks')).length) {
    console.log('Note: this book has marks. Extracting again keeps them, and they only still fit if the tools haven’t changed.');
  }

  const { book, seeded } = await fetchBook(b);

  const toCheck = book.segs.filter((g) => g.note && g.note !== 'runs-on').length + book.stray.length;
  console.log(`Fetched ${b.rank}. ${book.title}${book.author ? ` by ${book.author}` : ''} (${b.format}, ${count(book.words)} words)`);
  console.log(`  Folder: ai/work/${b.key}`);
  console.log(`  Parts: ${book.parts.length} (text/${partName(1)}.md to text/${partName(book.parts.length)}.md)`);
  console.log(`  Quote style: ${STYLE_NAMES[book.style]}. ${count(book.segs.length)} numbered quotes, ${toCheck} paragraphs flagged to check.`);
  if (b.series) console.log(`  Series: ${b.series}${b.seriesIndex != null ? `, number ${b.seriesIndex}` : ''}`);
  if (seeded) console.log(`  ${seeded}`);
  console.log('\nNext: research (procedure.md, part 4, step 2).');
});
