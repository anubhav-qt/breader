import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Balancer } from './balancer.ts';
import { castText, context, LADDER, marksLedger as ledger, marksLedgerFile as ledgerFile, mergeCast, mins, notesDone, packBy, PRIMARY, text, type Done } from './kimi.ts';
import { AI, args, bookDir, count, inPart, loadBook, main, partName, posText, writeJson, type Book, type Gender, type Pos } from './lib.ts';
import type { Msg } from './nim.ts';
import { validate } from './validate.ts';

/*
 * npm --prefix ai run mark -- <book> [<book>…]   Marks every part not marked yet, all at once,
 *                                                 then remarks any part a fallback model made,
 *                                                 settles the unsure lines and packs the book.
 *   --to <n>        stop after part n
 *   --try <n>       mark part n again beside the marks it has and compare them; changes nothing
 *   --settle        only settle the unsure lines
 *   --no-pack       don't pack at the end
 *   --with <model>  only that model (kimi-k3, nemotron-3-ultra), say with --try
 *
 * The same work as procedure.md, part 4, steps 3 to 5, done by a model through NVIDIA's free API,
 * after research (step 2) is done by hand in Antigravity. Each call gets the rules, the whole book,
 * research.md, the cast so far and the previous part's marks if there are any, and answers with
 * a part's marks plus any new people. Every part goes at once, since the whole book is there to
 * read. Then check, and one call to fix every part with errors together. Kimi K3 marks the parts;
 * Nemotron 3 Ultra takes over only while it's down, and its parts are marked again by Kimi before
 * the book is packed. Who marked each part is kept in
 * marked-by.json. Nothing it prints has the book's text in it.
 */

const ROUNDS = 3;

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

const marksFile = (book: Book, n: number) => join(bookDir(book.key), 'marks', `${partName(n)}.txt`);

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

