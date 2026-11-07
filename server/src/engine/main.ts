import { serve } from '@hono/node-server';
import { log } from '../log.ts';
import { coresOf, EngineEnv, makeEngineApp, panelModelOf, sizeOf, threadPool } from './serve.ts';

/*
 * An engine's process (serve.ts, ADR 0002): `node dist/engine/main.js`. The API reaches it at one
 * of ENGINE_URLS.
 */

// Native ONNX Runtime would send telemetry; it reads this as each worker loads it.
process.env.ORT_DISABLE_TELEMETRY ??= '1';
const env = EngineEnv.parse(process.env);
const cores = coresOf();
const size = sizeOf(env, cores, process.availableMemory() / (1024 * 1024));
const panel = panelModelOf(env.PANEL_MODEL);
if (!panel) log.warn('the panel model isn’t here, so this engine doesn’t find panels');
const pool = threadPool(size.threads);
const app = makeEngineApp({ pool, size, cores, speechDir: env.SPEECH_DIR, panel, token: env.ENGINE_TOKEN });

const server = serve({ fetch: app.fetch, port: env.ENGINE_PORT, hostname: '0.0.0.0' }, (info) =>
  log.info({ port: info.port, cores, ...size, panels: panel?.round ?? null }, 'engine listening'),
);

// Jobs running finish first (serve.ts: a worker ended mid-run aborts the process), five seconds at most.
const stop = () => {
  log.info('engine shutting down');
  void Promise.all([pool.close(), new Promise((r) => server.close(r))]).then(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
