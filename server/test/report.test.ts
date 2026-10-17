import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
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

  // The API on bad settings, a migration that can't run: sent before the process stops.
  it.each([
    ['api', 'Invalid environment'],
    ['migrate', 'PRIMARY_URL is required'],
  ])('sends a failed start of %s, with its role and release', async (component, message) => {
    const bodies: string[] = [];
    const sentry = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        bodies.push(body);
        res.end();
      });
    });
    await new Promise<void>((done) => sentry.listen(0, '127.0.0.1', done));
    const { port } = sentry.address() as AddressInfo;

    const child = spawn(process.execPath, ['--import', 'tsx', `src/${component}.ts`], {
      cwd: resolve(import.meta.dirname, '..'),
      env: { PATH: process.env.PATH, SENTRY_DSN: `http://key@127.0.0.1:${port}/1`, RELEASE: 'abc123', ROLE: 'fallback', LOG_LEVEL: 'silent' },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const code = await new Promise((done) => child.on('exit', done));
    sentry.close();

    expect(code).toBe(1);
    expect(bodies).toHaveLength(1);
    const event = JSON.parse(bodies[0].split('\n')[2]);
    expect(event).toMatchObject({ release: 'abc123', tags: { component, role: 'fallback' }, extra: { crashed: true } });
    expect(event.exception.values.at(-1).value).toContain(message);
  });
});
