import JSZip from 'jszip';
import { countWords } from '../lib/format';
import { sanitize } from './sanitize';
import type { FlowBook, Section, TocItem } from './types';

const XLINK = 'http://www.w3.org/1999/xlink';
const OPS = 'http://www.idpf.org/2007/ops';

const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');

function resolve(base: string, href: string): string {
  let path = href.split('#')[0];
  try { path = decodeURIComponent(path); } catch { /* keep as is */ }
  const out: string[] = [];
  for (const seg of (base + path).split('/')) {
    if (seg === '..') out.pop();
    else if (seg && seg !== '.') out.push(seg);
  }
  return out.join('/');
}

const byTag = (root: Document | Element, tag: string) => Array.from(root.getElementsByTagNameNS('*', tag));

function parseMarkup(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xhtml+xml');
  return doc.getElementsByTagName('parsererror').length ? new DOMParser().parseFromString(text, 'text/html') : doc;
}

interface ManifestItem { href: string; type: string; props: string[] }

const seriesNumber = (s?: string | null) => {
  const n = parseFloat(s ?? '');
  return Number.isFinite(n) && n >= 0 && n <= 10_000 ? n : undefined;
};

/** The series a book says it's part of: EPUB 3's collections, or the tags calibre writes. */
function seriesOf(opf: Document): FlowBook['series'] {
  const metas = byTag(opf, 'meta');
  const refining = (id: string, prop: string) =>
    metas.find((m) => m.getAttribute('refines') === `#${id}` && m.getAttribute('property') === prop)?.textContent?.trim();
  for (const m of metas) {
    if (m.getAttribute('property') !== 'belongs-to-collection') continue;
    const name = m.textContent?.trim();
    const id = m.getAttribute('id') ?? '';
    const type = id ? refining(id, 'collection-type') : undefined;
    if (name && (!type || type === 'series')) return { name, index: id ? seriesNumber(refining(id, 'group-position')) : undefined };
  }
  const named = (n: string) => metas.find((m) => m.getAttribute('name') === n)?.getAttribute('content')?.trim();
  const name = named('calibre:series');
  return name ? { name, index: seriesNumber(named('calibre:series_index')) } : undefined;
}

/** The smallest image that counts as a picture for a cover, in bytes. */
const MIN_PICTURE = 8 * 1024;

