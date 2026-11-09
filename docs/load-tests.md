# Load tests

How many readers one API serves at once, and what gives out first.

## The test

`infra/load/readers.mjs`. Each fake reader:

1. Makes a library of its own (`POST /v1/libraries`), with its own address (`x-forwarded-for`).
2. Browse: a page of AniList's popular list, where its series are read, 24 covers, 6 at a time.
3. Search: the names drop-down for "y", "yo", "yot", "yots", then AniList's and the sites' search.
4. A series (Yotsuba to!): its sheet, copies, chapters, and its place saved (`/sync/push`).
5. Reads one of 3 warmed chapters, a page every 5 s, its place saved every 5 pages. Then again.

A page every 5 s is faster than a real reader, so each fake reader is worth more than one real one.

## How to run it

Test stack only (compose project `breader-manga`), never production.

1. Make an env file for the side copy, outside the repo: the stack API's env
   (`docker inspect breader-manga-api-1`), with `CLIENT_IP_HEADER=x-forwarded-for`,
   `PUBLIC_URL=http://localhost:8797`, and `http://localhost:5173` in `ALLOWED_ORIGINS`.
2. Start the side copy: `ENV_FILE=<that file> infra/load/side.sh`. `DIST=` runs a built
   `server/dist/api.js` instead of the image's. `COPIES=` runs that many API copies on one port.
3. Warm the test pages once: `infra/load/inside.sh --warm`.
4. Pause the stack's busy neighbours for clean numbers:
   `docker pause breader-manga-flaresolverr-1 breader-manga-worker-1` (unpause after).
5. Run: `infra/load/inside.sh --readers 1000 --minutes 2 --ramp 30`. Past about 700 readers per
   process, add `GENS=3` (each process runs `--readers` of its own).

Run it from inside Docker's network (`inside.sh`). From the Mac through the published port,
Docker's port forwarding gives out first, near 150 readers.

## Results, 2026-11-07

Dev at `c09b9c3`. A Mac (M5), Docker with 10 CPUs and 7.75 GB. The database is in the next
container, so each trip to it takes well under a millisecond. Manga search took 6 s in every run
with FlareSolverr paused; that is the test, not the code.

From the Mac through the published port (before the cause was found):

| Readers | Requests a second | p95 all | Failed | Note |
|---|---|---|---|---|
| 100 | 50 | 42 ms | 0 | |
| 150 | 73 | 376 ms | 0 | pages p95 776 ms |
| 200 | 80 | 4.7 s | 0.9% | pages time out at 15 s |

From inside Docker's network, quiet stack, one API copy:

| Readers | Pool | Requests a second | p95 all | Saves p95 | Failed |
|---|---|---|---|---|---|
| 800 | 5 | 389 | 27 ms | 29 ms | 0 |
| 800 | 15 | 389 | 28 ms | 28 ms | 0 |
| 1,200 | 5 | 577 | 136 ms | 2.7 s | 0 |
| 1,200 | 15 | 574 | 331 ms | 2.4 s | 0 |
| 2,000 | 5 | 731 | 4.0 s | 9.1 s | 1.0% |

Several API copies on one port (`cluster.mjs`), pool 5 each:

| Copies | Readers | Requests a second | p95 all | Saves p95 | Failed | API memory |
|---|---|---|---|---|---|---|
| 1 | 2,000 | 731 | 4.0 s | 9.1 s | 1.0% | 445 MB |
| 2 | 2,000 | 951 | 499 ms | 509 ms | 0 | 783 MB |
| 2 | 2,100 (3 processes) | 1,010 | about 140 ms | about 2.8 s | 0 | 766 MB |
| 4 | 2,100 (3 processes) | 1,018 | about 72 ms | about 90 ms | 0 | 1.08 GB |

A 4-copy run with one load process (2,000 readers) failed 1.4%, but the load process sat at 99%
of a core and its own timers ran late (answers "took" 71 s against a 15 s timeout). It measured
itself, so it is left out. The 3-process runs also peaked near 99% a process, so the 4-copy
numbers may be better than shown.

