import { ApiError } from '../lib/errors.ts';
import { log } from '../log.ts';
import type { Pace } from '../manga/pace.ts';

/*
 * Calls to the places books come from, and what a reader is told when one goes wrong: the novel
 * host (novels.ts), Gutendex (gutendex.ts), Open Library and the Internet Archive (openlibrary.ts).
 */

/** Who's asking, as Open Library asks to be told. */
export const AGENT = 'Breader (https://breader.site)';
/** How long a call to a books' place waits. */
const WAIT = 20_000;

export const notFound = () => new ApiError(404, 'book_not_found', 'That book isn’t there any more.');
export const busy = () => new ApiError(503, 'book_busy', 'That site is busy just now. Try again in a minute.');
export const unreachable = () => new ApiError(503, 'book_unreachable', 'Breader can’t reach that site just now. Try again in a minute.');
export const refused = () => new ApiError(503, 'book_source_down', 'That site isn’t answering just now. Try again later.');

/** A call, taking its turn first: a 404 is not found, any other failure the site's. */
export async function fetchFrom(fetchFn: typeof fetch, url: string, pace: Pace | null, wait = WAIT): Promise<Response> {
  if (pace) {
    try {
      await pace.take();
    } catch {
      throw busy();
    }
  }
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { 'user-agent': AGENT }, signal: AbortSignal.timeout(wait) });
  } catch (err) {
    log.warn({ err, url }, 'a books’ place didn’t answer');
    throw unreachable();
  }
  if (res.ok) return res;
  if (res.status === 404 || res.status === 410) throw notFound();
  log.warn({ status: res.status, url }, 'a books’ place refused a call');
  throw refused();
}

export async function jsonFrom<T>(fetchFn: typeof fetch, url: string, pace: Pace | null): Promise<T> {
  const res = await fetchFrom(fetchFn, url, pace);
  try {
    return (await res.json()) as T;
  } catch {
    throw refused();
  }
}

/** A whole file, waited for longer: a book's EPUB with its pictures runs to tens of megabytes. */
export async function bytesFrom(fetchFn: typeof fetch, url: string, pace: Pace | null): Promise<Uint8Array> {
  const res = await fetchFrom(fetchFn, url, pace, 5 * 60_000);
  return new Uint8Array(await res.arrayBuffer());
}
