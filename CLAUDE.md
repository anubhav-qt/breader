# Breader

A reading app: books, manga, voices. Free to run ($0 hosting, one domain).

## Layout

- `frontend/` the app (React, Vite). Served from Cloudflare Pages.
- `server/` the API, the worker and the engine (Hono, Postgres via drizzle). One image, many roles.
- `shared/` types and zod schemas used by both.
- `ai/` the AI marker, panel model, voices tooling.
- `infra/` compose files, `ship.sh`, `update.sh`, and `README.md`: how production runs.
- `docs/adr/` big decisions. `TODO.md` small ones and later work.
- `backend-design.html`, `design-spec.html` the original designs.

## How it runs today

- The ThinkPad runs everything behind a Cloudflare Tunnel (`api.breader.site`).
- One Render free service (`fb.breader.site`) is the fallback.
- Supabase (Mumbai) is the only writer. The ThinkPad keeps a copy fed from `change_log`
  (`server/src/mirror/feed.ts`, fed tables in `FED_TABLES`, `server/src/db/schema.ts`).
- The app talks to `primary`, and switches to `fallback` on timeouts and gateway errors
  (`frontend/src/lib/api.ts`).
- The ThinkPad's voices, audiobooks and panel model run in the `engine` service (ADR 0002,
  `docs/adr/0002-one-engine.md`, `server/src/engine/`). The API's scheduler hands it each job:
  reading aloud first, then panels, then audiobooks; audiobooks wait while anyone reads aloud.
  The server image is Debian (`node:24-trixie-slim`) for native ONNX.

## In progress

- ADR 0001 (`docs/adr/0001-four-servers.md`): 4 servers, regional read copies, edge-cached
  pages, the app picks the server (no Worker). Point 1 built: pages and covers are public
  (`shared/src/public.ts`), skip CORS, sent with no cookie; errors are `no-store`. Live since 2026-11-07, kept by a
  Cloudflare Cache Rule (`infra/README.md`). The rest: not built.
- Load tests: `infra/load/` (run inside Docker's network): `readers.mjs` for the API,
  `voices.mjs` for the engine. How-to and numbers in `docs/load-tests.md`.

## Working here

- Tests run from the Docker test stack, not this checkout (see the owner's memory notes).
- Server tests: `npm test -w server` (needs the stack). App tests: `npm test -w frontend`.
- Migrations only add (a table, a nullable column). Removals ship a release later.
- Never print `infra/.env` or any secret.
- Commits: one line, `type: message`. No em dashes. No Claude attribution.
- Keep this file, `infra/README.md` and the ADRs in step with every change.
