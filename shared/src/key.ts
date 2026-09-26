/** Crockford Base32: no I, L, O or U, so a key can't be misread. */
export const KEY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** The canonical shape: BRDR- plus 20 characters in groups of four (100 bits). */
export const KEY_PATTERN = /^BRDR(-[0-9A-HJKMNP-TV-Z]{4}){5}$/;

export function newLibraryKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let s = '';
  for (const b of bytes) s += KEY_ALPHABET[b & 31];
  return `BRDR-${s.match(/.{4}/g)!.join('-')}`;
}

/**
 * Tidies a typed or pasted key into its canonical form: any case, spaces or dashes, with or
 * without the BRDR prefix, and O, I or L typed for 0 or 1. Returns null when it isn't a key.
 */
export function normalizeKey(input: string): string | null {
  let s = input.toUpperCase().replace(/[\s-]/g, '');
  if (s.startsWith('BRDR')) s = s.slice(4);
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1');
  if (!/^[0-9A-HJKMNP-TV-Z]{20}$/.test(s)) return null;
  return `BRDR-${s.match(/.{4}/g)!.join('-')}`;
}
