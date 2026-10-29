/*
 * A PDF made of pictures, one to a page, the page as big as its picture in points. A JPEG goes in as
 * it is (a PDF reader inflates those itself); any other picture is drawn on a canvas and kept as a
 * JPEG. The file is a list of Blob parts, so a whole series never sits in memory as one piece, and
 * the pictures come one at a time.
 */

const be16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];

interface Jpeg {
  data: Blob;
  w: number;
  h: number;
  /** How a PDF names its colours: grey, or red green blue. */
  space: '/DeviceGray' | '/DeviceRGB';
}

/** A JPEG's size and colours, when a PDF can hold it as it is: baseline or progressive, grey or RGB. */
function jpegOf(data: Blob, b: Uint8Array): Jpeg | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { i += 2; continue; }
    if (m === 0xd9 || m === 0xda) return null;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      const w = be16(b, i + 7);
      const h = be16(b, i + 5);
      const parts = b[i + 9];
      // Only the frames every reader opens; CMYK and the rest are drawn and kept again.
      if (m > 0xc2 || !w || !h || (parts !== 1 && parts !== 3)) return null;
      return { data, w, h, space: parts === 1 ? '/DeviceGray' : '/DeviceRGB' };
    }
    i += 2 + be16(b, i + 2);
  }
  return null;
}

/** The most pixels drawn at once: past about 16 million, phones' canvases give up. */
const MAX_PIXELS = 16_000_000;

/** A picture drawn on white and kept as a JPEG. */
async function redrawn(blob: Blob): Promise<Jpeg> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (img.naturalWidth * img.naturalHeight)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser can’t turn pictures into JPEGs.');
    // Transparent pages are white on paper.
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const out = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/jpeg', 0.92));
    const jpeg = out && jpegOf(out, new Uint8Array(await out.arrayBuffer()));
    // Freed now, as Safari keeps a canvas's memory until it's collected.
    canvas.width = canvas.height = 0;
    if (!jpeg) throw new Error('A page couldn’t be turned into a JPEG.');
    return jpeg;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A picture as a JPEG for the PDF. */
async function jpegFor(blob: Blob): Promise<Jpeg> {
  return jpegOf(blob, new Uint8Array(await blob.arrayBuffer())) ?? redrawn(blob);
}

/** A title as a PDF string: UTF-16 in hex, so any name fits. */
function pdfString(s: string): string {
  let hex = 'FEFF';
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, '0');
  return `<${hex}>`;
}

/**
 * A PDF of `count` pictures, `picture(i)` being the i-th, `onPage` told as each is in. Object 1 is
 * the catalogue, 2 the page list, 3 the title; page i is then three objects: the page, what it
 * draws, and its picture.
 */
export async function makePdf(count: number, picture: (i: number) => Promise<Blob>, title: string, onPage?: (done: number) => void): Promise<Blob> {
  const text = new TextEncoder();
  const parts: BlobPart[] = [];
  const offsets: number[] = [];
  let at = 0;
  const put = (s: string | Uint8Array | Blob) => {
    const b = typeof s === 'string' ? text.encode(s) : s;
    parts.push(b);
    at += b instanceof Blob ? b.size : b.length;
  };
  const object = (id: number, body: string) => {
    offsets[id] = at;
    put(`${id} 0 obj\n${body}\nendobj\n`);
  };
  const FIRST = 4;
  const pageId = (i: number) => FIRST + i * 3;

  // The comment of high bytes tells programs this file isn't text.
  put(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Count ${count} /Kids [${Array.from({ length: count }, (_, i) => `${pageId(i)} 0 R`).join(' ')}] >>`);
  object(3, `<< /Title ${pdfString(title)} /Producer ${pdfString('Breader')} >>`);

  for (let i = 0; i < count; i++) {
    const { data, w, h, space } = await jpegFor(await picture(i));
    const id = pageId(i);
    object(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`);
    const draw = `q ${w} 0 0 ${h} 0 0 cm /Im Do Q`;
    object(id + 1, `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
    offsets[id + 2] = at;
    put(`${id + 2} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace ${space} /BitsPerComponent 8 /Filter /DCTDecode /Length ${data.size} >>\nstream\n`);
    put(data);
    put('\nendstream\nendobj\n');
    onPage?.(i + 1);
  }

  const size = FIRST + count * 3;
  const xref = at;
  let table = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id++) table += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  put(`${table}trailer\n<< /Size ${size} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}