## What was found

- The old "fails at 150" was Docker's port forwarding on the Mac, not Breader.
- One API copy's wall is its one main thread (about 100% of a core), not the database pool.
  Pool 5 and pool 15 measured the same with the database next door.
- With 2 copies, 2,000 readers ran clean. With 4, saves dropped from about 2.8 s to 90 ms at p95.
- CPU profile of one copy at 1,200 readers (`--cpu-prof`):
  - About 18%: copying each page and cover. Hono's CORS adds `Vary: Origin` after the route
    answers, which rebuilds the answer as a real `Response` and copies its bytes
    (`hono/dist/middleware/cors`, `c.header` after `next()`). Fixed: pages and covers skip it
    (below).
  - About 10%: the names drop-down's `distance` (`server/src/manga/names.ts`).
  - About 9%: garbage collection. About 8%: writing to sockets.
- A place save makes about 12 trips to the database: one for the session, then about 10 inside
  one transaction (`server/src/routes/sync.ts`). In production every trip goes to Mumbai.
- Supabase free (Nano, checked 2026-11-07, supabase.com/docs/guides/platform/compute-and-disk):
  60 direct connections, 200 pooler clients, 15 queries at once (default pool size).

## Public pages and covers, before and after (2026-11-07)

ADR 0001, point 1: pages and covers skip CORS and need no sign-in. Same test, 1,200 readers
(`GENS=2`, 600 each), 2 minutes, one API copy, quiet stack. Built `server/dist/api.js` of each,
run in turn: before, after, before, after. CPU is the API container's average (`docker stats`).

| Run | Requests a second | p50 | p95 all | Pages p95 | Covers p95 | Saves p95 | Failed | CPU |
|---|---|---|---|---|---|---|---|---|
| Before, 1 | 561 | 42 ms | 874 ms | 330 ms | 140 ms | 7.8 s | 31 (0.04%) | 228% |
| After, 1 | 583 | 3 ms | 17 ms | 18 ms | 13 ms | 17 ms | 0 | 119% |
| Before, 2 | 581 | 10 ms | 118 ms | 110 ms | 75 ms | 994 ms | 0 | 174% |
| After, 2 | 583 | 3 ms | 15 ms | 15 ms | 11 ms | 14 ms | 0 | 113% |

- After: about half the CPU, and every kind of answer is quicker, saves too, as the one main
  thread is no longer busy copying pages.
- The two "before" runs differ a lot (874 ms and 118 ms at p95); the two "after" runs don't.
  Why "before, 1" was slower is not checked yet. The failures there were saves answering 500.
- Cloudflare keeping pages (once the Cache Rule is in) takes most page asks off the server too;
  not measured here.

## Voices, audiobooks and panels: the engine (ADR 0002)

`infra/load/voices.mjs`, against an API with an engine (`ENGINE_URLS`). Test stack only, never
production. It runs at once:

