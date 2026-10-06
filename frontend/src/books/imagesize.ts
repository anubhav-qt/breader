/*
 * A picture's size from the first bytes of its file, without decoding it: enough to lay out a whole
 * volume of manga before a single page of it has loaded.
 */

export interface Size {
  w: number;
  h: number;
}

const be16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const be32 = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const le16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const le24 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const le32 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

const size = (w: number, h: number): Size | null => (w > 0 && h > 0 && w <= 65_535 && h <= 65_535 ? { w, h } : null);

/** JPEG: the frame header, found by walking the segments before it. */
function jpeg(b: Uint8Array): Size | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0x01 || m === 0xd8 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    if (m === 0xd9 || m === 0xda) return null;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return size(be16(b, i + 7), be16(b, i + 5));
    i += 2 + be16(b, i + 2);
  }
  return null;
}

/** AVIF and HEIF: the largest 'ispe' box, which is the whole picture's (the others are its tiles). */
function ispe(b: Uint8Array): Size | null {
  let best: Size | null = null;
  for (let i = 8; i + 16 <= b.length; i++) {
    if (b[i] !== 0x69 || b[i + 1] !== 0x73 || b[i + 2] !== 0x70 || b[i + 3] !== 0x65) continue;
    const s = size(be32(b, i + 8), be32(b, i + 12));
    if (s && (!best || s.w * s.h > best.w * best.h)) best = s;
  }
  return best;
}

/** The size the file starts by saying, or null when it doesn't (or not in these bytes). */
export function sizeOf(b: Uint8Array): Size | null {
  if (b.length < 24) return null;
  if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && ascii(b, 12, 4) === 'IHDR') return size(be32(b, 16), be32(b, 20));
  if (b[0] === 0xff && b[1] === 0xd8) return jpeg(b);
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP' && b.length >= 30) {
    const chunk = ascii(b, 12, 4);
    if (chunk === 'VP8 ') return size(le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff);
    if (chunk === 'VP8L') return size(1 + (((b[22] & 0x3f) << 8) | b[21]), 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | (b[22] >> 6)));
    if (chunk === 'VP8X') return size(1 + le24(b, 24), 1 + le24(b, 27));
    return null;
  }
  if (ascii(b, 0, 4) === 'GIF8') return size(le16(b, 6), le16(b, 8));
  if (b[0] === 0x42 && b[1] === 0x4d && b.length >= 26) {
    if (le32(b, 14) === 12) return size(le16(b, 18), le16(b, 20));
    return size(Math.abs(le32(b, 18)), Math.abs(le32(b, 22)));
  }
  if (ascii(b, 4, 4) === 'ftyp') return ispe(b);
  return null;
}

/**
 * A picture's size from its start: 64 KB is plenty, except for a JPEG carrying a big photo profile
 * or thumbnail ahead of its frame, which gets one more look further in.
 */
export async function pictureSize(start: (n: number) => Promise<Uint8Array>): Promise<Size | null> {
  for (const n of [64 * 1024, 1024 * 1024]) {
    const b = await start(n);
    const s = sizeOf(b);
    if (s || b.length < n || b[0] !== 0xff || b[1] !== 0xd8) return s;
  }
  return null;
}
