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
- The ThinkPad's voices and panel model run in the `engine` service (ADR 0002,
  `docs/adr/0002-one-engine.md`, `server/src/engine/`). The API's scheduler hands it each job:
  reading aloud first, then panels. The server image is Debian (`node:24-trixie-slim`) for native ONNX.
  The server voice reads Piper's voices only; Kokoro (the heavy voices) runs on devices.
- Readers send requests and feedback from the app (`frontend/src/features/feedback/`,
  `server/src/routes/feedback.ts`); they show on the admin page (`frontend/src/admin/`).
- Audiobooks are made on readers' devices only. The server never makes them.
- Reading aloud and finding panels run on the reader's device when it can
  (`frontend/src/features/reader/able.ts`, checked as a book opens, nothing sent). Only a device too
  weak for one uses the server for it, by itself. There is no switch.

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
- Every feature a reader can use goes in the guide (`frontend/src/features/guide/list.ts`): a line on
  what it does and where it is. A new one gets `since` (its day), so readers from before see it as New.
- Migrations only add (a table, a nullable column). Removals ship a release later.
- Every release to production tells readers what changed: a new note at the top of
  `frontend/src/features/news/notes.ts` (a title, one or two short plain lines), shown once in a
  dialog. `infra/ship.sh` won't ship without one.
- Never print `infra/.env` or any secret.
- Commits: one line, `type: message`. No em dashes. No Claude attribution.
- Keep this file, `infra/README.md` and the ADRs in step with every change.
