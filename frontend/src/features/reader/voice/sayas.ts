import { useSyncExternalStore } from 'react';
import { SAY_AS } from '@breader/shared/limits';
import { readSetting, writeSetting } from '../settings';

/*
 * Words said the reader's way. Pick some text while a voice reads and say how it should sound
 * (chrome/SayAs.tsx): from then on every voice says it that way, in every book. Kept with the
 * reader settings, so the list follows the reader to their other browsers and nobody else hears it.
 */

const NAME = 'sayAs';

/** The same words however they're typed: lower case, one kind of apostrophe, single spaces. */
export const normal = (text: string) => text.normalize('NFC').toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').trim();

type Table = Record<string, string>;

let table: Table = {};
let find: RegExp | null = null;
const subs = new Set<() => void>();

const escape = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function load() {
  const saved = readSetting(NAME);
  table = saved && typeof saved === 'object' ? { ...(saved as Table) } : {};
  // Longest first, so "Mr Darcy" wins over "Darcy".
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  const alts = keys.map((k) => [...k].map((c) => (c === "'" ? "['‘’ʼ]" : c === ' ' ? '\\s+' : escape(c))).join(''));
  find = alts.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.join('|')})(?![\\p{L}\\p{N}])`, 'giu') : null;
  subs.forEach((f) => f());
}
if (typeof window !== 'undefined') {
  load();
  window.addEventListener('breader:settings', load);
  window.addEventListener('storage', load);
}

/** How the reader says this, if they said. */
export const sayAsFor = (text: string): string | undefined => table[normal(text)];

export const useSayAs = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => table);

/** Keeps how to say some text; nothing, or the text itself, forgets it. The oldest go past the limit. */
export function setSayAs(text: string, say: string) {
  const key = normal(text);
  const value = say.replace(/\s+/g, ' ').trim().slice(0, SAY_AS.sayChars);
  if (!key) return;
  const next = { ...table };
  delete next[key];
  if (value && normal(value) !== key) next[key] = value;
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - SAY_AS.most))) delete next[k];
  writeSetting(NAME, next);
}

/** A stretch of the text said differently, and how many letters' time the new way takes. */
export interface Swap { start: number; end: number; len: number }

/** The text as the voice should say it, and where it changed. */
export function respell(text: string): { said: string; swaps: Swap[] } {
  if (!find) return { said: text, swaps: [] };
  const swaps: Swap[] = [];
  let said = '';
  let from = 0;
  find.lastIndex = 0;
  for (let m = find.exec(text); m; m = find.exec(text)) {
    const say = table[normal(m[0])];
    if (!say) continue;
    said += text.slice(from, m.index) + say;
    from = m.index + m[0].length;
    swaps.push({ start: m.index, end: from, len: say.length });
  }
  return { said: said + text.slice(from), swaps };
}
