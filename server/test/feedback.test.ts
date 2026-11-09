import { describe, expect, it } from 'vitest';
import { FEEDBACK_CHARS, type FeedbackItem } from '@breader/shared';
import { browser, env, registered } from './helpers.ts';

const admin = { authorization: `Bearer ${env.ADMIN_TOKEN}` };
const unique = (s: string) => `${s} ${Math.random().toString(36).slice(2, 10)}`;

async function list(): Promise<FeedbackItem[]> {
  const r = await browser().get('/admin/feedback', admin);
  expect(r.status).toBe(200);
  return r.body.items;
}

describe('feedback', () => {
  it('takes a request from someone signed in and shows it on the admin page, newest first', async () => {
    const { b, libraryId } = await registered();
    const first = unique('Dark mode for covers');
    const second = unique('Love the voices');
    expect((await b.post('/v1/feedback', { kind: 'feature', body: `  ${first}  `, release: 'abc123' })).status).toBe(201);
    expect((await b.post('/v1/feedback', { kind: 'feedback', body: second })).status).toBe(201);

    const items = await list();
    const a = items.findIndex((f) => f.body === first);
    const s = items.findIndex((f) => f.body === second);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThan(a);
    expect(items[a]).toMatchObject({ kind: 'feature', body: first, library: libraryId, release: 'abc123', done: false });
    expect(items[s]).toMatchObject({ kind: 'feedback', library: libraryId, release: null });
  });

  it('takes one from someone with no library', async () => {
    const body = unique('No key yet');
    expect((await browser().post('/v1/feedback', { kind: 'feedback', body })).status).toBe(201);
    expect((await list()).find((f) => f.body === body)).toMatchObject({ library: null });
  });

  it('turns away empty, too long, unknown kinds and extra fields', async () => {
    const b = browser();
    for (const bad of [
      { kind: 'feedback', body: '   ' },
      { kind: 'feedback', body: 'x'.repeat(FEEDBACK_CHARS + 1) },
      { kind: 'bug', body: 'hi' },
      { kind: 'feedback' },
      { kind: 'feedback', body: 'hi', library: 'someone-else' },
    ]) {
      expect((await b.post('/v1/feedback', bad)).status, JSON.stringify(bad).slice(0, 60)).toBe(400);
    }
    expect((await b.post('/v1/feedback', { kind: 'feedback', body: 'x'.repeat(FEEDBACK_CHARS) })).status).toBe(201);
  });

  it('slows down someone sending a lot', async () => {
    const b = browser();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await b.post('/v1/feedback', { kind: 'feedback', body: `spam ${i}` })).status);
    expect(codes.slice(0, 10).every((c) => c === 201)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it('is read and marked done only with the admin token', async () => {
    const body = unique('Mark me');
    await browser().post('/v1/feedback', { kind: 'feature', body });
    const id = (await list()).find((f) => f.body === body)!.id;

    const b = browser();
    expect((await b.get('/admin/feedback')).status).toBe(401);
    expect((await b.get('/admin/feedback', { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await b.post(`/admin/feedback/${id}/done`, { done: true })).status).toBe(401);

    expect((await b.post(`/admin/feedback/${id}/done`, { done: true }, admin)).status).toBe(200);
    expect((await list()).find((f) => f.id === id)?.done).toBe(true);
    expect((await b.post(`/admin/feedback/${id}/done`, { done: false }, admin)).status).toBe(200);
    expect((await list()).find((f) => f.id === id)?.done).toBe(false);

    expect((await b.post('/admin/feedback/999999999/done', { done: true }, admin)).status).toBe(404);
    expect((await b.post('/admin/feedback/abc/done', { done: true }, admin)).status).toBe(400);
    expect((await b.post(`/admin/feedback/${id}/done`, { done: 'yes' }, admin)).status).toBe(400);
  });
});
