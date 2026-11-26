import sharp from 'sharp';

/*
 * A shared book's cover as its card shows it: small enough to come at once, sharp enough on a
 * phone's screen. The same image for every reader, so Cloudflare keeps one copy near them all.
 */

/** The largest a small cover is, each way: a card on a phone at 3x is under this. */
const WIDTH = 600;
const HEIGHT = 900;
const QUALITY = 80;

/** The cover made small, as WebP, turned the way its camera meant; null when it isn't a picture. */
export async function smallCover(original: Buffer): Promise<Buffer | null> {
  try {
    const made = sharp(original)
      .rotate()
      .resize({ width: WIDTH, height: HEIGHT, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: QUALITY });
    return await made.toBuffer();
  } catch {
    return null;
  }
}
