import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Balancer, type Rung } from './balancer.ts';
import { AI, args, bookDir, cmp, count, inPart, loadBook, main, parsePos, partName, posText, readJson, writeJson, type Book, type Gender, type Pos } from './lib.ts';
import type { Msg } from './nim.ts';
import { validate, type Cast } from './validate.ts';

/*
 * npm --prefix ai run mark -- <book> [<book>…]   Marks every part not marked yet, in order, then
 *                                                 remarks any part a fallback model made, settles
 *                                                 the unsure lines and packs the book.
 *   --to <n>        stop after part n
 *   --try <n>       mark part n again beside the marks it has and compare them; changes nothing
 *   --settle        only settle the unsure lines
 *   --no-pack       don't pack at the end
 *
 * The same work as procedure.md, part 4, steps 3 to 5, done by a model through NVIDIA's free API,
 * after research (step 2) is done by hand in Antigravity. Each call gets the rules, the whole book,
 * research.md, the cast so far and the previous part's marks, and answers with a part's marks
 * plus any new people. check runs after every answer, and its errors go back to the model until
 * the part is clean. Kimi K3 marks; Nemotron 3 Ultra takes over only while Kimi is down, and its
 * parts are marked again by Kimi before the book is packed. Who marked each part is kept in
 * marked-by.json. Nothing it prints has the book's text in it.
 */

const LADDER: Rung[] = [
  { model: 'moonshotai/kimi-k3', name: 'kimi-k3', extra: { reasoning_effort: 'high' }, maxTokens: 32_000, maxInFlight: 2 },
  { model: 'nvidia/nemotron-3-ultra-550b-a55b', name: 'nemotron-3-ultra', maxTokens: 32_000, maxInFlight: 2 },
];
const TOP = LADDER[0];
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

const ID = '[a-z0-9]+(?:-[a-z0-9]+)*';
const CAST = new RegExp(`^cast\\s+(${ID})\\s+([MFN])(\\s+minor)?\\s*(?:\\|(.*))?$`);
const CHANGE = new RegExp(`^change\\s+(${ID})\\s+(\\d+:\\d+)\\s+([MFN])\\s*(?:\\|(.*))?$`);

interface Done {
  model: string;
  rounds: number;
  secs: number;
  at: string;
}
type Ledger = Record<string, Done>;

const text = (book: Book, n: number) => readFileSync(join(bookDir(book.key), 'text', `${partName(n)}.md`), 'utf8').trim();
const marksFile = (book: Book, n: number) => join(bookDir(book.key), 'marks', `${partName(n)}.txt`);
const ledgerFile = (book: Book) => join(bookDir(book.key), 'marked-by.json');
const ledger = (book: Book): Ledger => (existsSync(ledgerFile(book)) ? readJson<Ledger>(ledgerFile(book)) : {});
const castOf = (book: Book): Cast => readJson<Cast>(join(bookDir(book.key), 'cast.json'));
const mins = (s: number) => `${(s / 60).toFixed(1)} min`;

function context(book: Book): string {
  const dir = bookDir(book.key);
  const whole = book.parts.filter((p) => p.words > 0).map((p) => text(book, p.n)).join('\n\n');
  const research = existsSync(join(dir, 'research.md')) ? readFileSync(join(dir, 'research.md'), 'utf8').trim() : '(none)';
  return `# The whole book\n\n${whole}\n\n# Research notes\n\n${research}`;
}

function castText(book: Book): string {
  return castOf(book).people.map((p) => {
    const changes = p.changes?.length ? ` (${p.changes.map((c) => `${c.gender} from ${c.at}`).join(', ')})` : '';
    return `${p.id} | ${p.gender}${changes} | ${p.name}${p.role ? ` | ${p.role}` : ''}`;
  }).join('\n');
}

