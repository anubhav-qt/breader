import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Balancer } from './balancer.ts';
import { castByFile, castOf, castText, isCastLine, mergeCast, mins, wholeBook, type Done } from './kimi.ts';
import { AI, blockAt, bookDir, parsePos, writeJson, type Book } from './lib.ts';
import { validate } from './validate.ts';

/*
 * Research from the book alone, for a book no one researched by hand: what the marker does in
 * place of procedure.md, part 4, step 2. One call reads the whole book and answers with notes for
 * research.md (the narration, every name each person goes by, the traps, identities the book
 * hides and where it shows them) and a cast line for everyone, with the paragraph where the book
 * shows their gender. mark.ts then starts from both, as it would from Antigravity's. Who did it
 * goes in cast-by.json, which is how the marker knows it's done. Nothing it prints has the book's
 * text in it.
 */

const PROC = readFileSync(join(AI, 'procedure.md'), 'utf8');
const between = (from: string, to: string) => PROC.slice(PROC.indexOf(from), PROC.indexOf(to));
const RULES = [between('### 5.2 Finding the speaker', '### 5.5 Group scenes'), between('### 7.3 `cast.json`', '### 7.4 `notes.json`')].join('\n').trim();

const SYSTEM = `You get a novel ready for voice marking in the Breader e-reader, which reads books aloud with two voices, one male and one female. Another model then marks who speaks every line, part by part, starting from what you write. You have the whole book and nothing else: no web, and no other volumes beyond the people already in the cast. A wrong voice is heard on every line that person speaks, so accuracy matters more than speed.

# The rules the marking follows

${RULES}`;

const TASK = `Read the whole book, then answer in two parts and nothing else: no commentary, no code fences.

First, research notes for whoever marks it, in markdown, under these headings:
## The book: the genre, fiction or not, and the narration (first person by whom, third person through whose eyes, or mixed), chapter by chapter where it changes.
## Names: everyone named, with every name, nickname and title the book uses for them, spelled as this book spells them.
## Traps: hidden or changing genders, disguises, lookalikes and twins, shared names, unnamed narrators, letters and diaries, speakers who aren't human, honorifics that don't mark gender.
## Hidden identities: anyone the book later reveals to be someone else, or other than they seemed, and the paragraph where it does.

Then a line for everyone who speaks or is named, and isn't in the cast yet:
cast elena F | Elena Voss | Courier; narrates the odd chapters | 3:14 "she said"
That is the id, the voice (M, F or N), then name | role | evidence, where evidence is the paragraph where the book shows their gender, with the word that shows it. Put minor after the voice for someone with only a line or two. Leave a voice N only when the book never shows one (rule 5.4). Everyone already in the cast keeps their id and voice. If a reveal changes how someone sounds, add a line at the reveal's paragraph:
change masked-knight 40:12 F | Unmasks as a woman`;

/** Changes at a paragraph the book doesn't have can't be marked from, so they go. */
function dropBadChanges(book: Book): number {
  const cast = castOf(book);
  let dropped = 0;
  for (const p of cast.people) {
    if (!p.changes) continue;
    const kept = p.changes.filter((c) => blockAt(book, parsePos(c.at)!)?.text.trim());
    dropped += p.changes.length - kept.length;
    if (kept.length) p.changes = kept;
    else delete p.changes;
  }
  if (dropped) writeJson(join(bookDir(book.key), 'cast.json'), cast);
  return dropped;
}

/** Reads the book's cast and writes research.md, as Antigravity would from the web. */
export async function castPass(book: Book, lb: Balancer) {
  const user = [
    `# The whole book\n\n${wholeBook(book)}`,
    `# The cast so far (id | voice | name | role)\n\n${castText(book)}`,
    `# Your task\n\n${TASK}`,
  ].join('\n\n');
  const { reply, rung } = await lb.chat([{ role: 'system', content: SYSTEM }, { role: 'user', content: user }], { book: book.key, cast: 'pass' });

  const castLines: string[] = [];
  const notes: string[] = [];
  for (const raw of reply.text.split(/\r?\n/)) {
    const t = raw.trim().replace(/^[-*]\s+/, '');
    if (isCastLine(t)) castLines.push(t);
    else if (!/^```/.test(t)) notes.push(raw);
  }
  const research = notes.join('\n').trim();
  writeFileSync(join(bookDir(book.key), 'research.md'), `# Research: ${book.title}\n\nFrom the book alone, by ${rung.name}, with no web research.\n\n${research}\n`);

  const merged = mergeCast(book, castLines, rung.name);
  const dropped = dropBadChanges(book);
  const errors = validate(book, false).errors.filter((e) => e.startsWith('cast.json'));
  if (errors.length) throw new Error(`${book.title}: the cast from the book has ${errors.length} errors. The first: ${errors[0]}`);

  const done: Done = { model: rung.name, rounds: 1, secs: Math.round(reply.secs), at: new Date().toISOString() };
  writeJson(castByFile(book), done);
  const people = castOf(book).people.filter((p) => !p.generic).length;
  console.log(`${book.title}: cast read from the book by ${rung.name} in ${mins(reply.secs)}; ${people} people, ${merged.added} of them new${dropped ? `; ${dropped} changes at paragraphs the book doesn't have left out` : ''}`);
}
