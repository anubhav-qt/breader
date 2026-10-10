import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Balancer } from './balancer.ts';
import { castText, context, LADDER, marksLedger as ledger, marksLedgerFile as ledgerFile, mergeCast, mins, notesDone, packBy, PRIMARY, text } from './kimi.ts';
import { AI, bookDir, count, inPart, loadBook, partName, posText, writeJson, type Book } from './lib.ts';
import type { Msg } from './nim.ts';
import { packBook } from './pack.ts';
import { validate } from './validate.ts';

/*
 * Voice marks by a model through NVIDIA's free API: the same work as procedure.md, part 4, steps 3
 * to 5, after research (step 2), whether Antigravity did it by hand or cast.ts read the cast from
 * the book. Each call gets the rules, the whole book, research.md, the cast so far and the
 * previous part's marks if there are any, and answers with a part's marks plus any new people.
 * Every part goes at once, since the whole book is there to read. Then check, and a call to fix
 * every part with errors together, again and again while each leaves fewer. Kimi K3 marks the
 * parts; Nemotron 3 Ultra takes over only while it's down, and its parts are marked again by Kimi
 * before the book is packed. Who marked each part is kept in marked-by.json. Nothing it prints
 * has the book's text in it.
 */

const PROC = readFileSync(join(AI, 'procedure.md'), 'utf8');
const between = (from: string, to: string) => PROC.slice(PROC.indexOf(from), PROC.indexOf(to));
const RULES = [between('## 5. Voice marks', '## 6. Revisit notes'), between('### 7.1 The text files', '### 7.3 `cast.json`')].join('\n').trim();

const SYSTEM = `You mark who speaks every line of a novel, one part at a time, so the Breader e-reader can read it aloud with two voices, one male and one female. Listeners never see the marks, they only hear them, and a wrong voice on a line is heard by everyone. Accuracy matters more than speed.

You get the marking rules, the whole book, the book's research notes, the cast so far, the previous part's marks (done already), and the part to mark.

The whole book is there so anything in it can settle who speaks a line. What it can't change is how a line sounds: a person sounds the way the reader believes at that line, and a voice the reader can't identify yet keeps an unknown id until the reveal (rules 5.2 and 5.4).

Answer with the marks file for the part and nothing else: no commentary, no code fences. After the marks, add one line for each person who isn't in the cast yet:
cast gate-guard M | A guard at the north gate | Guards the north gate | 7:22 "he"
That is the id, the voice (M, F or N), then name | role | evidence, where evidence is the paragraph where the book shows their gender, or where you know it from. Put minor after the voice for someone with only a line or two. Use the cast's id whenever the person is in it already. If a reveal changes how someone sounds, add a line at the reveal's paragraph:
change masked-knight 40:12 F | Unmasks as a woman
You can't write research.md, so where the rules say to write why you're unsure, just add the ?.

# Rules

${RULES}`;