/** The model's cast and change lines, into cast.json. Returns what it did, for the log. */
function mergeCast(book: Book, lines: string[], by: string): { added: number; notes: string[] } {
  const file = join(bookDir(book.key), 'cast.json');
  const cast = castOf(book);
  const byId = new Map(cast.people.map((p) => [p.id, p]));
  const notes: string[] = [];
  let added = 0;
  for (const line of lines) {
    let m = line.match(CAST);
    if (m) {
      const [name, role, evidence] = (m[4] ?? '').split('|').map((s) => s.trim());
      const gender = m[2] as Gender;
      const had = byId.get(m[1]);
      if (!had) {
        const p = { id: m[1], name: name || m[1], gender, ...(role ? { role } : {}), evidence: evidence || `${by}, no paragraph given`, ...(m[3] ? { minor: true } : {}) };
        cast.people.push(p);
        byId.set(p.id, p);
        added++;
      } else if (had.gender === 'N' && !had.generic && gender !== 'N') {
        notes.push(`${had.id} N -> ${gender}`);
        had.gender = gender;
        if (evidence) had.evidence = evidence;
      } else if (had.gender !== gender) {
        notes.push(`${had.id} kept ${had.gender} (the model said ${gender})`);
      }
    } else if ((m = line.match(CHANGE))) {
      const p = byId.get(m[1]);
      const at = parsePos(m[2])!;
      if (!p || p.changes?.some((c) => c.at === m![2])) continue;
      p.changes = [...(p.changes ?? []), { at: m[2], gender: m[3] as Gender, why: m[4]?.trim() || `A reveal, by ${by}.` }].sort((a, b) => cmp(parsePos(a.at)!, parsePos(b.at)!));
      notes.push(`${p.id} changes to ${m[3]} at ${posText(at)}`);
    }
  }
  writeJson(file, cast);
  return { added, notes };
}

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

/** Marks one part, with check after every answer, until it's clean. */
async function markPart(book: Book, n: number, lb: Balancer): Promise<Done> {
  const part = book.parts[n - 1];
  const quotes = book.segs.filter((g) => inPart(part, [g.s, g.b])).length;
  const prev = n > 1 && existsSync(marksFile(book, n - 1)) ? readFileSync(marksFile(book, n - 1), 'utf8').trim() : '';
  const user = [
    context(book),
    `# The cast so far (id | voice | name | role)\n\n${castText(book)}`,
    prev ? `# Marks of part ${n - 1} (done already)\n\n${prev}` : '',
    `# Mark part ${n}\n\nPart ${n} is paragraphs ${posText(part.from)} to ${posText(part.to)}, with ${quotes} numbered quotes. Here it is again:\n\n${text(book, n)}`,
  ].filter(Boolean).join('\n\n');
  const messages: Msg[] = [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }];
  let secs = 0;
  for (let round = 1; round <= ROUNDS; round++) {
    const { reply, rung } = await lb.chat(messages, { book: book.key, part: n, round });
    secs += reply.secs;
    const { marks, cast } = split(reply.text);
    writeFileSync(marksFile(book, n), marks);
    const merged = mergeCast(book, cast, rung.name);
    const errors = errorsFor(book, n);
    const c = validate(book, false);
    const mine = c.marks.spans.filter((sp) => inPart(part, [sp.s, sp.b]));
    console.log(`  part ${n}, round ${round}: ${rung.name}, ${mins(reply.secs)} (${mins(reply.firstS)} before the first token), ${count(reply.promptTokens)} tokens in, ${count(reply.outTokens)} out; ${mine.length} lines, ${mine.filter((s) => s.unsure).length} unsure, ${merged.added} new in the cast${merged.notes.length ? ` (${merged.notes.join('; ')})` : ''}, ${errors.length} errors`);
    if (!errors.length) return { model: rung.name, rounds: round, secs: Math.round(secs), at: new Date().toISOString() };
    messages.push(
      { role: 'assistant', content: reply.text },
      { role: 'user', content: `check found ${errors.length} error${errors.length > 1 ? 's' : ''} in that:\n\n${errors.slice(0, 80).join('\n')}\n\nFix them and send the whole answer again: the full marks file for part ${n}, then the cast lines.` },
    );
  }
  const failed = join(bookDir(book.key), 'failed');
  mkdirSync(failed, { recursive: true });
  renameSync(marksFile(book, n), join(failed, `${partName(n)}.txt`));
  throw new Error(`Part ${n} still has errors after ${ROUNDS} rounds. The last answer is in failed/${partName(n)}.txt; run check to see them.`);
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

