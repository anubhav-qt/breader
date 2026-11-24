/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The servers' addresses, comma-separated, the home server first (lib/servers.ts). */
  readonly VITE_API_SERVERS?: string;
  /** Older: the home server, when VITE_API_SERVERS is unset. */
  readonly VITE_API_URL?: string;
  /** Older: one other server, when VITE_API_SERVERS is unset. */
  readonly VITE_API_FALLBACK_URL?: string;
  /** Sentry project DSN; errors aren't reported without it. */
  readonly VITE_SENTRY_DSN?: string;
  /** The commit this build is from (vite.config.ts). */
  readonly VITE_RELEASE?: string;
}
