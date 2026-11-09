import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import type { Auth } from '../auth.ts';
import type { Env } from '../env.ts';

/** How long a yes is kept: a sign-out elsewhere is heard within this. */
const KEPT = 5 * 60_000;
/** Logins kept at once, a few dozen bytes each. */
const MAX = 5000;

/**
 * Whether the logged-in reader's account, its address confirmed, passes `who`. Asking Better Auth
 * costs Supabase a query, and the server voice asks every sentence, so a yes is kept a few minutes
 * by the request's cookies (any change to them asks again). A no is never kept, so confirming the
 * address counts at once.
 */
function accountCheck(auth: Auth, who: (email: string) => boolean) {
  const yes = new Map<string, number>();
  return async (c: Context): Promise<boolean> => {
    const cookie = c.req.header('cookie');
    if (!cookie) return false;
    const key = createHash('sha256').update(cookie).digest('base64url');
    const until = yes.get(key);
    if (until && until > Date.now()) return true;
    yes.delete(key);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    const user = session?.user;
    const ok = !!user && user.emailVerified && who(user.email.toLowerCase());
    if (ok) {
      yes.set(key, Date.now() + KEPT);
      while (yes.size > MAX) yes.delete(yes.keys().next().value!);
    }
    return ok;
  };
}

/** The owner's accounts (SPEECH_EMAILS): a seat at the panel model always, and their devices' panels kept at once. */
export const ownerCheck = (env: Env, auth: Auth) => accountCheck(auth, (email) => env.SPEECH_EMAILS.includes(email));

/** Any reader signed in with a confirmed address: the server voice, for a device too slow to read itself. */
export const readerCheck = (auth: Auth) => accountCheck(auth, () => true);