/** What the model gets to mark part n. */
function partPrompt(book: Book, n: number): Msg[] {
  const part = book.parts[n - 1];
  const quotes = book.segs.filter((g) => inPart(part, [g.s, g.b])).length;
  const prev = n > 1 && existsSync(marksFile(book, n - 1)) ? readFileSync(marksFile(book, n - 1), 'utf8').trim() : '';
  const user = [
    context(book),
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
async function markParts(book: Book, ns: number[], lb: Balancer, alsoFix: number[] = []): Promise<number[]> {
  const answered: number[] = [];
  const answers = await Promise.allSettled(ns.map(async (n) => {
    const { reply, rung } = await lb.chat(partPrompt(book, n), { book: book.key, part: n, round: 1 });
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
 * together, and another if some are left (ROUNDS calls in all, counting the first).
 */
async function fixParts(book: Book, ns: number[], lb: Balancer) {
  for (let round = 2; round <= ROUNDS; round++) {
    const bad = ns.filter((n) => errorsFor(book, n).length);
    if (!bad.length) return;
    const sections = bad.map((n) => {
      const errors = errorsFor(book, n);
      return `## Part ${n}\n\nIts marks:\n${readFileSync(marksFile(book, n), 'utf8').trim()}\n\ncheck's ${errors.length === 1 ? 'error' : `${errors.length} errors`}:\n${errors.slice(0, 80).join('\n')}`;
    });
    const user = [
      context(book),
      `# The cast so far (id | voice | name | role)\n\n${castText(book)}`,
      `# Fix these\n\ncheck found errors in the marks of ${bad.length === 1 ? 'this part' : `these ${bad.length} parts`}. Fix them, and send back the whole fixed marks file for each part, each starting with a line like:\n=== part ${bad[0]} ===\nThen the cast lines for anyone new.\n\n${sections.join('\n\n')}`,
    ].join('\n\n');
    let answer;
    try {
      answer = await lb.chat([{ role: 'system', content: SYSTEM }, { role: 'user', content: user }], { book: book.key, fix: bad.join(','), round });
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
    for (const [n, body] of byPart) {
      if (!bad.includes(n)) continue;
      writeFileSync(marksFile(book, n), split(body.join('\n')).marks);
      stamp(book, n, rung.name, reply.secs, false);
    }
    mergeCast(book, castLines, rung.name);
    console.log(`  fix, round ${round}: ${rung.name}, ${mins(reply.secs)}, parts ${bad.join(', ')}; errors left: ${bad.map((n) => `part ${n} ${errorsFor(book, n).length}`).join(', ')}`);
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
  const user = [
    context(book),
    `# The cast (id | voice | name | role)\n\n${castText(book)}`,
    `# Settle these\n\nThese ${items.length} marks are unsure. Read each one's paragraph again, with everything the book says around it, and decide. Answer with one line per item, its number and then the mark, fixed or kept, with ? only if two readings still fit:\nU1 12:2.1 marlo\nAnswer with those lines only, plus cast lines for anyone new.\n\n${items.map((x) => `U${x.i} ${x.line}`).join('\n')}`,
  ].join('\n\n');
  const { reply, rung } = await lb.chat([{ role: 'system', content: SYSTEM }, { role: 'user', content: user }], { book: book.key, settle: items.length });
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

async function runBook(key: string, lb: Balancer, top: Balancer, flags: Record<string, string | true>) {
  const book = loadBook(key);
  const tag = book.title;
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
    const redo = Object.entries(ledger(book)).filter(([, d]) => !PRIMARY.some((r) => r.name === d.model)).map(([n]) => Number(n));
    const who = PRIMARY.map((r) => r.name).join(' or ');
    if (redo.length) {
      console.log(`${tag}: parts ${redo.join(', ')} again, with ${who}`);
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
  await settle(book, lb);
  if (flags['no-pack']) return;
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
  execFileSync('npm', ['--prefix', AI, 'run', '--silent', 'pack', '--', book.key, '--by', packBy(book)], { stdio: 'inherit' });
}

/** Marks part n again beside the marks it has, compares, and puts everything back. */
async function tryPart(key: string, n: number, lb: Balancer) {
  const book = loadBook(key);
  const dir = bookDir(book.key);
  const file = marksFile(book, n);
  if (!existsSync(file)) throw new Error(`Part ${n} has no marks to compare with.`);
  const trial = join(dir, 'try');
  mkdirSync(trial, { recursive: true });
  const castFile = join(dir, 'cast.json');
  copyFileSync(file, join(trial, `${partName(n)}.before.txt`));
  copyFileSync(castFile, join(trial, 'cast.before.json'));
  const ledgerBefore = existsSync(ledgerFile(book)) ? readFileSync(ledgerFile(book), 'utf8') : null;
  const part = book.parts[n - 1];
  const view = () => {
    const c = validate(book, false);
    const spans = c.marks.spans.filter((sp) => inPart(part, [sp.s, sp.b]));
    return { spans, narr: c.marks.narration.filter((x) => inPart(part, x.at)).map((x) => `${posText(x.at)} ${x.who}${x.pov ? ` pov ${x.pov}` : ''}`), voice: (who: string, at: Pos) => c.genderAt(who, at) };
  };
  const before = view();
  let after: ReturnType<typeof view>;
  let done: Done;
  rmSync(file);
  try {
    if ((await markParts(book, [n], lb)).length) throw new Error(`Part ${n} failed; the book's marks are as they were.`);
    done = ledger(book)[n];
    after = view();
    copyFileSync(file, join(trial, `${partName(n)}.${done.model}.txt`));
  } finally {
    copyFileSync(join(trial, `${partName(n)}.before.txt`), file);
    copyFileSync(join(trial, 'cast.before.json'), castFile);
    if (ledgerBefore === null) rmSync(ledgerFile(book), { force: true });
    else writeFileSync(ledgerFile(book), ledgerBefore);
  }

  const key2 = (s: { s: number; b: number; start: number; end: number }) => `${s.s}:${s.b}:${s.start}:${s.end}`;
  const theirs = new Map(after.spans.map((s) => [key2(s), s]));
  const sound = (g: Gender) => (g === 'N' ? 'narrator' : g);
  let same = 0;
  let sameVoice = 0;
  let missing = 0;
  const differ: string[] = [];
  for (const s of before.spans) {
    const t = theirs.get(key2(s)) ?? after.spans.find((x) => x.s === s.s && x.b === s.b && x.start < s.end && s.start < x.end);
    if (!t) { missing++; differ.push(`${posText([s.s, s.b])} before ${s.who}, now not speech`); continue; }
    if (t.who === s.who) same++;
    const a = sound(before.voice(s.who, [s.s, s.b]));
    const b = sound(after.voice(t.who, [t.s, t.b]));
    if (a === b) sameVoice++;
    else differ.push(`${posText([s.s, s.b])} before ${s.who} (${a}), now ${t.who} (${b})${t.unsure ? ' ?' : ''}`);
  }
  const extra = after.spans.filter((t) => !before.spans.some((s) => s.s === t.s && s.b === t.b && s.start < t.end && t.start < s.end));
  for (const t of extra) differ.push(`${posText([t.s, t.b])} before not speech, now ${t.who}`);
  const pct = (a: number) => `${((100 * a) / Math.max(1, before.spans.length)).toFixed(1)}%`;
  console.log(`\nPart ${n}: ${done.model} in ${done.rounds} round${done.rounds > 1 ? 's' : ''}, ${mins(done.secs)}.`);
  console.log(`Lines before: ${before.spans.length}. Now: ${after.spans.length}.`);
  console.log(`Same speaker: ${same} (${pct(same)}). Same voice: ${sameVoice} (${pct(sameVoice)}). Before speech, now not: ${missing}. New speech: ${extra.length}.`);
  console.log(`Narrator: ${before.narr.join(', ') === after.narr.join(', ') ? 'same' : `before ${before.narr.join(', ')}; now ${after.narr.join(', ')}`}.`);
  if (differ.length) console.log(`\nDifferent voice:\n${differ.map((d) => `  ${d}`).join('\n')}`);
  console.log(`\nBoth files are in ${join('ai/work', book.key, 'try')}; the book's own marks and cast are as they were.`);
}

main(async () => {
  const { rest, flags } = args();
  if (!rest.length) throw new Error('Which book? npm --prefix ai run mark -- <rank or key> [<book>…] [--to n | --try n | --settle | --no-pack] [--with model]');
  for (const f of ['to', 'try']) if (flags[f] === true || (flags[f] && !/^\d+$/.test(String(flags[f])))) throw new Error(`--${f} needs a part number, like --${f} 3.`);
  const only = flags.with ? LADDER.filter((r) => r.name === flags.with) : LADDER;
  if (!only.length) throw new Error(`--with takes one of ${LADDER.map((r) => r.name).join(', ')}.`);
  const lb = new Balancer(only);
  if (typeof flags.try === 'string') return tryPart(rest[0], Number(flags.try), lb);
  // Redoing a fallback's parts never falls back itself. One for every book, so books marked
  // together share its count of calls in flight and its cooldowns, as they share lb's.
  const top = new Balancer(PRIMARY, { waitForTopS: Infinity, strikesToFall: Infinity, maxTries: 6 });
  const results = await Promise.allSettled(rest.map((k) => runBook(k, lb, top, flags)));
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  for (const f of failed) console.error(`\n${f.reason instanceof Error ? f.reason.message : String(f.reason)}`);
  return failed.length ? 1 : 0;
});

