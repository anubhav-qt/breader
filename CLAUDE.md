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
- The fallback is Azure (`az1.breader.site`, `infra/azure/`) with its own Suwayomi, asleep until the
  AWS machine (`infra/aws/watch.sh`, every minute) sees the ThinkPad miss 10 minutes, then kept
  awake until it answers. The app lists it in `VITE_API_STANDBY` and asks it only while home is away.
  Render (`fb.breader.site`) and the AWS Suwayomi (`sw.breader.site`) are out of the app since 2026-11-24.
- Supabase (Mumbai) is the only writer. The ThinkPad keeps a copy fed from `change_log`
  (`server/src/mirror/feed.ts`, fed tables in `FED_TABLES`, `server/src/db/schema.ts`). Each copy
  keeps its place in `feed_copies`; `change_log` is pruned to the slowest (`server/src/jobs/chores.ts`).
- Any server may have a read copy, any Postgres anywhere (`COPY_URL`, `server/src/mirror/copy.ts`):
  it migrates and feeds it (one feeder per copy, an advisory lock). Reads that may come from a copy
  use `c.var.read` (`server/src/db/reads.ts`); writes and a reader's own fresh writes go to the primary.
- The fallback has 512 MB and no Redis (`light` in `server/src/api.ts`): each kind of answer gets
  2 MB of memory (`memoryRoom`, `server/src/lib/cache.ts`), no daily prefetch, a small warm-up, and
  manga's answers kept in R2 under `answers/` so a restart reads them back (`server/src/lib/answers.ts`).
- The app knows every server (`VITE_API_SERVERS`, home first), times their `/health` and picks
  (`frontend/src/lib/servers.ts`, `frontend/src/lib/api.ts`); timeouts and gateway errors move to the next.
- Each library's 2 comics read most lately go in the public R2 bucket `breader-pages`, the chapter
  read to and 25 after it, put by the ThinkPad's keeper (`server/src/manga/cloud.ts`, ADR 0003,
  `docs/adr/0003-pages-in-r2.md`). The app reads pages there first (`frontend/src/lib/cloud.ts`),
  and a MangaFire series' list too while home is away. Free only: under 9 GB, 900,000 writes a month.
- The ThinkPad's voices and panel model run in the `engine` service (ADR 0002,
  `docs/adr/0002-one-engine.md`, `server/src/engine/`). The API's scheduler hands it each job:
  reading aloud first, then panels. The server image is Debian (`node:24-trixie-slim`) for native ONNX.
  The server voice reads Piper's voices only; Kokoro (the heavy voices) runs on devices.
- Search and screen readers: `index.html` carries the empty library's words for crawlers that run
  no script, hidden where scripts run so readers never see them flash (kept equal to `features/guide/cards.ts` by `src/findable.test.ts`), plus the
  description, canonical and link-preview tags (the wide `public/og.png`, 1200x630). `public/404.html`, `robots.txt`, `sitemap.xml`:
  `infra/README.md`, Cloudflare Pages.
- The admin page's Infra tab (`frontend/src/admin/Infra.tsx`, `infraView.ts`) maps every server,
  copy and store. Each API server says how it is every 30 s (GCP 2 min, `SEEN_EVERY_S`) in `server_seen` (`server/src/lib/seen.ts`);
  any server reads it back with `feed_copies` and the pool's tables (`server/src/lib/infra.ts`), so
  Azure is never woken to ask. The AWS watcher sends its misses in `x-breader-watch` on each ask.
