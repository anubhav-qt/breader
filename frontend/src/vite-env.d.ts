/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The laptop's API, e.g. https://api.breader.example. */
  readonly VITE_API_URL?: string;
  /** The fallback's API on Render, e.g. https://fb.breader.example. */
  readonly VITE_API_FALLBACK_URL?: string;
  /** Readers' next chapters in R2 (ADR 0003), e.g. https://pages.breader.example. Off without it. */
  readonly VITE_PAGES_URL?: string;
  /** Sentry project DSN; errors aren't reported without it. */
  readonly VITE_SENTRY_DSN?: string;
  /** The commit this build is from (vite.config.ts). */
  readonly VITE_RELEASE?: string;
}
