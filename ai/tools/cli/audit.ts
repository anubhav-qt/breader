import type { Span } from '../marks.ts';
import { args, blockAt, blocksOf, cmp, loadBook, plural, main, parsePos, posText, hasText, type Pos } from '../lib.ts';
import { KINDS, validate } from '../validate.ts';

/*
 * npm --prefix ai run audit -- <book> <view>
 *
 * Views of the marks and notes to read back with fresh eyes (procedure.md, part 4, step 4):
 *   part <n>        the part as a script: every line in brackets with its speaker and voice
 *   sample [n]      n random lines (40) with the paragraph before, to check against the text
 *   unsure          every line marked "?"
 *   speaker <id>    every line one person says
 *   cast            everyone, with their voice, their lines and the evidence
 *   notes <s:b>     Revisit as a reader at that paragraph would see it
 */

main(() => {
  const { rest } = args();
  const [key, view = 'sample', arg] = rest;
  if (!key) throw new Error('Which book? npm --prefix ai run audit -- <rank or key> <part n | sample n | unsure | speaker id | cast | notes s:b>');
  const book = loadBook(key);
  const c = validate(book, false);
  const cast = new Map((c.cast?.people ?? []).map((p) => [p.id, p]));
  const flat = (t: string) => t.replace(/\s+/g, ' ').trim();

  const spansAt = new Map<string, Span[]>();
  for (const sp of c.marks.spans) spansAt.set(`${sp.s}:${sp.b}`, [...(spansAt.get(`${sp.s}:${sp.b}`) ?? []), sp]);
  const label = (sp: Span) => `${sp.who} ${c.genderAt(sp.who, [sp.s, sp.b])}${sp.think ? ' thinks' : ''}${sp.unsure ? ' ?' : ''}`;

  /** A paragraph with each line in brackets: ⟦elena F: “You’re late,”⟧ */
  const script = (at: Pos) => {
    const text = blockAt(book, at)?.text ?? '';
    let out = '';
    let i = 0;
    for (const sp of spansAt.get(posText(at)) ?? []) {
      out += `${text.slice(i, sp.start)}⟦${label(sp)}: ${text.slice(sp.start, sp.end)}⟧`;
      i = sp.end;
    }
    return flat(out + text.slice(i));
  };
  const narratorAt = (at: Pos) => {
    const n = [...c.marks.narration].reverse().find((x) => cmp(x.at, at) <= 0);
    if (!n) return 'narrator not set';
    return n.who === 'third' ? `narrator third${n.pov ? `, pov ${n.pov}` : ''}` : `narrator ${n.who} ${c.genderAt(n.who, at)}`;
  };
  /** The text paragraph before one, for context. */
  const before = (at: Pos) => {
    let [s, b] = [at[0], at[1] - 1];
    while (s >= 0) {
      const blocks = book.sections[s].blocks;
      for (; b >= 0; b--) if (hasText(blocks[b].text)) return flat(blocks[b].text);
      s--;
      b = s >= 0 ? book.sections[s].blocks.length - 1 : -1;
    }
    return '';
  };
  const show = (sp: Span) => {
    const at: Pos = [sp.s, sp.b];
    const prev = before(at);
    console.log(`\n${posText(at)}  ${label(sp)}  (${narratorAt(at)}; ${sp.where})`);
    if (prev) console.log(`  before: ${prev.length > 240 ? `…${prev.slice(-240)}` : prev}`);
    console.log(`  ${script(at)}`);
  };

  switch (view) {
    case 'part': {
      const p = book.parts.find((x) => x.n === Number(arg));
      if (!p) throw new Error(`No part ${arg}. This book has ${book.parts.length}.`);
      console.log(`# Part ${p.n} as a script. ${narratorAt(p.from)}.`);
      for (const { at, block } of blocksOf(book, p)) {
        const turn = c.marks.narration.find((n) => cmp(n.at, at) === 0 && cmp(at, p.from) !== 0);
        if (turn) console.log(`\n== from here: ${narratorAt(at)} ==`);
        if (hasText(block.text)) console.log(`\n[${posText(at)}] ${script(at)}`);
      }
      return;
    }
    case 'sample': {
      const n = Number(arg) || 40;
      const pool = [...c.marks.spans];
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      const pick = pool.slice(0, n).sort((a, b) => cmp([a.s, a.b], [b.s, b.b]) || a.start - b.start);
      console.log(`${pick.length} random lines of ${c.marks.spans.length}. Check each speaker against the text.`);
      pick.forEach(show);
      return;
    }
    case 'unsure': {
      const list = c.marks.spans.filter((s) => s.unsure);
      console.log(`${list.length} unsure lines.`);
      list.forEach(show);
      return;
    }
    case 'speaker': {
      const list = c.marks.spans.filter((s) => s.who === arg);
      const p = cast.get(arg ?? '');
      console.log(`${arg}: ${p ? `${p.name}, ${p.gender}` : 'not in cast.json'}. ${plural(list.length)}.`);
      for (const sp of list) console.log(`  ${posText([sp.s, sp.b])}  ${flat(blockAt(book, [sp.s, sp.b])!.text.slice(sp.start, sp.end))}`);
      return;
    }
    case 'cast': {
      const lines = new Map<string, { n: number; first?: Pos }>();
      for (const sp of c.marks.spans) {
        const l = lines.get(sp.who) ?? { n: 0 };
        l.n++;
        l.first ??= [sp.s, sp.b];
        lines.set(sp.who, l);
      }
      const rows = (c.cast?.people ?? []).slice().sort((a, b) => (lines.get(b.id)?.n ?? 0) - (lines.get(a.id)?.n ?? 0));
      for (const p of rows) {
        const l = lines.get(p.id);
        const changes = (p.changes ?? []).map((x) => ` then ${x.gender} from ${x.at}`).join('');
        console.log(`${p.id.padEnd(22)} ${p.gender}${changes}  ${plural(l?.n ?? 0).padStart(11)}${l?.first ? ` from ${posText(l.first)}` : ''}  ${p.name}${p.minor ? ' (minor)' : ''}`);
        if (p.evidence) console.log(`${''.padEnd(24)}evidence: ${p.evidence}`);
      }
      return;
    }
    case 'notes': {
      const at = parsePos(arg ?? '');
      if (!at) throw new Error('Say where the reader is: notes <section:paragraph>, like notes 12:40');
      if (!c.notes) throw new Error('No notes.json yet.');
      console.log(`Revisit for a reader at ${posText(at)}${blockAt(book, at) ? `: "${flat(blockAt(book, at)!.text).slice(0, 80)}"` : ''}`);
      const upTo = <T extends { at: string }>(list: T[] | undefined) => (list ?? []).filter((x) => cmp(parsePos(x.at)!, at) <= 0);
      for (const kind of KINDS) {
        const shown = c.notes[kind].filter((e) => upTo(e.names).length && !(e.merge && cmp(parsePos(e.merge.at)!, at) <= 0));
        console.log(`\n${kind.toUpperCase()} (${shown.length})`);
        for (const e of shown) {
          const names = upTo(e.names).map((x) => x.name);
          const about = upTo(e.about).pop();
          console.log(`\n  ${names[names.length - 1]}${names.length > 1 ? `  (also ${names.slice(0, -1).join(', ')})` : ''}`);
          if (about) console.log(`    ${about.text}`);
          for (const ev of upTo(e.events)) console.log(`    ${ev.at}  ${ev.text}`);
        }
      }
      return;
    }
    default:
      throw new Error(`No view "${view}". Views: part <n>, sample [n], unsure, speaker <id>, cast, notes <s:b>`);
  }
});
