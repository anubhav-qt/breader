import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/*
 * The NVIDIA key, sealed so it can sit in the public repository and reach the server inside its
 * image (ai/nvidia-key.enc): AES-256-GCM, with a key drawn from the server's ADMIN_TOKEN, which
 * only infra/.env holds. Without that token it's noise. npm --prefix ai run seal makes it.
 */

function keyFrom(token: string): Buffer {
  return Buffer.from(hkdfSync('sha256', token, 'breader', 'nvidia key', 32));
}

export function seal(text: string, token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(token), iv);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

/** The sealed text. Throws when the token isn't the one it was sealed with. */
export function unseal(sealed: string, token: string): string {
  const raw = Buffer.from(sealed, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(token), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  const body = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
  return body.toString('utf8');
}
