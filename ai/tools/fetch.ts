import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { AiFile } from '../../shared/src/ai.ts';
import { prodEnv } from './env.ts';
import { extract } from './extract.ts';
import { bookDir, loadQueue, OUT, readJson, ROOT, writeJson, type Book, type QueueBook } from './lib.ts';
import type { Cast } from './validate.ts';

/*
 * Fetching a book: its file from R2 (read only), checked against what the server recorded, and
 * extracted into ai/work/<key>/ with everything the work starts from: the text in parts, a cast
 * with the generic speakers (and the cast of another volume in the series, when one exists),
 * empty notes, and the research and ledger templates. Never overwrites files already there.
 */

const EXT = { EPUB: 'epub', PDF: 'pdf', TXT: 'txt', MD: 'md', Text: 'txt' } as const;

export async function download(b: QueueBook): Promise<Uint8Array> {
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

export const GENERIC: Cast['people'] = [
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

/** A cast.json from a book's file on the server, for a book marked somewhere else. */
export function castFromFile(f: AiFile): Cast {
  const generic = new Map(GENERIC.map((p) => [p.id, p]));
  const people = f.voices.cast.map((c) => {
    const g = generic.get(c.id);
    if (g) return { ...g, gender: c.g };
    const changes = (c.changes ?? []).map(([s, b, gender]) => ({ at: `${s}:${b}`, gender, why: 'As marked.' }));
    return { id: c.id, name: c.name, gender: c.g, evidence: 'From its marks on the server.', ...(changes.length ? { changes } : {}) };
  });
  return { people };
}

/** Everyone but the generic speakers in another volume's cast: its cast.json here, or its file from the server. */
function castOfVolume(o: QueueBook): Cast['people'] {
  const file = join(bookDir(o.key), 'cast.json');
  if (existsSync(file)) return readJson<Cast>(file).people.filter((p) => !p.generic);
  const out = join(OUT, `${o.sha256}.json`);
  if (existsSync(out)) return castFromFile(readJson<AiFile>(out)).people.filter((p) => !p.generic);
  return [];
}

/** The cast of another volume in the same series, nearest first, to keep everyone's id and voice. */
function seriesCast(b: QueueBook): { people: Cast['people']; from: QueueBook } | null {
  if (!b.series) return null;
  const same = loadQueue().books.filter((o) => o.sha256 !== b.sha256 && o.series?.toLowerCase() === b.series!.toLowerCase());
  same.sort((x, y) => Math.abs((x.seriesIndex ?? 0) - (b.seriesIndex ?? 0)) - Math.abs((y.seriesIndex ?? 0) - (b.seriesIndex ?? 0)));
  for (const o of same) {
    try {
      const people = castOfVolume(o);
      if (people.length) return { people, from: o };
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

/**
 * Downloads and extracts a book, and starts its folder. `seeded` says where its cast came from,
 * when it came from another volume.
 */
export async function fetchBook(b: QueueBook): Promise<{ book: Book; seeded: string }> {
  const dir = bookDir(b.key);
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
    const carried = earlier ? earlier.people : [];
    writeJson(join(dir, 'cast.json'), { people: [...GENERIC, ...carried] });
    if (earlier) seeded = `cast.json starts with ${carried.length} people from ${earlier.from.title}. Check each one still fits this book.`;
  }
  if (!existsSync(join(dir, 'notes.json'))) writeJson(join(dir, 'notes.json'), { earlier: [], people: [], places: [], terms: [] });
  if (!existsSync(join(dir, 'research.md'))) writeFileSync(join(dir, 'research.md'), RESEARCH(book));
  if (!existsSync(join(dir, 'ledger.md'))) writeFileSync(join(dir, 'ledger.md'), LEDGER(book));
  mkdirSync(join(dir, 'marks'), { recursive: true });
  return { book, seeded };
}
