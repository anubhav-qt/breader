import { Hono } from 'hono';
import { AudiobookBook, AudiobookEngine, AudiobookText, type AudiobooksInfo } from '@breader/shared';
import type { AppEnv, Deps } from '../context.ts';
import { ApiError, parse, readJson } from '../lib/errors.ts';
import { requireLibrary } from '../lib/library.ts';

/*
 * Audiobooks made on Breader's computer (speech/books.ts), for anyone with a library key: a book's
 * text in, its paragraphs' MP3s out as they're made. Only the laptop makes them; the fallback
 * answers that it can't, and the app makes them on the device instead.
 */
export function audiobookRoutes(deps: Deps) {
  const { books, speech } = deps;
  const r = new Hono<AppEnv>();
  r.use('/audiobooks/*', requireLibrary(deps));

  const open = () => {
    if (!books) throw new ApiError(503, 'audiobooks_off', 'Breader’s computer isn’t making audiobooks just now. Make it on this device instead.');
    return books;
  };
  const which = (book: string, engine: string) => ({ book: parse(AudiobookBook, book), engine: parse(AudiobookEngine, engine) });

  r.get('/audiobooks/info', (c) => {
    c.header('Cache-Control', 'private, no-store');
    return c.json({ on: !!books, voices: books && speech ? speech.voices : [] } satisfies AudiobooksInfo);
  });

  r.get('/audiobooks/:book/:engine', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const { book, engine } = which(c.req.param('book'), c.req.param('engine'));
    return c.json(await open().status(c.get('library').id, book, engine));
  });

  // The text, a slice under the request size limit at a time.
  r.post('/audiobooks/:book/:engine/text', async (c) => {
    const { book, engine } = which(c.req.param('book'), c.req.param('engine'));
    const t = parse(AudiobookText, await readJson(c));
    if (speech && !speech.voices.includes(t.voice)) throw new ApiError(400, 'audiobook_voice', 'Breader’s computer doesn’t have that voice. Make it on this device instead.');
    return c.json(await open().text(c.get('library').id, book, engine, t));
  });

  r.post('/audiobooks/:book/:engine/go', async (c) => {
    const { book, engine } = which(c.req.param('book'), c.req.param('engine'));
    return c.json(await open().go(c.get('library').id, book, engine));
  });

  r.post('/audiobooks/:book/:engine/pause', async (c) => {
    const { book, engine } = which(c.req.param('book'), c.req.param('engine'));
    return c.json(await open().pause(c.get('library').id, book, engine));
  });

  r.get('/audiobooks/:book/:engine/:n{[0-9]+}', async (c) => {
    const { book, engine } = which(c.req.param('book'), c.req.param('engine'));
    const mp3 = await open().part(c.get('library').id, book, engine, Number(c.req.param('n')));
    if (!mp3) throw new ApiError(404, 'audiobook_part', 'That part isn’t made yet.');
    return c.body(mp3 as Uint8Array<ArrayBuffer>, 200, { 'content-type': 'audio/mpeg', 'cache-control': 'private, no-store' });
  });

  r.delete('/audiobooks/:book/:engine', async (c) => {
    const { book, engine } = which(c.req.param('book'), c.req.param('engine'));
    await open().remove(c.get('library').id, book, engine);
    return c.json({ ok: true });
  });

  return r;
}
