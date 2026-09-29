import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { args, bookDir, count, loadBook, main, OUT, parsePos, plural, posText, writeJson, type Pos } from './lib.ts';
import { KINDS, validate, type Entry } from './validate.ts';

/*
 * npm --prefix ai run pack -- <book> --by "<model>"
 *
 * A finished book, checked in full, as one file for the server: ai/out/<sha256>.json. The server
 * keeps it and gives it out by the book's file, never showing the marks to anyone (the voice only
 * hears them). Positions are [section, block]; a span is characters [start, end) of that block's
 * text, exactly as the reader's text has them. sections[i] is that chapter's block count and hash
 * (lib.ts fingerprint), so the app can tell a chapter parsed differently and leave its marks alone.
 */

/** Straight quotes curled, the way the site writes them. */
const curl = (t: string) =>
  t
    .replace(/(^|[\s([{—-])"/g, '$1“')
    .replace(/"/g, '”')
    .replace(/(^|[\s([{—-])'/g, '$1‘')
    .replace(/'/g, '’');

const at = (s: string): Pos => parsePos(s)!;

main(() => {
  const { rest, flags } = args();
  if (!rest[0]) throw new Error('Which book? npm --prefix ai run pack -- <rank or key> --by "<model>"');
  if (typeof flags.by !== 'string' || !flags.by.trim()) throw new Error('Say which model made it: --by "<model name and setting>"');
  const book = loadBook(rest[0]);
  const c = validate(book, true);
  if (c.errors.length) {
    console.error(`${c.errors.length} errors. Run check -- ${book.key} --final and fix them first.`);
    return 1;
  }
  const cast = c.cast!;
  const notes = c.notes!;
  const index = new Map(cast.people.map((p, i) => [p.id, i]));

  const entry = (e: Entry) => ({
    id: e.id,
    names: e.names.map((n) => [...at(n.at), curl(n.name)]),
    about: e.about.map((t) => [...at(t.at), curl(t.text)]),
    events: (e.events ?? []).map((t) => [...at(t.at), curl(t.text)]),
    ...(e.merge ? { merge: [...at(e.merge.at), e.merge.into] } : {}),
  });

  const spans = c.marks.spans.map((sp) => [sp.s, sp.b, sp.start, sp.end, c.genderAt(sp.who, [sp.s, sp.b]), index.get(sp.who)!, sp.think ? 1 : 0]);
  const out = {
    v: 1,
    sha256: book.sha256,
    title: book.title,
    author: book.author,
    format: book.format,
    words: book.words,
    made: new Date().toISOString(),
    by: flags.by.trim(),
    sections: book.sections.map((s) => s.print),
    revisit: Object.fromEntries(KINDS.map((k) => [k, notes[k].map(entry)])),
    voices: {
      cast: cast.people.map((p) => ({
        id: p.id,
        name: p.name,
        g: p.gender,
        ...(p.changes?.length ? { changes: p.changes.map((x) => [...at(x.at), x.gender]) } : {}),
      })),
      /** [section, block, narrator (cast index, or -1 for a narrator who isn't a character), point of view (cast index or -1)] */
      narration: c.marks.narration.map((n) => [...n.at, n.who === 'third' ? -1 : index.get(n.who)!, n.pov ? index.get(n.pov)! : -1]),
      /** [section, block, start, end, voice M/F/N, speaker (cast index), a thought 1/0] */
      spans,
    },
  };
  const file = join(OUT, `${book.sha256}.json`);
  writeJson(file, out);

  // A short report for the owner.
  const g = { M: 0, F: 0, N: 0 };
  for (const sp of spans) g[sp[4] as 'M' | 'F' | 'N']++;
  const lines = new Map<string, number>();
  for (const sp of c.marks.spans) lines.set(sp.who, (lines.get(sp.who) ?? 0) + 1);
  const top = [...lines].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const unsure = c.marks.spans.filter((s) => s.unsure);
  const report = [
    `# ${book.title}`,
    '',
    `Packed ${out.made.slice(0, 10)} by ${out.by}. ${count(book.words)} words, ${plural(book.parts.length, 'part')}.`,
    '',
    `Lines: ${count(spans.length)} (M ${count(g.M)}, F ${count(g.F)}, N ${count(g.N)}), ${c.marks.notSpeech} quotes not speech, ${unsure.length} unsure.`,
    `Notes: ${notes.people.length} people, ${notes.places.length} places, ${notes.terms.length} terms.`,
    `Warnings kept: ${c.warnings.length} (reasons in research.md).`,
    '',
    '## Most lines',
    ...top.map(([id, n]) => `- ${id} (${cast.people[index.get(id)!]?.gender ?? '?'}): ${n}`),
    '',
    '## Unsure',
    ...(unsure.length ? unsure.map((s) => `- ${posText([s.s, s.b])} ${s.who}: ${book.sections[s.s].blocks[s.b].text.slice(s.start, s.end).replace(/\s+/g, ' ').slice(0, 100)}`) : ['None.']),
    '',
  ].join('\n');
  writeFileSync(join(bookDir(book.key), 'report.md'), report);

  console.log(`Packed ${book.title}: ai/out/${book.sha256}.json`);
  console.log(`Lines ${count(spans.length)} (M ${g.M}, F ${g.F}, N ${g.N}), unsure ${unsure.length}, notes ${notes.people.length + notes.places.length + notes.terms.length} entries, warnings kept ${c.warnings.length}.`);
  console.log(`Report: ai/work/${book.key}/report.md`);
  return 0;
});
