import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
import { log } from '../log.ts';

/** An error the reader can act on. The message is shown in the app as written. */
export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;
  constructor(status: ContentfulStatusCode, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const signedOut = () =>
  new ApiError(401, 'signed_out', 'This browser isn’t signed in to a library. Open it again with your key.');

/** Validates a request body or query, turning zod's issues into one readable 400. */
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const first = r.error.issues[0];
  const where = first?.path.length ? ` (${first.path.join('.')})` : '';
  throw new ApiError(400, 'bad_request', `${first?.message ?? 'Invalid request'}${where}`);
}

export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError(400, 'bad_json', 'The request body isn’t valid JSON.');
  }
}

export function onError(err: Error, c: Context) {
  if (err instanceof ApiError) return c.json({ code: err.code, message: err.message }, err.status);
  log.error({ err, path: c.req.path, method: c.req.method }, 'request failed');
  return c.json({ code: 'server_error', message: 'Something went wrong on the server. Try again in a moment.' }, 500);
}

/** The Postgres error code behind an error, if any (drizzle wraps driver errors in `cause`). */
export function pgCode(e: unknown): string | undefined {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.cause?.code ?? err?.code;
}
