/*
 * A zip read in place. What's in it comes from the central directory at its end, and each file is
 * a slice of the original, inflated by the browser when it's compressed. A 300 MB volume of manga
 * never sits in memory whole: only the pages being looked at do.
 */

export interface ZipEntry {
  name: string;
  /** 0 when stored as it is, 8 when deflated. */
  method: number;
  /** Its size inflated, and as stored. */
  size: number;
  packed: number;
  /** Where its local header starts. */
  at: number;
}

const view = async (blob: Blob, from: number, to: number) => new DataView(await blob.slice(from, to).arrayBuffer());
const big = (v: DataView, at: number) => Number(v.getBigUint64(at, true));

/** A name in UTF-8 when the zip says so or it reads as UTF-8, else in the likeliest older encoding. */
function nameOf(bytes: Uint8Array, utf8: boolean): string {
  if (utf8) return new TextDecoder().decode(bytes);
  for (const enc of ['utf-8', 'shift_jis']) {
    try { return new TextDecoder(enc, { fatal: true }).decode(bytes); } catch { /* the next one */ }
  }
  return new TextDecoder('windows-1252').decode(bytes);
}

/** Every file in the zip (folders, and files only a password opens, left out), in the order it lists them. */
export async function listZip(blob: Blob): Promise<ZipEntry[]> {
  const from = Math.max(0, blob.size - (22 + 0xffff));
  const tail = await view(blob, from, blob.size);
  let end = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('Not a zip');
  let count = tail.getUint16(end + 10, true);
  let dirSize = tail.getUint32(end + 12, true);
  let dirAt = tail.getUint32(end + 16, true);
  // Past 4 GB or 65,535 files, the real numbers are in a ZIP64 record found through a locator just before.
  if (count === 0xffff || dirSize === 0xffffffff || dirAt === 0xffffffff) {
    if (end >= 20 && tail.getUint32(end - 20, true) === 0x07064b50) {
      const at = big(tail, end - 20 + 8);
      const rec = await view(blob, at, at + 56);
      if (rec.byteLength === 56 && rec.getUint32(0, true) === 0x06064b50) {
        count = big(rec, 32);
        dirSize = big(rec, 40);
        dirAt = big(rec, 48);
      }
    }
  }
  if (dirAt + dirSize > blob.size) throw new Error('Broken zip');

  const dir = await view(blob, dirAt, dirAt + dirSize);
  const bytes = new Uint8Array(dir.buffer, dir.byteOffset, dir.byteLength);
  const entries: ZipEntry[] = [];
  for (let p = 0, n = 0; n < count && p + 46 <= dir.byteLength && dir.getUint32(p, true) === 0x02014b50; n++) {
    const flags = dir.getUint16(p + 8, true);
    const method = dir.getUint16(p + 10, true);
    let packed = dir.getUint32(p + 20, true);
    let size = dir.getUint32(p + 24, true);
    const nameLen = dir.getUint16(p + 28, true);
    const extraLen = dir.getUint16(p + 30, true);
    const commentLen = dir.getUint16(p + 32, true);
    let at = dir.getUint32(p + 42, true);
    let name = nameOf(bytes.subarray(p + 46, p + 46 + nameLen), (flags & 0x800) !== 0);
    const stop = Math.min(dir.byteLength, p + 46 + nameLen + extraLen);
    for (let e = p + 46 + nameLen; e + 4 <= stop; ) {
      const id = dir.getUint16(e, true);
      const last = Math.min(stop, e + 4 + dir.getUint16(e + 2, true));
      let q = e + 4;
      if (id === 0x0001) {
        // ZIP64 sizes and place: only those too big for the header, in this order.
        if (size === 0xffffffff && q + 8 <= last) { size = big(dir, q); q += 8; }
        if (packed === 0xffffffff && q + 8 <= last) { packed = big(dir, q); q += 8; }
        if (at === 0xffffffff && q + 8 <= last) at = big(dir, q);
      } else if (id === 0x7075 && last - q > 5 && dir.getUint8(q) === 1) {
        // The name again in UTF-8, from zips that wrote the main one in an older encoding.
        name = new TextDecoder().decode(bytes.subarray(q + 5, last));
      }
      e = last;
    }
    p += 46 + nameLen + extraLen + commentLen;
    name = name.replace(/\\/g, '/').replace(/^(\.?\/)+/, '');
    if (flags & 1 || !name || name.endsWith('/')) continue;
    entries.push({ name, method, size, packed, at });
  }
  return entries;
}

const starts = new WeakMap<ZipEntry, number>();

/** Where a file's own bytes start, past its local header. */
async function startOf(blob: Blob, e: ZipEntry): Promise<number> {
  let start = starts.get(e);
  if (start === undefined) {
    const head = await view(blob, e.at, e.at + 30);
    if (head.byteLength < 30 || head.getUint32(0, true) !== 0x04034b50) throw new Error('Broken zip');
    start = e.at + 30 + head.getUint16(26, true) + head.getUint16(28, true);
    starts.set(e, start);
  }
  return start;
}

const inflating = (data: Blob) => data.stream().pipeThrough(new DecompressionStream('deflate-raw'));

/** Whether this browser can inflate a zip's files itself (older ones can't). */
export function canInflate(): boolean {
  try {
    new DecompressionStream('deflate-raw');
    return true;
  } catch {
    return false;
  }
}

/** One file out of the zip, as a Blob of the given type. */
export async function readEntry(blob: Blob, e: ZipEntry, type = ''): Promise<Blob> {
  const start = await startOf(blob, e);
  const data = blob.slice(start, start + e.packed, type);
  if (e.method === 0) return data;
  if (e.method !== 8) throw new Error(`Can't open zip method ${e.method}`);
  return new Response(inflating(data), type ? { headers: { 'Content-Type': type } } : undefined).blob();
}

/** A file's first n bytes (fewer when it's smaller), inflating no more of it than that. */
export async function readStart(blob: Blob, e: ZipEntry, n: number): Promise<Uint8Array> {
  const start = await startOf(blob, e);
  if (e.method === 0) return new Uint8Array(await blob.slice(start, start + Math.min(n, e.packed)).arrayBuffer());
  if (e.method !== 8) throw new Error(`Can't open zip method ${e.method}`);
  const reader = inflating(blob.slice(start, start + e.packed)).getReader();
  const out = new Uint8Array(Math.min(n, e.size));
  let got = 0;
  try {
    while (got < out.length) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.length, out.length - got);
      out.set(value.subarray(0, take), got);
      got += take;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return out.subarray(0, got);
}