- Readers send requests and feedback from the app (`frontend/src/features/feedback/`,
  `server/src/routes/feedback.ts`); they show on the admin page (`frontend/src/admin/`). Working and
  Done (with the admin's one line) tell the library that sent it, once each: a thin toast, and the
  What's new dialog (`features/feedback/replies.ts`).
- Every marker stage runs on NVIDIA: Nemotron 3.5 Super VL first, tried again, then Nemotron 3
  Ultra (the admin picks per stage, NVIDIA only). Codex (`gpt-6.1-terra` at medium, through the
  worker's CLIProxyAPI, `ai/tools/proxy.ts`) is the backup: once every NVIDIA model is down it
  keeps the calls 10 minutes, then NVIDIA is asked again (`ai/tools/backup.ts`, `balancer.ts`,
  `harness.ts`). Gathering a soundtrack is the one stage Codex leads, NVIDIA behind it
  (`CODEX_STAGES`, `shared/src/admin.ts`); downloading the tracks is code. NVIDIA searches the web
  through SearXNG (`SEARXNG_URL`), Codex with its own `web_search` on `/v1/responses`
  (`ai/tools/web.ts`). Plan and decisions: `docs/codex-plan.md`.
- The server's small jobs (joining a search's copies `manga/same.ts`, checking Browse's tabs
  `manga/curate.ts`, filling in books `jobs/fill.ts`) ask Codex's `gpt-6.1-terra` at medium first,
  NVIDIA's Super VL as the backup for 10 minutes when Codex is down, on the ThinkPad only
  (`server/src/lib/tidier.ts`). On NVIDIA a low job has its thinking off.
- Covers: outside the books' bento, every book and manga is the same cover card (`gallery/CoverCard.tsx`):
  a drawn one when it has no cover, buttons on top, how far and its name at the foot. Only covers
  (Settings, on by default, this device) hides how far and the name, but for a drawn card's name.
  A series' stack shows the cover of the book it stands on (`nextIn`, `gallery/series.ts`): the one the
  reader is at, or the first in a shared library. Someone's shared covers load as their cards come near
  the screen (`useShelfCover`, `data/shelf.ts`), 4 at a time; a manga series' from its site, as in Browse.
  A sharer's cover comes small (600x900 WebP, `GET /v1/shared/cover/<id>.webp`, `routes/shelf.ts`), public and kept
  a week, so Cloudflare holds one copy for every device (cached by its `.webp` ending, no Cache Rule).
  A reader's uploaded book shows a new cover only once the model said it's really that book's
  (`server/src/jobs/covers.ts`, once per image in `cover_checks`, marked as `library_items.cover_ok`;
  `shownCover`, `frontend/src/data/library.ts`). Covers from before the check (`cover_waits` null)
  show until a no; `coverOk` on the wire is true, false (waits or no) or left out (old). Manga (uploaded too), samples and previews aren't checked.
  Covers go at 512px, behind the server's other model calls (`later`, `lib/tidier.ts`); one with no answer waits 6 hours.
  50 a run, every 30 minutes, or a minute after a full run the model answered in.
- The AI marker cuts someone else's words quoted inside a line into their voice (`nest`,
  `ai/tools/marks.ts`) and rereads lines whose speech tag names someone else (`ai/tools/tags.ts`).
- Public feed: a library made public (`libraries.public_at`, Shared's list, the globe) shows in
  Public (`GET /v1/shared/feed`, `frontend/src/features/shared/PublicFeed.tsx`). Its feed token only
  reads (`publicToken`, `server/src/lib/shelf.ts`); only an owner or a made-to-share key holder flips it. One with no name shows as
  its short id's shared library (`publicTag`, the id's first 6 characters; `feedName`, `features/shared/facts.ts`).
  Renaming a library of the reader's own, in Shared's list or in Public (`renameLibrary`, `data/shelf.ts`) names it
  everywhere: their own by the synced setting, one made only to share by `POST /v1/shared/name`.
  On phones (up to 720px) the Personal | Shared | Public switch is one button that opens the other two
  (`frontend/src/components/LibraryPick.tsx`).
- Saving from Public makes the reader's own copy (`libraries.copy_of`, `POST /v1/shared/copy`): it takes in
  what the original adds (`copied_books`, fed) and keeps what it loses. To change the original the reader
  asks (`/v1/shared/ask`, a note up to 500 characters); the owner answers under that library in Shared's
  list (`/v1/shared/answer`: yes, no, take back), and a yes is a grant of their own (`library_grants`,
  `grantToken`, access `grant`): add and remove only, never the key, the public switch or a rename.
  The ask and its yes are for the asker's own library (`asker_id`): others with the copy's key only read.
  Saved again, the reader gets the copy they asked from back. Taken out of Public, every yes and ask on
  it ends; copies keep what they have, and only its key holders change it.
  Anyone who may change a library takes books out (`/v1/shared/remove`, Select then Remove).
- Add to (`frontend/src/features/add/AddTo.tsx`, sums in `places.ts`): one ticked list of every library
  the reader may change, opened from a card's ⋯ (Libraries), Select, the plus on someone else's card, or a manga's page
  (`openSeriesAddTo`, App.tsx: a series not in My manga goes in as Personal is ticked).
  A tick puts the books in at once, an untick takes them out. A reader's own unshared upload may go into
  a library they may change (`library_items.from_uploader`, `/v1/shared/add`). A tick goes now or shows its error; an untick fetches the library first. A Public row's book cover opens its window (`features/shared/PublicBook.tsx`: Read, Add to, In Personal), a manga its chapters; Read makes a copy here, not shared.
