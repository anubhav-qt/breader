import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { Db } from './db/client.ts';
import { accounts, authSessions, users, verifications } from './db/schema.ts';
import type { Env } from './env.ts';
import { sendMail } from './lib/mail.ts';
import { log } from './log.ts';

/*
 * Accounts (backend design §4): email and password, or Google, through Better Auth, mounted at
 * /v1/auth/*. Both servers run it against Supabase, and its cookie is set on the parent domain
 * like the key session's, so a reader logged in on api. is logged in on fb. too.
 *
 * An account doesn't replace the key session: routes/account.ts turns a login into a key
 * session for the account's library (POST /v1/session/account), and sync goes on as before.
 *
 * Links in emails point at the app (APP_URL/?verify=… or ?reset=…), not at the server that sent
 * them, so they still work if that server is down by the time the reader clicks.
 */

const DAY = 86_400;

export function makeAuth(env: Env, db: Db) {
  const app = env.APP_URL ?? env.ALLOWED_ORIGINS[0] ?? 'http://localhost:5173';
  const google = env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET;
  const ipHeader = env.CLIENT_IP_HEADER === 'none' ? undefined : env.CLIENT_IP_HEADER;

  return betterAuth({
    appName: 'Breader',
    baseURL: env.PUBLIC_URL ?? `http://localhost:${env.PORT}`,
    basePath: '/v1/auth',
    secret: env.SESSION_SECRET,
    trustedOrigins: env.ALLOWED_ORIGINS,
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: { user: users, account: accounts, session: authSessions, verification: verifications },
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      // Confirming the address unlocks sharing later (§4); logging in doesn't wait for it.
      requireEmailVerification: false,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, token }) => {
        await sendMail(env, {
          to: user.email,
          subject: 'Reset your Breader password',
          lines: ['Someone asked to reset the password for this Breader account. If it was you, choose a new one:', 'The link works for an hour. If you didn’t ask, ignore this email; your password stays as it is.'],
          link: { label: 'Choose a new password', url: `${app}/?reset=${encodeURIComponent(token)}` },
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, token }) => {
        await sendMail(env, {
          to: user.email,
          subject: 'Confirm your email for Breader',
          lines: ['Welcome to Breader. Confirm this is your email address:'],
          link: { label: 'Confirm my email', url: `${app}/?verify=${encodeURIComponent(token)}` },
        });
      },
    },
    socialProviders: google ? { google: { clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET!, prompt: 'select_account' } } : {},
    account: {
      // Logging in with Google on an email that already has a password joins the two.
      accountLinking: { enabled: true, trustedProviders: ['google'] },
    },
    session: { expiresIn: 90 * DAY, updateAge: DAY },
    rateLimit: {
      enabled: env.NODE_ENV !== 'test',
      window: 60,
      max: 60,
      customRules: {
        '/sign-in/email': { window: 60, max: 10 },
        '/sign-up/email': { window: 3600, max: 10 },
        '/request-password-reset': { window: 3600, max: 5 },
        '/send-verification-email': { window: 3600, max: 5 },
      },
    },
    advanced: {
      cookiePrefix: 'brdr',
      useSecureCookies: env.COOKIE_SECURE,
      crossSubDomainCookies: env.COOKIE_DOMAIN ? { enabled: true, domain: env.COOKIE_DOMAIN } : undefined,
      ipAddress: ipHeader ? { ipAddressHeaders: [ipHeader] } : undefined,
    },
    telemetry: { enabled: false },
    logger: {
      level: env.NODE_ENV === 'production' ? 'warn' : 'info',
      log: (level, message, ...args) => log[level]({ args: args.length ? args : undefined }, `auth: ${message}`),
    },
  });
}

export type Auth = ReturnType<typeof makeAuth>;
