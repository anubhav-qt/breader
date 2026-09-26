import { describe, expect, it } from 'vitest';
import { envelopeUrl, makeReporter, parseStack } from '@breader/shared';

describe('error reports', () => {
  it('sends to the envelope endpoint named by the DSN', () => {
    expect(envelopeUrl('https://abc123@o42.ingest.sentry.io/77')).toBe(
      'https://o42.ingest.sentry.io/api/77/envelope/?sentry_key=abc123&sentry_version=7&sentry_client=breader%2F1',
    );
  });

  it('reads V8 and Safari/Firefox stacks, oldest frame first', () => {
    const v8 = parseStack('Error: x\n    at pull (/app/dist/api.js:10:5)\n    at /app/node_modules/hono/x.js:3:1');
    expect(v8).toEqual([
      { filename: '/app/node_modules/hono/x.js', lineno: 3, colno: 1, in_app: false },
      { function: 'pull', filename: '/app/dist/api.js', lineno: 10, colno: 5, in_app: true },
    ]);
    expect(parseStack('flush@https://breader.example/assets/index.js:1:200')[0]).toMatchObject({ function: 'flush', lineno: 1, colno: 200 });
  });

  it('sends one error, its cause, and each repeat at most once in ten minutes', async () => {
    const sent: string[] = [];
    const r = makeReporter({ dsn: 'https://k@sentry.example/1', component: 'api', platform: 'node', release: 'abc' }, async (_url, init) => {
      sent.push(String(init?.body));
      return new Response(null);
    });
    const err = new Error('pull failed', { cause: new Error('connection reset') });
    r.capture(err, { path: '/v1/sync/pull' });
    r.capture(err);
    r.capture(new Error('something else'));
    expect(sent).toHaveLength(2);
    const [header, item, event] = sent[0].split('\n').map((l) => JSON.parse(l));
    expect(item).toEqual({ type: 'event' });
    expect(event.event_id).toBe(header.event_id);
    expect(event).toMatchObject({ level: 'error', release: 'abc', tags: { component: 'api' }, extra: { path: '/v1/sync/pull' } });
    expect(event.exception.values.map((v: { value: string }) => v.value)).toEqual(['connection reset', 'pull failed']);
  });
});
