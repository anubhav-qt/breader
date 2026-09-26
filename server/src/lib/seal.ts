import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/*
 * An account library's key is kept sealed (AES-256-GCM), so its owner can see it in the Key dialog
 * from any browser they log in to. The sealing key is derived from KEY_PEPPER, which never leaves
 * the servers' settings; a copy of the database alone can't open it. Key-only libraries keep only
 * the key's hash, as before: nobody but the reader holds their key.
 */

const sealingKey = (pepper: string) => Buffer.from(hkdfSync('sha256', pepper, 'breader', 'library key sealing', 32));

export function seal(plain: string, pepper: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', sealingKey(pepper), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1.${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url')}`;
}

/** The sealed text, or null if it isn't one this pepper sealed. */
export function unseal(sealed: string | null, pepper: string): string | null {
  if (!sealed?.startsWith('v1.')) return null;
  try {
    const raw = Buffer.from(sealed.slice(3), 'base64url');
    const d = createDecipheriv('aes-256-gcm', sealingKey(pepper), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
