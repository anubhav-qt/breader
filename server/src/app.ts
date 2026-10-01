import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import type { AppEnv, Deps } from './context.ts';
import { ApiError, onError } from './lib/errors.ts';
import { clientIp, sameOriginWrites } from './lib/http.ts';
import { log } from './log.ts';
import { accountRoutes } from './routes/account.ts';
import { adminRoutes } from './routes/admin.ts';
import { aiRoutes } from './routes/ai.ts';
import { commentRoutes } from './routes/comments.ts';
import { fileRoutes } from './routes/files.ts';
import { healthRoutes } from './routes/health.ts';
import { libraryRoutes } from './routes/libraries.ts';
import { shelfRoutes } from './routes/shelf.ts';
import { speechRoutes } from './routes/speech.ts';
import { syncRoutes } from './routes/sync.ts';
import { voiceRoutes } from './routes/voices.ts';

export function makeApp(deps: Deps) {
  const allowed = deps.env.ALLOWED_ORIGINS;
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('ip', clientIp(c, deps.env.CLIENT_IP_HEADER));
    const start = performance.now();
    await next();
    const ms = Math.round(performance.now() - start);
    const level = c.res.status >= 500 ? 'error' : c.req.path === '/health' ? 'trace' : 'debug';
    log[level]({ method: c.req.method, path: c.req.path, status: c.res.status, ms }, 'request');
  });
  app.use(
    '*',
    cors({
      origin: (origin) => (allowed.includes(origin) ? origin : null),
      credentials: true,
      allowMethods: ['GET', 'POST', 'DELETE'],
      allowHeaders: ['content-type'],
      // The server voice's sound says how long it is (routes/speech.ts).
      exposeHeaders: ['x-samples', 'x-rate'],
      maxAge: 600,
    }),
  );
  app.use('/v1/*', sameOriginWrites(allowed));
  app.use(
    '/v1/*',
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: () => { throw new ApiError(413, 'too_large', 'That request is too large.'); },
    }),
  );

  app.route('/', healthRoutes(deps));
  app.route('/', adminRoutes(deps));
  // Accounts: Better Auth answers everything under /v1/auth (auth.ts).
  app.on(['GET', 'POST'], '/v1/auth/*', (c) => deps.auth.handler(c.req.raw));
  app.route('/v1', accountRoutes(deps));
  app.route('/v1', libraryRoutes(deps));
  app.route('/v1', syncRoutes(deps));
  app.route('/v1', fileRoutes(deps));
  app.route('/v1', shelfRoutes(deps));
  app.route('/v1', voiceRoutes(deps));
  app.route('/v1', aiRoutes(deps));
  app.route('/v1', commentRoutes(deps));
  app.route('/v1', speechRoutes(deps));

  app.notFound((c) => c.json({ code: 'not_found', message: 'No such endpoint.' }, 404));
  app.onError(onError);
  return app;
}