- `--live N` readers reading aloud on the server, as the app does: passages of `--passage`
  sentences, a sentence playing while the next two are asked for, a few seconds' rest between
  passages. Each logs in to `OWNER_EMAIL` (`OWNER_PASSWORD`), an account in the API's
  `SPEECH_EMAILS` with its address confirmed, so each has a line of its own. Reported: first sound
  (each passage's first sentence), each sentence, stalls (playing waits for the next).
- `--books N` libraries each making an audiobook of `--paragraphs` paragraphs (40, 3 sentences
  each). Reported: paragraphs made a minute.
- `--panels N` readers having a chapter of Yotsuba to!'s panels found, a page every `--page-ms`.
  Clear `page_panels` first: pages found before are kept.
- Every second it reads `/health`: the most workers busy and jobs waiting.

How to run it:

1. A side copy of the API and an engine, built from this checkout (`npm run build -w server`),
   on the test stack's network, with `SPEECH_EMAILS` holding the test account. Each run starts
   them afresh with the voices volume's `books/` and `said/` emptied, so no book is left from a
   run before and no sentence comes from the said-cache (the test's sentences are new each run
   anyway).
2. `docker run --rm --network <the stack's network> -v "$PWD/infra/load:/load:ro" -e OWNER_EMAIL
   -e OWNER_PASSWORD <the server image> node /load/voices.mjs --base http://<api>:8787 --live 1
   --books 12 --minutes 2`
3. Books made a second: the change in `/admin/engine`'s `done.book` between 30 s and 90 s in.

Stop a run by removing its container (`docker rm -f`), not only the shell that started it: a
`docker run` left behind keeps loading the engine, and spoils the next run's numbers.

### Results (2026-11-08)

The test stack on this desktop (Docker: 16 threads of 8 cores, 16 GB), the defaults (4 workers of
4 threads, `ENGINE_BESIDE_LIVE` 0), Kokoro `af_heart`, `--passage 2`, about 1.7 minutes a run.

| Load | First sound p50 / p95 | A live sentence p50 | Audiobooks, paragraphs a minute | Panels, a page p50 / p95 |
|---|---|---|---|---|
| `--live 1` | 949 ms / 1.0 s | 1.3 s | | |
| `--live 1 --books 1` | 1.1 s / 1.2 s | | 1.1 | |
| `--live 1 --books 4` | 1.3 s / 1.3 s | | 0.6 | |
| `--live 1 --books 12` | 1.2 s / 1.3 s | | 0 (they wait) | |
| `--live 2 --books 12` | 1.0 s / 1.5 s | 1.8 s | 0 (they wait) | |
| `--live 0 --books 12` | | | 44.2 (2.21 sentences a second) | |
| `--live 1 --panels 2` | 1.1 s / 1.2 s | 1.7 s | | 484 ms / 1.0 s, 92 pages |

`--live 1 --books 12` with `ENGINE_BESIDE_LIVE` set higher (books may use that many workers while
someone reads aloud):

| `ENGINE_BESIDE_LIVE` | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| First sound p50 | 1.2 s | 1.6 s | 1.9 s | 2.1 s |
| Paragraphs a minute | 0 | 15.3 | 27.8 | 37.5 |

- First sound stays near a second, whatever else runs. Books wait while anyone reads aloud, and
  take every worker but one when no one does.
- No stalls in any run: the next sentence was always ready before the one playing ended.
- The panel run's first try had 18 pages answered 409: the load test took a seat once and never
  kept it, so it was given up after 75 s. Fixed (it keeps it every 30 s, as the app does); the
  numbers above are from the run after, with none failed. With the seat kept, panels ran the whole
  run, so first sound there is a little slower than reading alone.

## What each API copy keeps to itself

Before several copies can run in production, each of these needs one shared place (Redis, or
one copy that owns it):

- Disk budgets of the page cache and the archive (`manga/disk.ts`, `lib/archive.ts`): an index
  and a total in memory. Each copy would think it had the whole budget.
- Pacing for MangaDex (4 a second, 35 chapters a minute), AniList and Suwayomi (`manga/pace.ts`).
  The site would see that many times the calls from one address.
- Rate limits (`lib/http.ts`): each copy would allow the full amount.
- Background jobs in `api.ts` (Browse warm-up, prefetch, keeper, Gemini fill): no lock, so every
  copy runs them. Admin commands are fine: one copy takes each.
- Panel seats (`panels/`): 8 seats per copy.
- The engine's scheduler (`engine/`): each copy would hand out the engines' workers as if it had
  them alone, and make the same audiobooks from the shared `voices/books/`.
- In-memory layers of the caches (AniList lists, names, covers): fine, but memory once per copy.

## Not checked yet

- The ThinkPad's CPU and memory use. It can't be reached from the Mac on another network.
- The trip time from the ThinkPad to Supabase in Mumbai, so the pool size for production.
- More than 4 copies, or more load processes.
- How the ThinkPad's CPU compares with the Mac's.
