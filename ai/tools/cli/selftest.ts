import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extract } from '../extract.ts';
import { args, bookDir, main, writeJson, type Book } from '../lib.ts';
import { locate } from '../marks.ts';
import { detectStyle, findQuotes } from '../quotes.ts';
import { validate } from '../validate.ts';
import { CAST, epub, MARKS, NOTES } from '../test/lantern.ts';

/*
 * npm --prefix ai run selftest [-- --keep]
 *
 * The tools on a small made-up book (no one's real books): an EPUB goes through the app's own
 * parser, its quotes are found, and a cast, notes and marks written for it pass the checks, while
 * a spoiler, a dash and a missing mark are caught. --keep leaves it in ai/work/selftest to try
 * check, audit and pack on.
 */

let failed = 0;
function ok(cond: unknown, what: string) {
  if (cond) return;
  failed++;
  console.log(`FAIL ${what}`);
}
const same = (a: unknown, b: unknown, what: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);

const TXT = `Title: The Small Book
Author: Some One

*** START OF THE PROJECT GUTENBERG EBOOK THE SMALL BOOK ***

CHAPTER I.

"Hello," said Tom. "Is anyone there?"

Nobody answered.

CHAPTER II.

"Still nobody," said Tom.

*** END OF THE PROJECT GUTENBERG EBOOK ***
`;

const quotesIn = (book: Book, s: number, b: number) =>
  book.segs.filter((g) => g.s === s && g.b === b).map((g) => book.sections[s].blocks[b].text.slice(g.start, g.end));

main(async () => {
  const { flags } = args();

  // Quote finding on its own.
  same(findQuotes('‘Fine,’ she said. ‘The boys’ bikes are here.’', 'single').quotes.length, 2, 'single quotes around a plural possessive');
  const goin = '‘I’m goin’ home,’ he said.';
  same(findQuotes(goin, 'single').quotes.map((q) => goin.slice(q.start, q.end)), ['‘I’m goin’ home,’'], 'single quotes past dropped letters');
  same(findQuotes('He said ‘em were gone.', 'single').quotes.length, 0, '‘em is not a quote');
  const dash = '—Where are you going? —he asked.';
  same(findQuotes(dash, 'dash').quotes.map((q) => dash.slice(q.start, q.end)), ['—Where are you going?'], 'dash dialogue up to the tag');
  same(detectStyle(['‘Hello,’ she said.', '‘Go,’ he said.', '‘Now,’ they said.']), 'single', 'single style');
  same(locate('No, no, no.', 'no', 2), [4, 6], 'the second of three');
  ok(typeof locate('No, no, no.', 'no', 0) === 'string', 'a repeated phrase needs @n');

  // An EPUB through the app's parser.
  const bytes = await epub();
  const sha = createHash('sha256').update(bytes).digest('hex');
  const book = await extract('selftest', sha, bytes, 'EPUB', 'The Test Lantern');
  same(book.title, 'The Test Lantern', 'title');
  same(book.sections.length, 2, 'sections');
  same(book.sections[0].blocks.map((b) => b.tag), ['h1', 'p', 'p', 'p', 'p', 'p', 'p', 'p'], 'blocks of chapter one');
  same(book.style, 'double', 'quote style');
  same(book.parts.length, 1, 'parts');
  same(quotesIn(book, 0, 2), ['“You’re late,”', '“The ferry left.”'], 'quotes in 0:2');
  same(quotesIn(book, 0, 4), ['“shortcut”'], 'scare quote found for the agent to reject');
  same(quotesIn(book, 0, 5), ['“It was a long winter,'], 'a quote that runs on');
  same(book.segs.find((g) => g.s === 0 && g.b === 5)?.note, 'runs-on', 'marked as running on');
  same(quotesIn(book, 0, 0), [], 'no quotes in headings');

  // A plain text file, as Project Gutenberg sends it.
  const txt = await extract('selftest-txt', 'x'.repeat(64), new TextEncoder().encode(TXT), 'TXT', 'fallback');
  same(txt.title, 'The Small Book', 'Gutenberg title');
  same(txt.sections.length, 2, 'Gutenberg chapters');
  same(quotesIn(txt, 0, 1), ['"Hello,"', '"Is anyone there?"'], 'straight quotes');
  rmSync(bookDir('selftest-txt'), { recursive: true, force: true });

  // A cast, notes and marks that pass.
  const dir = bookDir('selftest');
  const write = (notes: unknown, marks: string) => {
    writeJson(join(dir, 'cast.json'), CAST);
    writeJson(join(dir, 'notes.json'), notes);
    writeFileSync(join(dir, 'marks', '0001.txt'), marks);
  };
  rmSync(join(dir, 'marks'), { recursive: true, force: true });
  mkdirSync(join(dir, 'marks'), { recursive: true });
  write(NOTES, MARKS);
  let c = validate(book, true);
  same(c.errors, [], 'errors on a good book');
  same(c.warnings, [], 'warnings on a good book');
  same(c.marks.spans.length, 9, 'lines');
  same(c.marks.notSpeech, 1, 'quotes not speech');
  same(c.genderAt('masked-knight', [1, 2]), 'M', 'voice before the reveal');
  same(c.genderAt('masked-knight', [1, 4]), 'F', 'voice after the reveal');
  const thought = c.marks.spans.find((s) => s.think);
  same(thought && book.sections[0].blocks[7].text.slice(thought.start, thought.end), 'I should never have come back', 'a thought found by its words');

  // A spoiler, a dash and a missing mark are caught.
  const spoil = structuredClone(NOTES);
  spoil.people[0].events!.push({ at: '0:4', text: 'Meets Ines at the gate.' });
  spoil.places[0].about[0].text = 'A town — wet.';
  write(spoil, MARKS.replace('0:4.1 -\n', ''));
  c = validate(book, true);
  ok(c.warnings.some((w) => w.includes('Ines')), 'a name used before the book names it');
  ok(c.errors.some((e) => e.includes('dash')), 'a dash in a note');
  ok(c.errors.some((e) => e.includes('0:4.1')), 'a quote left unmarked');

  if (flags.keep) {
    write(NOTES, MARKS);
    console.log('Kept ai/work/selftest: try check, audit and pack on "selftest".');
  } else {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(failed ? `\n${failed} checks failed.` : 'Self-test passed.');
  return failed ? 1 : 0;
});