/** A line a marks answer has: a mark, the narrator, a rest, a comment, a cast line, or a fix's part heading. */
const MARK_LINE = /^(\d+:\d+|narrator\b|rest\b|#|cast\s|change\s|=+\s*part\s)/i;
/** A mark is a short line: a longer one that starts like one is something else. */
const LONGEST_MARK = 300;
/** How much of an answer, in characters, comes in before it can be called garbled. */
const JUDGED_FROM = 2000;

/**
 * Why an answer isn't marks, or null when it is: most of its lines have to be lines a marks
 * answer has. Now and then Kimi K3 answers a part with thousands of tokens of nonsense in every
 * script, so an answer is judged as it comes in (nim.ts), and one like that is stopped and asked
 * again (balancer.ts).
 */
export function garbled(text: string, whole: boolean): string | null {
  const lines = text.split(/\r?\n/);
  // The last line may not be finished yet.
  if (!whole) lines.pop();
  let chars = 0;
  let all = 0;
  let marks = 0;
  for (const raw of lines) {
    const line = raw.trim().replace(/^[-*]\s+/, '');
    if (!line || /^```/.test(line)) continue;
    chars += line.length;
    all++;
    if (MARK_LINE.test(line) && line.length <= LONGEST_MARK) marks++;
  }
  if (!whole && chars < JUDGED_FROM) return null;
  if (marks * 2 >= all) return null;
  return `a garbled answer: ${marks} of its ${all} lines read as marks`;
}

export const marksFile = (book: Book, n: number) => join(bookDir(book.key), 'marks', `${partName(n)}.txt`);

/** What markBook is doing for each book, by key, once its parts are marked: for the marker's live view. */
export const stageOf = new Map<string, string>();

/** An answer split into the marks file and the cast lines. */
function split(answer: string) {
  const marks: string[] = [];
  const cast: string[] = [];
  for (const raw of answer.split(/\r?\n/)) {
    const t = raw.trim().replace(/^[-*]\s+(?=\d|narrator|rest)/, '');
    if (!t || /^```/.test(t)) continue;
    if (/^(cast|change)\s/.test(t)) cast.push(t);
    else marks.push(t);
  }
  return { marks: `${marks.join('\n')}\n`, cast };
}

/** check's errors that are about part n, or the cast. */
function errorsFor(book: Book, n: number): string[] {
  const name = `marks/${partName(n)}.txt`;
  return validate(book, false).errors.filter((e) => e.startsWith(name) || e.startsWith('cast.json') || (e.startsWith('not in cast.json') && e.includes(name)));
}

/** What the model gets to mark part n, the book cut down to `level` (kimi.ts, context). */
function partPrompt(book: Book, n: number, level: number): Msg[] {
  const part = book.parts[n - 1];
  const quotes = book.segs.filter((g) => inPart(part, [g.s, g.b])).length;
  const prev = n > 1 && existsSync(marksFile(book, n - 1)) ? readFileSync(marksFile(book, n - 1), 'utf8').trim() : '';
  const user = [
    context(book, n, level),
    `# The cast so far (id | voice | name | role)\n\n${castText(book)}`,
    prev ? `# Marks of part ${n - 1} (done already)\n\n${prev}` : '',
    `# Mark part ${n}\n\nPart ${n} is paragraphs ${posText(part.from)} to ${posText(part.to)}, with ${quotes} numbered quotes. Here it is again:\n\n${text(book, n)}`,
  ].filter(Boolean).join('\n\n');
  return [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }];
}

function linesIn(book: Book, n: number): string {
  const part = book.parts[n - 1];
  const spans = validate(book, false).marks.spans.filter((sp) => inPart(part, [sp.s, sp.b]));
  return `${spans.length} lines, ${spans.filter((s) => s.unsure).length} unsure`;
}

/** Who made part n's marks, saved as soon as they're written, so a stopped run picks up where it was. */
function stamp(book: Book, n: number, model: string, secs: number, fresh: boolean) {
  const l = ledger(book);
  const d = fresh ? undefined : l[n];
  writeJson(ledgerFile(book), { ...l, [n]: { model, rounds: (d?.rounds ?? 0) + 1, secs: Math.round((d?.secs ?? 0) + secs), at: new Date().toISOString() } });
}

/**
 * Marks parts all at once, a call each, then fixes every part with errors together (fixParts),
 * along with any in `alsoFix` (parts a stopped run left with errors). Returns the parts that
 * failed: no answer, or errors still. A failed part's marks file is left as it is, for the caller.
 */
