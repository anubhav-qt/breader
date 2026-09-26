import type { PdfBook, TocItem } from './types';

/** Rough words per PDF page, only used for time-left estimates. */
export const WORDS_PER_PDF_PAGE = 300;

export async function openPdf(data: ArrayBuffer, fallbackTitle: string): Promise<PdfBook> {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const doc = await pdfjs.getDocument({ data }).promise;

  const meta = await doc.getMetadata().catch(() => null);
  const info = (meta?.info ?? {}) as { Title?: string; Author?: string };

  const toc: TocItem[] = [];
  const outline = await doc.getOutline().catch(() => null);
  const walk = async (items: NonNullable<typeof outline>, level: number) => {
    for (const item of items) {
      try {
        const dest = typeof item.dest === 'string' ? await doc.getDestination(item.dest) : item.dest;
        const ref = dest?.[0];
        const page = ref && typeof ref === 'object' ? await doc.getPageIndex(ref) : typeof ref === 'number' ? ref : -1;
        if (page >= 0) toc.push({ title: item.title.trim(), section: page, level });
      } catch { /* skip broken entries */ }
      if (item.items?.length) await walk(item.items, level + 1);
    }
  };
  if (outline) await walk(outline, 0);

  return {
    kind: 'pdf',
    title: info.Title?.trim() || fallbackTitle,
    author: info.Author?.trim() || '',
    doc,
    pages: doc.numPages,
    toc,
    words: doc.numPages * WORDS_PER_PDF_PAGE,
    cleanup: () => { void doc.destroy(); },
  };
}
