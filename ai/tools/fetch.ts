import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { prodEnv } from './env.ts';
import { extract } from './extract.ts';
import {
  args,
  bookDir,
  count,
  findBook,
  isFetched,
  isPacked,
  loadQueue,
  main,
  partName,
  readJson,
  ROOT,
  writeJson,
  type Book,
  type QueueBook,
} from './lib.ts';
import { STYLE_NAMES } from './quotes.ts';
import type { Cast } from './validate.ts';

/*
 * npm --prefix ai run fetch -- next | <rank or key> [--again]
 *
 * Downloads a book's file from R2 (read only), checks it's the file the server recorded, and
 * extracts it into ai/work/<key>/ with everything the agent starts from: the text in parts, a cast
 * with the generic speakers (and the cast of another volume in the series, when one exists),
 * empty notes, and the research and ledger templates. Never overwrites the agent's own files.
 */

const EXT = { EPUB: 'epub', PDF: 'pdf', TXT: 'txt', MD: 'md', Text: 'txt' } as const;

async function download(b: QueueBook): Promise<Uint8Array> {
  if (b.sample) return new Uint8Array(readFileSync(join(ROOT, 'frontend/public', b.sample)));
  const env = prodEnv();
  const s3 = new S3Client({
    region: env.S3_REGION || 'auto',
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: env.S3_FORCE_PATH_STYLE !== 'false',
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const res = await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: b.r2Key! }));
  if (!res.Body) throw new Error(`R2 sent nothing for ${b.title}.`);
  return res.Body.transformToByteArray();
}

const GENERIC: Cast['people'] = [
  { id: 'unknown', name: 'A speaker the text doesn’t identify', gender: 'N', generic: true },
  { id: 'unknown-man', name: 'An unidentified man', gender: 'M', generic: true },
  { id: 'unknown-woman', name: 'An unidentified woman', gender: 'F', generic: true },
  { id: 'crowd', name: 'Several people at once', gender: 'N', generic: true },
  {
    id: 'author',
    name: 'The author in their own voice: forewords, notes, afterwords',
    gender: 'N',
    generic: true,
    evidence: 'Set M or F from research on the author, or leave N when unknown.',
  },
];

/** The cast of another volume in the same series, nearest first, to keep everyone's id and voice. */
function seriesCast(b: QueueBook): { cast: Cast; from: QueueBook } | null {
  if (!b.series) return null;
  const same = loadQueue().books.filter(
    (o) => o.sha256 !== b.sha256 && o.series?.toLowerCase() === b.series!.toLowerCase() && existsSync(join(bookDir(o.key), 'cast.json')),
  );
  same.sort((x, y) => Math.abs((x.seriesIndex ?? 0) - (b.seriesIndex ?? 0)) - Math.abs((y.seriesIndex ?? 0) - (b.seriesIndex ?? 0)));
  for (const o of same) {
    try {
      const cast = readJson<Cast>(join(bookDir(o.key), 'cast.json'));
      if (cast.people.some((p) => !p.generic)) return { cast, from: o };
    } catch { /* an unreadable cast is no help */ }
  }
  return null;
}

const RESEARCH = (b: Book) => `# Research: ${b.title}

## The book
- Title and author:
- Series and volume:
- Original language, translator, edition:
- Genre, and fiction or not:
- Narration (first person by whom, third person limited, omniscient, mixed):
- Point of view by chapter:

## Cast
Everyone named, as this edition spells them. Gender with evidence: a paragraph id with a pronoun, or a source.

| id | name in this book | also called | gender | evidence | role |
|---|---|---|---|---|---|

## Traps
Hidden or changing genders, disguises, lookalikes and twins, shared names, unnamed narrators, letters and diaries, speakers who aren't human, honorifics that don't mark gender.

## Known from research, not yet revealed
Never in notes before the paragraph where the book shows it.

## Sources

## Unsure lines
The paragraph, the two readings, and why.

## Warnings kept
Each check warning left in, and why it's right.
`;

const LEDGER = (b: Book) => `# Ledger: ${b.title}

Last part marked: none yet, of ${b.parts.length}.

## The story so far
What a reader knows at the end of the last part marked.

## On stage now
Who is in the current scene, and where.

## Open questions, as the reader sees them

## Voices to remember
Speech habits, who calls whom what, who is disguised as what.
`;

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

  const bytes = await download(b);
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== b.sha256) throw new Error(`The file for ${b.title} doesn’t match what the server recorded. Stop and tell the owner.`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `source.${EXT[b.format]}`), bytes);

  const book = await extract(b.key, b.sha256, bytes, b.format, b.title);
  writeJson(join(dir, 'meta.json'), { parts: book.parts.length, words: book.words, style: book.style });

  let seeded = '';
  if (!existsSync(join(dir, 'cast.json'))) {
    const earlier = seriesCast(b);
    const carried = earlier ? earlier.cast.people.filter((p) => !p.generic) : [];
    writeJson(join(dir, 'cast.json'), { people: [...GENERIC, ...carried] });
    if (earlier) seeded = `cast.json starts with ${carried.length} people from ${earlier.from.title}. Check each one still fits this book.`;
  }
  if (!existsSync(join(dir, 'notes.json'))) writeJson(join(dir, 'notes.json'), { earlier: [], people: [], places: [], terms: [] });
  if (!existsSync(join(dir, 'research.md'))) writeFileSync(join(dir, 'research.md'), RESEARCH(book));
  if (!existsSync(join(dir, 'ledger.md'))) writeFileSync(join(dir, 'ledger.md'), LEDGER(book));
  mkdirSync(join(dir, 'marks'), { recursive: true });

  const toCheck = book.segs.filter((g) => g.note && g.note !== 'runs-on').length + book.stray.length;
  console.log(`Fetched ${b.rank}. ${book.title}${book.author ? ` by ${book.author}` : ''} (${b.format}, ${count(book.words)} words)`);
  console.log(`  Folder: ai/work/${b.key}`);
  console.log(`  Parts: ${book.parts.length} (text/${partName(1)}.md to text/${partName(book.parts.length)}.md)`);
  console.log(`  Quote style: ${STYLE_NAMES[book.style]}. ${count(book.segs.length)} numbered quotes, ${toCheck} paragraphs flagged to check.`);
  if (b.series) console.log(`  Series: ${b.series}${b.seriesIndex != null ? `, number ${b.seriesIndex}` : ''}`);
  if (seeded) console.log(`  ${seeded}`);
  console.log('\nNext: research (procedure.md, part 4, step 2).');
});
