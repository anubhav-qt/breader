import JSZip from 'jszip';

/*
 * The Test Lantern: a small made-up book (no one's real books), as an EPUB, with a cast, notes and
 * marks that pass check. selftest and the tests in this folder use it.
 */

const XHTML = (title: string, body: string) =>
  `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body>${body}</body></html>`;

export async function epub(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file(
    'META-INF/container.xml',
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>The Test Lantern</dc:title><dc:creator>A. Tester</dc:creator><dc:identifier id="id">selftest</dc:identifier></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`,
  );
  zip.file(
    'OEBPS/nav.xhtml',
    `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>nav</title></head><body><nav epub:type="toc"><ol><li><a href="ch1.xhtml">Chapter One</a></li><li><a href="ch2.xhtml">Chapter Two</a></li></ol></nav></body></html>`,
  );
  zip.file(
    'OEBPS/ch1.xhtml',
    XHTML('1', `
<h1>Chapter One</h1>
<p>Elena came to Ferrow in the rain.</p>
<p>“You’re late,” said Marlo. “The ferry left.”</p>
<p>“The trains,” she said. “Don’t start.”</p>
<p>He called it a “shortcut” and laughed.</p>
<p>“It was a long winter,</p>
<p>“and nobody came,” Elena finished.</p>
<p>I should never have come back, Elena thought.</p>`),
  );
  zip.file(
    'OEBPS/ch2.xhtml',
    XHTML('2', `
<h1>Chapter Two</h1>
<p>The masked knight rode in at dawn.</p>
<p>“Stand aside,” the knight said.</p>
<p>The knight took off the mask. It was Ines, Marlo’s sister.</p>
<p>“Brother,” Ines said.</p>`),
  );
  return zip.generateAsync({ type: 'uint8array' });
}

export const CAST = {
  people: [
    { id: 'unknown', name: 'A speaker the text doesn’t identify', gender: 'N', generic: true },
    { id: 'elena', name: 'Elena', gender: 'F', evidence: '0:3 “she said”' },
    { id: 'marlo', name: 'Marlo', gender: 'M', evidence: '0:4 “He called it”' },
    { id: 'masked-knight', name: 'The masked knight', gender: 'M', evidence: '1:1, as the reader believes', changes: [{ at: '1:3', gender: 'F', why: 'Unmasked as Ines.' }] },
    { id: 'ines', name: 'Ines', gender: 'F', evidence: '1:3' },
  ],
};

export const NOTES = {
  earlier: [],
  people: [
    {
      id: 'elena',
      names: [{ at: '0:1', name: 'Elena' }],
      about: [{ at: '0:1', text: 'A traveller who comes to Ferrow in the rain.' }],
      events: [{ at: '0:3', text: 'Arrives late because of the trains.' }],
    },
    {
      id: 'masked-knight',
      names: [{ at: '1:1', name: 'The masked knight' }],
      about: [{ at: '1:1', text: 'A knight who hides behind a mask.' }],
      merge: { at: '1:3', into: 'ines' },
    },
    { id: 'ines', names: [{ at: '1:3', name: 'Ines' }], about: [{ at: '1:3', text: 'Marlo’s sister, who rode in as the masked knight.' }] },
  ],
  places: [{ id: 'ferrow', names: [{ at: '0:1', name: 'Ferrow' }], about: [{ at: '0:1', text: 'A town where it rains.' }] }],
  terms: [],
};

export const MARKS = `# self-test
narrator third pov elena
0:2.1 marlo
0:2.2 marlo
0:3.1 elena
0:3.2 elena
0:4.1 -
0:5.1 elena
0:6.1 elena
0:7 "I should never have come back" elena think
1:2.1 masked-knight
1:3 narrator third
1:4.1 ines
`;

