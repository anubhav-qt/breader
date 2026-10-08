import { args, loadBook, main } from '../lib.ts';
import { packBook } from '../pack.ts';

/*
 * npm --prefix ai run pack -- <book> --by "<model>"
 *
 * A finished book, checked in full, as one file for the server: ai/out/<sha256>.json, and a short
 * report for the owner in ai/work/<key>/report.md (pack.ts).
 */

main(() => {
  const { rest, flags } = args();
  if (!rest[0]) throw new Error('Which book? npm --prefix ai run pack -- <rank or key> --by "<model>"');
  if (typeof flags.by !== 'string' || !flags.by.trim()) throw new Error('Say which model made it: --by "<model name and setting>"');
  packBook(loadBook(rest[0]), flags.by.trim());
});