export async function markParts(book: Book, ns: number[], lb: Balancer, alsoFix: number[] = []): Promise<number[]> {
  const answered: number[] = [];
  const answers = await Promise.allSettled(ns.map(async (n) => {
    const { reply, rung } = await lb.chat((level) => partPrompt(book, n, level), { book: book.key, part: n, round: 1 }, garbled);
    const { marks, cast } = split(reply.text);
    writeFileSync(marksFile(book, n), marks);
    const merged = mergeCast(book, cast, rung.name);
    stamp(book, n, rung.name, reply.secs, true);
    answered.push(n);
    console.log(`  part ${n}: ${rung.name}, ${mins(reply.secs)} (${mins(reply.firstS)} before the first token), ${count(reply.promptTokens)} tokens in, ${count(reply.outTokens)} out; ${linesIn(book, n)}, ${merged.added} new in the cast${merged.notes.length ? ` (${merged.notes.join('; ')})` : ''}, ${errorsFor(book, n).length} errors`);
  }));
  answers.forEach((a, i) => {
    if (a.status === 'rejected') console.log(`  part ${ns[i]}: no answer (${a.reason instanceof Error ? a.reason.message : String(a.reason)})`);
  });
  const all = [...new Set([...alsoFix, ...answered])].sort((a, b) => a - b);
  await fixParts(book, all, lb);
  return [...ns, ...alsoFix].filter((n) => !all.includes(n) || errorsFor(book, n).length);
}

/**
 * One call for every part check found errors in, with their marks and the errors, to fix them
 * together, then another for whatever is left, for as long as each round leaves fewer errors. A
 * part's fixed marks are kept only when they have fewer errors than before.
 */
async function fixParts(book: Book, ns: number[], lb: Balancer) {
  for (let round = 2; ; round++) {
    const bad = ns.filter((n) => errorsFor(book, n).length);
    if (!bad.length) return;
    stageOf.set(book.key, `Fixing what the check found (round ${round - 1})`);
    const sections = bad.map((n) => {
      const errors = errorsFor(book, n);
      return `## Part ${n}\n\nIts marks:\n${readFileSync(marksFile(book, n), 'utf8').trim()}\n\ncheck's ${errors.length === 1 ? 'error' : `${errors.length} errors`}:\n${errors.slice(0, 80).join('\n')}`;
    });
    const user = (level: number) => [
      context(book, bad[0], level),
      `# The cast so far (id | voice | name | role)\n\n${castText(book)}`,
      `# Fix these\n\ncheck found errors in the marks of ${bad.length === 1 ? 'this part' : `these ${bad.length} parts`}. Fix them, and send back the whole fixed marks file for each part, each starting with a line like:\n=== part ${bad[0]} ===\nThen the cast lines for anyone new.\n\n${sections.join('\n\n')}`,
    ].join('\n\n');
    let answer;
    try {
      answer = await lb.chat((level) => [{ role: 'system', content: SYSTEM }, { role: 'user', content: user(level) }], { book: book.key, fix: bad.join(','), round }, garbled);
    } catch (e) {
      console.log(`  fix, round ${round}: no answer (${e instanceof Error ? e.message : String(e)})`);
      return;
    }
    const { reply, rung } = answer;
    const byPart = new Map<number, string[]>();
    const castLines: string[] = [];
    let at: number | null = null;
    for (const raw of reply.text.split(/\r?\n/)) {
      const t = raw.trim();
      const h = t.match(/^=+\s*part\s+(\d+)\s*=+$/i);
      if (h) { at = Number(h[1]); byPart.set(at, []); }
      else if (/^(cast|change)\s/.test(t)) castLines.push(t);
      else if (at !== null) byPart.get(at)!.push(raw);
    }
    const before = new Map(bad.map((n) => [n, errorsFor(book, n).length]));
    mergeCast(book, castLines, rung.name);
    for (const [n, body] of byPart) {
      if (!bad.includes(n)) continue;
      const old = readFileSync(marksFile(book, n), 'utf8');
      writeFileSync(marksFile(book, n), split(body.join('\n')).marks);
      if (errorsFor(book, n).length < before.get(n)!) {
        stamp(book, n, rung.name, reply.secs, false);
      } else {
        writeFileSync(marksFile(book, n), old);
      }
    }
    console.log(`  fix, round ${round}: ${rung.name}, ${mins(reply.secs)}, parts ${bad.join(', ')}; errors left: ${bad.map((n) => `part ${n} ${errorsFor(book, n).length}`).join(', ')}`);
    let was = 0;
    let left = 0;
    for (const n of bad) {
      was += before.get(n)!;
      left += errorsFor(book, n).length;
    }
    if (left >= was) return;
  }
}