- Audiobooks are made on readers' devices only. The server never makes them.
- Reading aloud and finding panels run on the reader's device when it can
  (`frontend/src/features/reader/able.ts`, checked as a book opens, nothing sent). Only a device too
  weak for one uses the server for it, by itself. Two switches: phones and tablets get Read on
  server in the voice sheet, on by default (`readsOnServer`, `voice/prefs.ts`); every device that can
  find panels gets Panels on server in Aa, in the Panels layout, off by default (`serverPanels.ts`).
  Panels are found ahead only in the Panels layout (`pagesAhead`); elsewhere only on a tap to zoom.
- Kept panels (`page_panels`) from an earlier model round move to `page_panels_archive` as the API
  starts (`archiveOlder`, `server/src/panels/kept.ts`), so readers get only the live round's.

- The owner's accounts (`SPEECH_EMAILS`) get thumbs in the Panels layout: on a panel (`panel_votes`)
  and on the page whole (`page_votes`), also on a page the model gave no panels for
  (`frontend/src/features/reader/panelVotes.ts`, `server/src/routes/panels.ts`). Panel votes in
  Settings turns them off and on, on that device. Panel votes only check a round, by their own
  corners; page votes are to learn from (`ai/panels/README.md`, The owner's votes).

- ADR 0004 (`docs/adr/0004-multi-cloud.md`), live since 2026-11-24 in part: the Azure API
  (`az1.breader.site`, Southeast Asia, `infra/azure/`) and its own Suwayomi are standby, asleep
  until the AWS machine's `watch.sh` sees the ThinkPad miss 10 minutes; the app asks
  `VITE_API_STANDBY` only while home is away. Modal is the engine on call for Azure alone.
  GCP (`gcp.breader.site`, Oregon, `infra/gcp/`) is in `VITE_API_SERVERS` for the Americas: an
  e2-micro, IPv6 only, WARP on only while `update.sh` pulls a new image, one HTTP/2 tunnel
  connection (egress counts: `infra/README.md`, GCP), API calls alone (`JSON_ONLY`, no manga, voice or panels; its
  `/health` says `jsonOnly` and the app asks home or Azure for those), egress counted, a standby
  feeder (run only while `COPY_URLS` lists a copy). Not set up yet: the storage pool over R2, B2, Tigris and Fastly (`POOL_MEMBERS`,
  `server/src/manga/pool.ts`). The app skips a server whose `/health` says `busy`, never uses one
  near its egress limit, and asks the next server for the voice and panels when home is away.

## In progress

- ADR 0001 (`docs/adr/0001-four-servers.md`): 4 servers, regional read copies, edge-cached
  pages, the app picks the server (no Worker). Point 1 built: pages and covers are public
  (`shared/src/public.ts`), skip CORS, sent with no cookie; errors are `no-store`. Live since 2026-11-07, kept by a
  Cloudflare Cache Rule (`infra/README.md`). Built, not shipped: points 5 to 7 and the app picking,
  for any servers and databases. Not built: points 3 and 4, and the busy sign.
- Load tests: `infra/load/` (run inside Docker's network): `readers.mjs` for the API,
  `voices.mjs` for the engine. How-to and numbers in `docs/load-tests.md`.

## Working here

- Tests run from the Docker test stack, not this checkout (see the owner's memory notes).
- Server tests: `npm test -w server` (needs the stack). App tests: `npm test -w frontend`.
- Every feature a reader can use goes in the guide (`frontend/src/features/guide/list.ts`): a line on
  what it does and where it is. A new one gets `since` (its day), so readers from before see it as New.
- Migrations only add (a table, a nullable column). Removals ship a release later.
- What's new notes (`frontend/src/features/news/notes.ts`): ask the owner for every single line
  before adding it; never decide alone. Shown once in a dialog, once only for an account, an address
  and a device (`server/src/routes/news.ts`). Notes up to `QUIET_THROUGH` show to no one.
  A note's `demo` adds See how, the start page's video for it (`guide/Demo.tsx`).
- Never print `infra/.env` or any secret.
- Commits: one line, `type: message`. No em dashes. No Claude attribution.
- Keep this file, `infra/README.md` and the ADRs in step with every change.
