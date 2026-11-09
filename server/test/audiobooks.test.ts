import { describe, expect, it } from 'vitest';
import { browser } from './helpers.ts';

/*
 * Audiobooks are made on readers' own devices only. What's left of the server's side is for apps
 * opened before that: Breader's computer says it doesn't make them, and turns the rest away.
 */
describe('audiobooks on Breader’s computer', () => {
  it('says it doesn’t make them', async () => {
    const r = await browser().get('/v1/audiobooks/info');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ on: false, voices: [] });
  });

  it('turns away a book sent to it, or asked about, with a reason', async () => {
    const b = browser();
    const sent = await b.post('/v1/audiobooks/book-1/piper/text', { voice: 'piper:kristin', total: 1, from: 0, parts: [['Hi.']] });
    expect(sent.status).toBe(410);
    expect(sent.body).toMatchObject({ code: 'audiobooks_off' });
    expect((await b.get('/v1/audiobooks/book-1/piper')).status).toBe(410);
    expect((await b.get('/v1/audiobooks/book-1/piper/0')).status).toBe(410);
  });
});
