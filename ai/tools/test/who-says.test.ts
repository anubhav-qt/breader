import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renameIds } from '../kimi.ts';
import { nest, type Span } from '../marks.ts';
import { nameIndex, namedIn, wrongTags, type Person } from '../tags.ts';

/*
 * Who says what, from a reader's report on Devils: someone else's words inside a line are cut out
 * into their voice (marks.ts, nest), a line whose tag names someone else is found (tags.ts), and a
 * second id for someone already in the cast becomes theirs (kimi.ts, renameIds).
 */

const span = (start: number, end: number, who: string, via: Span['via'] = 'quote', where = 'marks/0001.txt:2'): Span =>
  ({ s: 1, b: 4, start, end, who, think: false, unsure: false, via, where });

const LINE = '“She told me, ‘never come back,’ and left,” said Marlo.';
const at = (text: string, words: string) => [text.indexOf(words), text.indexOf(words) + words.length] as const;

test('words inside a line are cut out of it, into their own voice', () => {
  const errors: string[] = [];
  const [qa, qz] = at(LINE, '“She told me, ‘never come back,’ and left,”');
  const [wa, wz] = at(LINE, '‘never come back,’');
  const out = nest([span(qa, qz, 'marlo'), span(wa, wz, 'elena', 'words', 'marks/0001.txt:3')], () => LINE, errors);
  assert.deepEqual(errors, []);
  assert.deepEqual(out.map((sp) => [LINE.slice(sp.start, sp.end), sp.who]), [
    ['“She told me, ', 'marlo'],
    ['‘never come back,’', 'elena'],
    [' and left,”', 'marlo'],
  ]);
});

test('several quotes in one line, and a piece with nothing to say goes', () => {
  const text = '“‘Go,’ she said, and then ‘stay.’”';
  const errors: string[] = [];
  const [a1, z1] = at(text, '‘Go,’');
  const [a2, z2] = at(text, '‘stay.’');
  const out = nest([span(0, text.length, 'marlo'), span(a1, z1, 'elena', 'words'), span(a2, z2, 'elena', 'words')], () => text, errors);
  assert.deepEqual(errors, []);
  assert.deepEqual(out.map((sp) => [text.slice(sp.start, sp.end), sp.who]), [
    ['‘Go,’', 'elena'],
    [' she said, and then ', 'marlo'],
    ['‘stay.’', 'elena'],
  ]);
});

test('marks that cross, or the same quote twice, are still errors', () => {
  const errors: string[] = [];
  nest([span(0, 20, 'marlo'), span(10, 30, 'elena', 'words')], () => LINE, errors);
  nest([span(0, 20, 'marlo'), span(0, 20, 'elena', 'words')], () => LINE, errors);
  nest([span(0, 20, 'marlo'), span(5, 10, 'elena', 'quote')], () => LINE, errors);
  assert.equal(errors.length, 3);
  assert.match(errors[0], /wholly inside/);
});

const PEOPLE: Person[] = [
  { id: 'unknown-woman', name: 'An unidentified woman', generic: true },
  { id: 'shatov', name: 'Ivan Shatov' },
  { id: 'marya-lebyadkina', name: 'Marya Timofeyevna Lebyadkina' },
  { id: 'marya-shatova', name: 'Marya Shatova' },
  { id: 'liza', name: 'Lizaveta Nikolaevna Tushina', names: [{ name: 'Liza' }] },
];

test('names: full names, the first two words, and words only one person has', () => {
  const index = nameIndex(PEOPLE);
  assert.deepEqual([...index.get('marya timofeyevna')!], ['marya-lebyadkina']);
  assert.deepEqual([...index.get('shatov')!], ['shatov']);
  assert.equal(index.has('marya'), false, 'two people are Marya');
  assert.deepEqual([...namedIn('Marya Timofeyevna suddenly laughed.', index)], ['marya-lebyadkina']);
  assert.deepEqual([...namedIn('Marya Timofeyevna looked up.', index)], [], 'no speaking word');
  assert.deepEqual([...namedIn('she said to Shatov.', index)], [], 'Shatov is spoken to');
  assert.deepEqual([...namedIn('said Liza’s mother.', index)], [], 'Liza’s mother isn’t Liza');
  assert.deepEqual([...namedIn('She was sent for Shatov, and insisted on seeing', index)], [], 'and starts a new part of the sentence');
  assert.deepEqual([...namedIn('he suddenly asked Shatov.', index)], [], 'asked Shatov is asking him');
  assert.deepEqual([...namedIn('Madame Shatov exclaimed.', index)], [], 'Madame Shatov isn’t Shatov');
  const sister = nameIndex([{ id: 'arina', name: 'Arina Prokhorovna' }, { id: 'sister', name: 'Madame Virginskaya’s sister' }, { id: 'me', name: 'Anton', names: [{ name: 'I' }] }]);
  assert.deepEqual([...namedIn('Madame Virginskaya asked.', sister)], [], 'a name about someone else stands only whole');
  assert.deepEqual([...namedIn('I said.', sister)], [], 'a name of one letter');
});

test('a line whose tag names someone else is found, the right ones are not', () => {
  const text = '“Ah, you’re still on about my lackey!” Marya Timofeyevna suddenly laughed. “You’re afraid of him!”';
  const [a1, z1] = at(text, '“Ah, you’re still on about my lackey!”');
  const [a2, z2] = at(text, '“You’re afraid of him!”');
  const wrong = wrongTags([span(a1, z1, 'shatov'), span(a2, z2, 'shatov')], () => text, PEOPLE);
  assert.deepEqual(wrong.map((t) => [t.span.start, t.names]), [[a1, ['marya-lebyadkina']], [a2, ['marya-lebyadkina']]]);
  assert.deepEqual(wrongTags([span(a1, z1, 'marya-lebyadkina'), span(a2, z2, 'marya-lebyadkina')], () => text, PEOPLE), []);
  assert.deepEqual(wrongTags([span(a1, z1, 'unknown-woman')], () => text, PEOPLE), [], 'an unknown voice before a reveal');
});

test('a second tag in the paragraph is the next line’s, not this one’s', () => {
  const text = '“Go,” said Liza. Shatov rose and answered, “No.”';
  const [a1, z1] = at(text, '“Go,”');
  const [a2, z2] = at(text, '“No.”');
  assert.deepEqual(wrongTags([span(a1, z1, 'liza'), span(a2, z2, 'shatov')], () => text, PEOPLE), []);
  const swapped = wrongTags([span(a1, z1, 'shatov'), span(a2, z2, 'liza')], () => text, PEOPLE);
  assert.deepEqual(swapped.map((t) => t.names), [['liza'], ['shatov']]);
});

test('a second id for someone in the cast is swapped in the marks, words in quotes kept', () => {
  const same = new Map([['lebyadkina-marya', 'marya-lebyadkina']]);
  const marks = ['narrator third', '12:226.1 lebyadkina-marya ?', '12:5 "lebyadkina-marya said" lebyadkina-marya think', '12:40 narrator lebyadkina-marya', '12:7.1 shatov'].join('\n');
  assert.equal(renameIds(marks, same), ['narrator third', '12:226.1 marya-lebyadkina ?', '12:5 "lebyadkina-marya said" marya-lebyadkina think', '12:40 narrator marya-lebyadkina', '12:7.1 shatov'].join('\n'));
});