/** Every line marked "?", read again against the whole book in one call. */
async function settle(book: Book, lb: Balancer) {
  const c = validate(book, false);
  const unsure = c.marks.spans.filter((s) => s.unsure);
  if (!unsure.length) return console.log('  No unsure lines.');
  const lineOf = (where: string) => {
    const [file, n] = where.split(':');
    return { file: join(bookDir(book.key), file), n: Number(n) };
  };
  const items = unsure.map((sp, i) => {
    const { file, n } = lineOf(sp.where);
    return { i: i + 1, file, n, line: readFileSync(file, 'utf8').split(/\r?\n/)[n - 1].trim() };
  });
  const user = (level: number) => [
    context(book, null, level),
    `# The cast (id | voice | name | role)\n\n${castText(book)}`,
    `# Settle these\n\nThese ${items.length} marks are unsure. Read each one's paragraph again, with everything the book says around it, and decide. Answer with one line per item, its number and then the mark, fixed or kept, with ? only if two readings still fit:\nU1 12:2.1 marlo\nAnswer with those lines only, plus cast lines for anyone new.\n\n${items.map((x) => `U${x.i} ${x.line}`).join('\n')}`,
  ].join('\n\n');
  const { reply, rung } = await lb.chat((level) => [{ role: 'system', content: SYSTEM }, { role: 'user', content: user(level) }], { book: book.key, settle: items.length });
  // The last answer, to see why lines stayed unsure. Marks and cast lines only, never the book's text.
  writeFileSync(join(bookDir(book.key), 'settle-answer.txt'), reply.text);
  const files = [...new Set(items.map((x) => x.file))];
  const before = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
  const lines = new Map(files.map((f) => [f, before.get(f)!.split(/\r?\n/)]));
  const castLines: string[] = [];
  let changed = 0;
  let settled = 0;
  for (const raw of reply.text.split(/\r?\n/)) {
    const t = raw.trim();
    if (/^(cast|change)\s/.test(t)) { castLines.push(t); continue; }
    const m = t.match(/^U(\d+)[:.]?\s+(.+)$/);
    const item = m && items[Number(m[1]) - 1];
    if (!item) continue;
    // The answer has to be about the same quote, or the same paragraph for one added by its words.
    const same = (a: string) => a.match(/^(\d+:\d+(?:\.\d+)?)/)?.[1];
    if (same(m[2]) !== same(item.line)) continue;
    if (m[2] !== item.line) changed++;
    if (!/\s\?(\s|$)|\?$/.test(m[2])) settled++;
    lines.get(item.file)![item.n - 1] = m[2];
  }
  for (const f of files) writeFileSync(f, lines.get(f)!.join('\n'));
  const cast = join(bookDir(book.key), 'cast.json');
  const castBefore = readFileSync(cast, 'utf8');
  mergeCast(book, castLines, rung.name);
  const errors = validate(book, false).errors;
  if (errors.length) {
    for (const f of files) writeFileSync(f, before.get(f)!);
    writeFileSync(cast, castBefore);
    console.log(`  ${rung.name}'s answer made ${errors.length} errors, so it was left out. The first: ${errors[0]}`);
    return;
  }
  console.log(`  ${rung.name} settled ${settled} of ${items.length} unsure lines, ${changed} of them changed, in ${mins(reply.secs)}.`);
}

/**
 * Marks every part of a book not marked yet, remarks the parts a fallback model made, settles the
 * unsure lines and packs it. flags: to (stop after part n), settle (only settle), no-pack.
 */
