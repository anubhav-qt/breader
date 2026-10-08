import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Balancer } from '../balancer.ts';
import { LADDER, marksLedger as ledger, marksLedgerFile as ledgerFile, mins, PRIMARY, type Done } from '../kimi.ts';
import { args, bookDir, inPart, loadBook, main, partName, posText, type Gender, type Pos } from '../lib.ts';
import { markBook, markParts, marksFile } from '../mark.ts';
import { validate } from '../validate.ts';

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
 * The work itself is mark.ts: Kimi K3 through NVIDIA's free API, after research (step 2) is done
 * by hand in Antigravity.
 */

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
  const results = await Promise.allSettled(rest.map((k) => markBook(k, lb, top, flags)));
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  for (const f of failed) console.error(`\n${f.reason instanceof Error ? f.reason.message : String(f.reason)}`);
  return failed.length ? 1 : 0;
});

