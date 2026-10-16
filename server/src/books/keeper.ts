import { log } from '../log.ts';
import { bookOfUrl, type Books } from './index.ts';

/*
 * Every book added from the catalogue to any library, kept on the laptop for good, as its manga are
 * (manga/keeper.ts): its cover and every volume made ahead, a novel's chapters and pictures with
 * them. Each run asks each novel's chapters afresh, so a new one is made into its last volume as it
 * comes out; volumes made already cost no call. A book that's left every library goes back to the
 * rest of what's kept, to be trimmed in turn. One book at a time.
 */

export interface KeptBooks {
  books: number;
  volumes: number;
  /** Volumes made this run. */
  made: number;
  failed: number;
  /** Files gone back to the rest, their book out of every library. */
  letGo: number;
  keptFiles: number;
  keptMb: number;
}

/** Every book these library urls name kept for good, and only those. onBook: after each, for a live count. */
export async function keepBooks(books: Books, urls: string[], signal?: AbortSignal, onBook?: (sofar: KeptBooks) => void): Promise<KeptBooks> {
  const out: KeptBooks = { books: 0, volumes: 0, made: 0, failed: 0, letGo: 0, keptFiles: 0, keptMb: 0 };
  const ids: string[] = [];
  for (const url of urls) {
    const id = bookOfUrl(url);
    if (id && !ids.includes(id)) ids.push(id);
  }
  out.letGo = await books.keepOnly(ids);
  for (const id of ids) {
    if (signal?.aborted) break;
    try {
      const r = await books.keepBook(id, signal);
      out.volumes += r.volumes;
      out.made += r.made;
    } catch (err) {
      // Its volumes made so far stay; the rest are made next run.
      out.failed += 1;
      log.warn({ err, book: id }, 'a book couldn’t be kept whole, so the rest is kept next run');
    }
    out.books += 1;
    onBook?.(out);
  }
  const size = books.kept();
  out.keptFiles = size.kept.files;
  out.keptMb = Math.round(size.kept.bytes / 1024 / 1024);
  return out;
}
