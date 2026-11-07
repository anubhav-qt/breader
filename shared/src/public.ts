/*
 * Answers that are the same for every reader: manga pages, a source chapter's page count, and
 * covers. Anyone may fetch them, with no cookie, and Cloudflare keeps them near the reader
 * (ADR 0001, point 1). Its Cache Rule on api.breader.site lists these same paths (infra/README.md).
 */

/** Where the public answers live, under /v1. */
const PUBLIC_PATHS: RegExp[] = [
  /^\/v1\/manga\/chapter\//,
  /^\/v1\/manga\/source\/chapter\//,
  /^\/v1\/manga\/cover\//,
  /^\/v1\/manga\/anilist\/cover\//,
  /^\/v1\/manga\/source\/[^/]+\/cover$/,
];

/** Whether a path's answer is the same for everyone (its query string left off). */
export function isPublicPath(path: string): boolean {
  for (const pattern of PUBLIC_PATHS) {
    if (pattern.test(path)) return true;
  }
  return false;
}
