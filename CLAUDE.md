# Breader

A reading app: books, manga, voices. Free to run ($0 hosting, one domain).

## Layout

- `frontend/` the app (React, Vite). Served from Cloudflare Pages.
- `server/` the API and the worker (Hono, Postgres via drizzle). One image, many roles.
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

## In progress

- ADR 0001 (`docs/adr/0001-four-servers.md`): 4 servers, regional read copies, edge-cached
  pages, the app picks the server (no Worker). Proposed, nothing built yet.
- Load tests: `infra/load/` (run inside Docker's network), how-to and numbers in
  `docs/load-tests.md`.

## Working here

- Tests run from the Docker test stack, not this checkout (see the owner's memory notes).
- Server tests: `npm test -w server` (needs the stack). App tests: `npm test -w frontend`.
- Migrations only add (a table, a nullable column). Removals ship a release later.
- Never print `infra/.env` or any secret.
- Commits: one line, `type: message`. No em dashes. No Claude attribution.
- Keep this file, `infra/README.md` and the ADRs in step with every change.
