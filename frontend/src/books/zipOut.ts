/*
 * A zip made of files stored as they are, which is all a CBZ needs, as pictures are packed already.
 * The file is a list of Blob parts, so a whole series never sits in memory as one piece, and the
 * files come one at a time. Plain zip, not ZIP64: past 4 GB or 65,535 files it says so.
 */

const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipFile {
  name: string;
  data: Blob;
}

/** A zip of `count` files, `file(i)` being the i-th, `onFile` told as each is in. */
export async function makeZip(count: number, file: (i: number) => Promise<ZipFile>, onFile?: (done: number) => void): Promise<Blob> {
  if (count > 0xfffe) throw new Error('This has too many pages for one CBZ.');
  const text = new TextEncoder();
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((Math.max(1980, now.getFullYear()) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts: BlobPart[] = [];
  const listing: Uint8Array[] = [];
  let at = 0;
  let listed = 0;

  for (let i = 0; i < count; i++) {
    const { name, data } = await file(i);
    const crc = crc32(new Uint8Array(await data.arrayBuffer()));
    const label = text.encode(name);
    // The header of the file, and the same again for the list at the end, which also says where it is.
    const head = new DataView(new ArrayBuffer(30));
    const entry = new DataView(new ArrayBuffer(46));
    for (const [v, base] of [[head, 4], [entry, 6]] as const) {
      v.setUint16(base, 20, true);
      v.setUint16(base + 2, 0x0800, true);
      v.setUint16(base + 4, 0, true);
      v.setUint16(base + 6, time, true);
      v.setUint16(base + 8, date, true);
      v.setUint32(base + 10, crc, true);
      v.setUint32(base + 14, data.size, true);
      v.setUint32(base + 18, data.size, true);
      v.setUint16(base + 22, label.length, true);
    }
    head.setUint32(0, 0x04034b50, true);
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint32(42, at, true);
    parts.push(new Uint8Array(head.buffer), label, data);
    at += 30 + label.length + data.size;
    if (at > 0xffffffff) throw new Error('This is too big for one CBZ.');
    const row = new Uint8Array(46 + label.length);
    row.set(new Uint8Array(entry.buffer));
    row.set(label, 46);
    listing.push(row);
    listed += row.length;
    onFile?.(i + 1);
  }

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, count, true);
  end.setUint16(10, count, true);
  end.setUint32(12, listed, true);
  end.setUint32(16, at, true);
  parts.push(...listing, new Uint8Array(end.buffer));
  return new Blob(parts, { type: 'application/vnd.comicbook+zip' });
}
