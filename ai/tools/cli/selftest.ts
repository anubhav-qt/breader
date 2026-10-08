import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { extract } from '../extract.ts';
import { args, bookDir, main, writeJson, type Book } from '../lib.ts';
import { locate } from '../marks.ts';
import { detectStyle, findQuotes } from '../quotes.ts';
import { validate } from '../validate.ts';

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

const XHTML = (title: string, body: string) =>
  `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body>${body}</body></html>`;

async function epub(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file(
    'META-INF/container.xml',
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>The Test Lantern</dc:title><dc:creator>A. Tester</dc:creator><dc:identifier id="id">selftest</dc:identifier></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`,
  );
  zip.file(
    'OEBPS/nav.xhtml',
    `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>nav</title></head><body><nav epub:type="toc"><ol><li><a href="ch1.xhtml">Chapter One</a></li><li><a href="ch2.xhtml">Chapter Two</a></li></ol></nav></body></html>`,
  );
  zip.file(
    'OEBPS/ch1.xhtml',
    XHTML('1', `
<h1>Chapter One</h1>
<p>Elena came to Ferrow in the rain.</p>
<p>“You’re late,” said Marlo. “The ferry left.”</p>
<p>“The trains,” she said. “Don’t start.”</p>
<p>He called it a “shortcut” and laughed.</p>
<p>“It was a long winter,</p>
<p>“and nobody came,” Elena finished.</p>
<p>I should never have come back, Elena thought.</p>`),
  );
  zip.file(
    'OEBPS/ch2.xhtml',
    XHTML('2', `
<h1>Chapter Two</h1>
<p>The masked knight rode in at dawn.</p>
<p>“Stand aside,” the knight said.</p>
<p>The knight took off the mask. It was Ines, Marlo’s sister.</p>
<p>“Brother,” Ines said.</p>`),
  );
  return zip.generateAsync({ type: 'uint8array' });
}

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

const CAST = {
  people: [
    { id: 'unknown', name: 'A speaker the text doesn’t identify', gender: 'N', generic: true },
    { id: 'elena', name: 'Elena', gender: 'F', evidence: '0:3 “she said”' },
    { id: 'marlo', name: 'Marlo', gender: 'M', evidence: '0:4 “He called it”' },
    { id: 'masked-knight', name: 'The masked knight', gender: 'M', evidence: '1:1, as the reader believes', changes: [{ at: '1:3', gender: 'F', why: 'Unmasked as Ines.' }] },
    { id: 'ines', name: 'Ines', gender: 'F', evidence: '1:3' },
  ],
};

const NOTES = {
  earlier: [],
  people: [
    {
      id: 'elena',
      names: [{ at: '0:1', name: 'Elena' }],
      about: [{ at: '0:1', text: 'A traveller who comes to Ferrow in the rain.' }],
      events: [{ at: '0:3', text: 'Arrives late because of the trains.' }],
    },
    {
      id: 'masked-knight',
      names: [{ at: '1:1', name: 'The masked knight' }],
      about: [{ at: '1:1', text: 'A knight who hides behind a mask.' }],
      merge: { at: '1:3', into: 'ines' },
    },
    { id: 'ines', names: [{ at: '1:3', name: 'Ines' }], about: [{ at: '1:3', text: 'Marlo’s sister, who rode in as the masked knight.' }] },
  ],
  places: [{ id: 'ferrow', names: [{ at: '0:1', name: 'Ferrow' }], about: [{ at: '0:1', text: 'A town where it rains.' }] }],
  terms: [],
};

const MARKS = `# self-test
narrator third pov elena
0:2.1 marlo
0:2.2 marlo
0:3.1 elena
0:3.2 elena
0:4.1 -
0:5.1 elena
0:6.1 elena
0:7 "I should never have come back" elena think
1:2.1 masked-knight
1:3 narrator third
1:4.1 ines
`;

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