export async function parseEpub(data: Blob | ArrayBuffer, fallbackTitle: string): Promise<FlowBook> {
  const zip = await JSZip.loadAsync(data);
  const read = (p: string) => zip.file(p)?.async('string');

  const container = await read('META-INF/container.xml');
  if (!container) throw new Error('This EPUB has no META-INF/container.xml.');
  const opfPath = byTag(new DOMParser().parseFromString(container, 'application/xml'), 'rootfile')[0]?.getAttribute('full-path');
  const opfText = opfPath ? await read(opfPath) : undefined;
  if (!opfPath || !opfText) throw new Error('This EPUB has no package document.');
  const opf = new DOMParser().parseFromString(opfText, 'application/xml');
  const base = dirname(opfPath);

  const title = byTag(opf, 'title')[0]?.textContent?.trim() || fallbackTitle;
  const author = byTag(opf, 'creator').map((e) => e.textContent?.trim()).filter(Boolean).join(', ');

  const manifest = new Map<string, ManifestItem>();
  for (const it of byTag(opf, 'item')) {
    manifest.set(it.getAttribute('id') || '', {
      href: resolve(base, it.getAttribute('href') || ''),
      type: it.getAttribute('media-type') || '',
      props: (it.getAttribute('properties') || '').split(/\s+/),
    });
  }
  const typeOf = new Map(Array.from(manifest.values(), (m) => [m.href, m.type]));
  const spine = byTag(opf, 'itemref')
    .map((r) => manifest.get(r.getAttribute('idref') || ''))
    .filter((m): m is ManifestItem => !!m && /html|xml/.test(m.type));
  const sectionOf = new Map(spine.map((s, i) => [s.href, i]));

  const urls: string[] = [];
  const blobUrls = new Map<string, string>();
  /** Every image the chapters show, in reading order, with its size. */
  const images: Array<{ path: string; size: number }> = [];
  async function blobUrl(path: string): Promise<string> {
    const hit = blobUrls.get(path);
    if (hit) return hit;
    const f = zip.file(path);
    if (!f) return '';
    const bytes = await f.async('arraybuffer');
    const url = URL.createObjectURL(new Blob([bytes], { type: typeOf.get(path) || '' }));
    urls.push(url);
    blobUrls.set(path, url);
    images.push({ path, size: bytes.byteLength });
    return url;
  }

  // Pass 1: parse every chapter, move images to blob URLs and namespace ids per section.
  const bodies: (Element | null)[] = [];
  const anchors = new Map<string, string>();
  for (let i = 0; i < spine.length; i++) {
    const item = spine[i];
    const doc = parseMarkup((await read(item.href)) || '');
    const body = doc.getElementsByTagName('body')[0] || null;
    bodies.push(body);
    if (!body) continue;
    const dir = dirname(item.href);
    for (const img of Array.from(body.getElementsByTagName('img'))) {
      const src = img.getAttribute('src');
      if (src && !/^(https?:|data:)/.test(src)) img.setAttribute('src', await blobUrl(resolve(dir, src)));
    }
    for (const im of Array.from(body.getElementsByTagName('image'))) {
      const href = im.getAttribute('href') || im.getAttributeNS(XLINK, 'href');
      if (!href) continue;
      im.removeAttributeNS(XLINK, 'href');
      im.setAttribute('href', await blobUrl(resolve(dir, href)));
    }
    for (const el of Array.from(body.querySelectorAll('[id]'))) {
      const id = el.getAttribute('id')!;
      const nid = `s${i}-${id}`;
      el.setAttribute('id', nid);
      anchors.set(`${item.href}#${id}`, nid);
    }
  }

  // Pass 2: internal links point at a section and anchor, then serialise and sanitise.
  const sections: Section[] = bodies.map((body, i) => {
    if (!body) return { title: '', html: '', words: 0 };
    const dir = dirname(spine[i].href);
    for (const a of Array.from(body.getElementsByTagName('a'))) {
      const href = a.getAttribute('href');
      if (!href) continue;
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        continue;
      }
      const [p, frag] = href.split('#');
      const target = p ? resolve(dir, p) : spine[i].href;
      const section = sectionOf.get(target);
      a.setAttribute('href', '#');
      if (section !== undefined) a.setAttribute('data-href', `${section}${frag ? '#' + (anchors.get(`${target}#${frag}`) || '') : ''}`);
    }
    return { title: '', html: sanitize(body.innerHTML), words: countWords(body.textContent || '') };
  });

  // Contents: the EPUB 3 nav document, or the EPUB 2 NCX.
  const toc: TocItem[] = [];
  const link = (dir: string, href: string) => {
    const path = resolve(dir, href);
    const section = sectionOf.get(path);
    const frag = href.split('#')[1];
    return section === undefined ? null : { section, anchor: frag ? anchors.get(`${path}#${frag}`) : undefined };
  };
  const nav = Array.from(manifest.values()).find((m) => m.props.includes('nav'));
  if (nav) {
    const doc = parseMarkup((await read(nav.href)) || '');
    const navs = byTag(doc, 'nav');
    const tocNav = navs.find((n) => (n.getAttributeNS(OPS, 'type') || n.getAttribute('epub:type') || '').includes('toc')) || navs[0];
    const walk = (ol: Element, level: number) => {
      for (const li of Array.from(ol.children).filter((c) => c.localName === 'li')) {
        const a = byTag(li, 'a')[0];
        const target = a && a.closest('li') === li ? link(dirname(nav.href), a.getAttribute('href') || '') : null;
        if (a && target) toc.push({ title: (a.textContent || '').replace(/\s+/g, ' ').trim(), level, ...target });
        const sub = Array.from(li.children).find((c) => c.localName === 'ol');
        if (sub) walk(sub, level + 1);
      }
    };
    const ol = tocNav && Array.from(tocNav.children).find((c) => c.localName === 'ol');
    if (ol) walk(ol, 0);
  }
  if (!toc.length) {
    const ncxId = byTag(opf, 'spine')[0]?.getAttribute('toc');
    const ncx = (ncxId && manifest.get(ncxId)) || Array.from(manifest.values()).find((m) => m.type === 'application/x-dtbncx+xml');
    const ncxText = ncx ? await read(ncx.href) : undefined;
    if (ncx && ncxText) {
      const doc = new DOMParser().parseFromString(ncxText, 'application/xml');
      const walk = (parent: Element, level: number) => {
        for (const np of Array.from(parent.children).filter((c) => c.localName === 'navPoint')) {
          const label = byTag(np, 'text')[0]?.textContent?.trim() || '';
          const src = byTag(np, 'content')[0]?.getAttribute('src') || '';
          const target = link(dirname(ncx.href), src);
          if (target && label) toc.push({ title: label, level, ...target });
          walk(np, level + 1);
        }
      };
      const map = byTag(doc, 'navMap')[0];
      if (map) walk(map, 0);
    }
  }

  sections.forEach((s, i) => {
    const t = toc.find((item) => item.section === i && !item.anchor) || toc.find((item) => item.section === i);
    const h = bodies[i]?.querySelector('h1, h2, h3');
    s.title = t?.title || (h?.textContent || '').replace(/\s+/g, ' ').trim() || (s.words ? `Section ${i + 1}` : i === 0 ? 'Cover' : 'Illustration');
  });

  // The cover the book names, or else the first picture in it. Small images are ornaments and
  // dividers, not pictures.
  const coverId = byTag(opf, 'meta').find((m) => m.getAttribute('name') === 'cover')?.getAttribute('content');
  const named = Array.from(manifest.values()).find((m) => m.props.includes('cover-image')) || (coverId ? manifest.get(coverId) : undefined);
  const coverPath = named && /^image\//.test(named.type) && zip.file(named.href)
    ? named.href
    : images.find((im) => im.size >= MIN_PICTURE && /^image\//.test(typeOf.get(im.path) || ''))?.path;
  const coverFile = coverPath ? zip.file(coverPath) : null;
  const cover = coverFile ? new Blob([await coverFile.async('arraybuffer')], { type: typeOf.get(coverPath!) }) : undefined;

  return {
    kind: 'flow',
    title,
    author,
    sections,
    toc,
    words: sections.reduce((n, s) => n + s.words, 0),
    cover,
    series: seriesOf(opf),
    cleanup: () => urls.forEach((u) => URL.revokeObjectURL(u)),
  };
}