export async function markBook(key: string, lb: Balancer, top: Balancer, flags: Record<string, string | true>) {
  const book = loadBook(key);
  const tag = book.title;
  stageOf.set(key, 'Checking the marks');
  // Parts a stopped run left with errors go straight to the fix. A part that failed for good last
  // time leaves a gap, which check calls skipped: both are fine here.
  const broken = Object.keys(ledger(book)).map(Number).filter((n) => existsSync(marksFile(book, n)) && errorsFor(book, n).length);
  const mine = new Set(broken.map((n) => `marks/${partName(n)}.txt`));
  const start = validate(book, false).errors.filter((e) => !e.startsWith('parts skipped') && ![...mine].some((m) => e.includes(m)));
  if (start.length) throw new Error(`${tag}: check has ${start.length} errors before marking; fix them first. The first: ${start[0]}`);

  if (!flags.settle) {
    const to = typeof flags.to === 'string' ? Number(flags.to) : Infinity;
    const todo = validate(book, false).todo.filter((n) => n <= to);
    if (todo.length || broken.length) {
      if (broken.length) console.log(`${tag}: parts ${broken.join(', ')} have errors from last time, and get fixed with the rest`);
      if (todo.length) console.log(`${tag}: marking parts ${todo.join(', ')}, all at once`);
      const failed = await markParts(book, todo, lb, broken);
      if (failed.length) {
        const dir = join(bookDir(book.key), 'failed');
        mkdirSync(dir, { recursive: true });
        for (const n of failed) if (existsSync(marksFile(book, n))) renameSync(marksFile(book, n), join(dir, `${partName(n)}.txt`));
        throw new Error(`${tag}: parts ${failed.join(', ')} failed (their last answers are in failed/). Run mark again to retry just those.`);
      }
    }
    if (validate(book, false).todo.length) return console.log(`${tag}: stopped after part ${to}.`);

    // Parts a fallback model made, marked again by a primary one. Some parts they keep answering empty
    // (a scene they won't touch), so after a few tries those keep the fallback's marks and the book packs.
    // A model taken off the ladder since (DeepSeek, in Vol. 9 of Mushoku) was a primary then: its parts stay.
    const fallbacks = LADDER.filter((r) => !r.primary).map((r) => r.name);
    const redo = Object.entries(ledger(book)).filter(([, d]) => fallbacks.includes(d.model)).map(([n]) => Number(n));
    const who = PRIMARY.map((r) => r.name).join(' or ');
    if (redo.length) {
      console.log(`${tag}: parts ${redo.join(', ')} again, with ${who}`);
      stageOf.set(key, `Marking again the ${redo.length} parts the backup model did`);
      const old = new Map(redo.map((n) => [n, readFileSync(marksFile(book, n), 'utf8')]));
      const oldLedger = ledger(book);
      const failed = await markParts(book, redo, top);
      for (const n of failed) writeFileSync(marksFile(book, n), old.get(n)!);
      if (failed.length) {
        writeJson(ledgerFile(book), { ...ledger(book), ...Object.fromEntries(failed.map((n) => [n, oldLedger[n]])) });
        console.log(`${tag}: ${who} couldn't redo parts ${failed.join(', ')}, so they keep the fallback's marks.`);
      }
    }
  }

  console.log(`${tag}: settling unsure lines`);
  stageOf.set(key, 'Settling unsure lines (1 of 2)');
  await settle(book, lb);
  // Now and then a settle answer decides almost none of them, and the same question again decides
  // nearly all (Mushoku Vol. 12: 0 of 18, then 17 of 18). So whatever is left gets a second go.
  stageOf.set(key, 'Settling unsure lines (2 of 2)');
  await settle(book, lb);
  if (flags['no-pack']) return;
  stageOf.set(key, 'Saving');
  // Revisit notes come from notes, for the whole book. Other notes that stop partway would show a
  // Revisit that knows only the start, so they wait in notes.partial.json and the book packs without any.
  const notes = join(bookDir(book.key), 'notes.json');
  const partial = validate(book, false).notes;
  if (Object.keys(ledger(book)).length && !notesDone(book) && partial && partial.people.length + partial.places.length + partial.terms.length) {
    renameSync(notes, join(bookDir(book.key), 'notes.partial.json'));
    console.log(`${tag}: its Revisit notes stop partway, so they're kept in notes.partial.json and left out of the pack.`);
  }
  if (!existsSync(notes)) writeJson(notes, { people: [], places: [], terms: [] });
  const final = validate(book, true);
  if (final.errors.length) throw new Error(`${tag}: check --final has ${final.errors.length} errors; not packing. The first: ${final.errors[0]}`);
  packBook(book, packBy(book));
}