/** The pack's "by": who marked which parts. */
function byLine(book: Book): string {
  const l = ledger(book);
  const groups = new Map<string, number[]>();
  for (const p of book.parts.filter((x) => x.words > 0)) {
    const who = l[p.n]?.model ?? 'Antigravity';
    groups.set(who, [...(groups.get(who) ?? []), p.n]);
  }
  const ranges = (ns: number[]) => ns.reduce<string[]>((out, n, i) => {
    if (i && ns[i - 1] === n - 1) out[out.length - 1] = `${out[out.length - 1].split('-')[0]}-${n}`;
    else out.push(String(n));
    return out;
  }, []).join(', ');
  return [...groups].map(([who, ns]) => `${who === TOP.name ? 'Kimi K3 (reasoning high, NVIDIA)' : who} parts ${ranges(ns)}`).join('; ') + '; research by Antigravity';
}

async function runBook(key: string, lb: Balancer, flags: Record<string, string | true>) {
  const book = loadBook(key);
  const tag = book.title;
  const start = validate(book, false).errors;
  if (start.length) throw new Error(`${tag}: check has ${start.length} errors before marking; fix them first. The first: ${start[0]}`);

  if (!flags.settle) {
    const to = typeof flags.to === 'string' ? Number(flags.to) : Infinity;
    for (let c = validate(book, false); c.todo.length && c.todo[0] <= to; c = validate(book, false)) {
      const n = c.todo[0];
      console.log(`${tag}: part ${n} of ${book.parts.length}`);
      const done = await markPart(book, n, lb);
      writeJson(ledgerFile(book), { ...ledger(book), [n]: done });
    }
    if (validate(book, false).todo.length) return console.log(`${tag}: stopped after part ${to}.`);

    // Parts a fallback model made, marked again by the top one (which is waited for, however long).
    const redo = Object.entries(ledger(book)).filter(([, d]) => d.model !== TOP.name).map(([n]) => Number(n));
    if (redo.length) {
      const top = new Balancer([TOP], { waitForTopS: Infinity, strikesToFall: Infinity, maxTries: 40 });
      for (const n of redo) {
        console.log(`${tag}: part ${n} again, with ${TOP.name} (${ledger(book)[n].model} made it)`);
        const old = readFileSync(marksFile(book, n), 'utf8');
        try {
          const done = await markPart(book, n, top);
          writeJson(ledgerFile(book), { ...ledger(book), [n]: done });
        } catch (e) {
          writeFileSync(marksFile(book, n), old);
          throw e;
        }
      }
    }
  }

  console.log(`${tag}: settling unsure lines`);
  await settle(book, lb);
  if (flags['no-pack']) return;
  // Revisit notes come later, for every book at once. Notes that stop partway would show a Revisit
  // that knows only the start, so they wait in notes.partial.json and the book packs without any.
  const notes = join(bookDir(book.key), 'notes.json');
  const partial = validate(book, false).notes;
  if (Object.keys(ledger(book)).length && partial && partial.people.length + partial.places.length + partial.terms.length) {
    renameSync(notes, join(bookDir(book.key), 'notes.partial.json'));
    console.log(`${tag}: its Revisit notes stop partway, so they're kept in notes.partial.json and left out of the pack.`);
  }
  if (!existsSync(notes)) writeJson(notes, { people: [], places: [], terms: [] });
  const final = validate(book, true);
  if (final.errors.length) throw new Error(`${tag}: check --final has ${final.errors.length} errors; not packing. The first: ${final.errors[0]}`);
  execFileSync('npm', ['--prefix', AI, 'run', '--silent', 'pack', '--', book.key, '--by', byLine(book)], { stdio: 'inherit' });
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
    done = await markPart(book, n, lb);
    after = view();
    copyFileSync(file, join(trial, `${partName(n)}.${done.model}.txt`));
  } finally {
    copyFileSync(join(trial, `${partName(n)}.before.txt`), file);
    copyFileSync(join(trial, 'cast.before.json'), castFile);
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
  if (!rest.length) throw new Error('Which book? npm --prefix ai run mark -- <rank or key> [<book>…] [--to n | --try n | --settle | --no-pack]');
  for (const f of ['to', 'try']) if (flags[f] === true || (flags[f] && !/^\d+$/.test(String(flags[f])))) throw new Error(`--${f} needs a part number, like --${f} 3.`);
  const lb = new Balancer(LADDER);
  if (typeof flags.try === 'string') return tryPart(rest[0], Number(flags.try), lb);
  const results = await Promise.allSettled(rest.map((k) => runBook(k, lb, flags)));
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  for (const f of failed) console.error(`\n${f.reason instanceof Error ? f.reason.message : String(f.reason)}`);
  return failed.length ? 1 : 0;
});

