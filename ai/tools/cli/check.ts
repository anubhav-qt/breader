import { args, count, loadBook, main, partName } from '../lib.ts';
import { validate } from '../validate.ts';

/*
 * npm --prefix ai run check -- <book> [--final]
 *
 * How a book stands: parts marked, quotes, cast, notes, and every error (fix before going on) and
 * warning (fix, or keep and say why in research.md). --final also wants every part marked.
 */

main(() => {
  const { rest, flags } = args();
  if (!rest[0]) throw new Error('Which book? npm --prefix ai run check -- <rank or key> [--final]');
  const book = loadBook(rest[0]);
  const c = validate(book, !!flags.final);
  const { marks } = c;
  const withWords = book.parts.filter((p) => p.words > 0).length;

  console.log(`${book.title} (${book.key})`);
  console.log(
    c.todo.length
      ? `Parts marked: ${withWords - c.todo.length} of ${withWords}. Next: part ${c.todo[0]} (text/${partName(c.todo[0])}.md)`
      : `Parts marked: all ${withWords}.`,
  );
  const numbered = marks.spans.filter((s) => s.via === 'quote').length;
  const words = marks.spans.filter((s) => s.via === 'words').length;
  const unsure = marks.spans.filter((s) => s.unsure).length;
  const think = marks.spans.filter((s) => s.think).length;
  console.log(
    `Lines: ${count(marks.spans.length)} spoken (${count(numbered)} numbered quotes, ${count(words)} added by their words, ${count(think)} thoughts), ${count(marks.notSpeech)} quotes not speech, ${count(unsure)} unsure.`,
  );
  if (c.cast) {
    const g = { M: 0, F: 0, N: 0 };
    for (const p of c.cast.people) g[p.gender]++;
    console.log(`Cast: ${c.cast.people.length} (M ${g.M}, F ${g.F}, N ${g.N}).`);
  }
  if (c.notes) {
    const events = [...c.notes.people, ...c.notes.places, ...c.notes.terms].reduce((n, e) => n + (e.events?.length ?? 0), 0);
    console.log(`Notes: ${c.notes.people.length} people, ${c.notes.places.length} places, ${c.notes.terms.length} terms, ${events} events.`);
  }

  const list = (title: string, items: string[]) => {
    if (!items.length) return;
    console.log(`\n${title} (${items.length}):`);
    for (const i of items.slice(0, 200)) console.log(`  ${i}`);
    if (items.length > 200) console.log(`  and ${items.length - 200} more`);
  };
  list('Errors', c.errors);
  list('Warnings', c.warnings);
  if (!c.errors.length && !c.warnings.length) console.log('\nNo errors, no warnings.');
  return c.errors.length ? 1 : 0;
});
