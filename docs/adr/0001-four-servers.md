# ADR 0001: Four servers, one writer, the edge as storage

- Status: proposed, 2026-11-07. Points 1 to 8 and "the app picks" are decided by the owner.
  So is how the app picks. Points 9 to 17 wait for the owner's yes.
- Goal: far more readers at once, from anywhere, still $0 a month.

## Where we are (checked 2026-11-07)

- Load tests (`docs/load-tests.md`, 2026-11-07): the old "fails at 150" was Docker's port
  forwarding on the Mac. On the test stack one API copy served 1,200 readers clean; its wall is
  its one main thread, not the database pool. 4 copies on one port served 2,100 clean, saves
  p95 90 ms. Copies are not safe in production yet (pacing, disk budgets, jobs per copy).
- The ThinkPad runs everything: API, worker, Redis (1 GB), 100 GB of manga pages, Suwayomi,
  voices, the panel finder. It sits behind a Cloudflare Tunnel at `api.breader.site`.
- One Render free service (`fb.breader.site`, Singapore) is a fallback only.
- Supabase in Mumbai is the one database. The ThinkPad keeps a copy, fed by
  `server/src/mirror/feed.ts` from `change_log`.
- The API reads only from Supabase. The ThinkPad's copy is used for health, admin, backups and
  drills, not for answering readers.
- The API's database pool is 5 connections (`server/src/db/client.ts`).
- Manga pages and covers are public and kept by Cloudflare (point 1, live 2026-11-07).
- Browse's AniList lists, AniList search and `/manga/anilist/names` are all
  `private, max-age=600`, so Cloudflare keeps none of them.
- `feed_state` has one row: one cursor (`ack_txid`, `ack_id`) for one copy.
  `pruneReadFeed` deletes what that one copy has read, an hour later.
- `page_panels` is not fed. It has no `version` column and no feed triggers.
- MangaDex allows 4 calls a second and 35 new chapters a minute per address. The ThinkPad keeps to
  that for its one address.
- The names index (`server/src/manga/names.ts`) and the AniList warm-up live in each server's
  memory.
- The app knows two servers (`frontend/src/lib/api.ts`): `primary` and `fallback`, and switches on
  a timeout or a gateway error.

## Decided

1. **Pages and covers are public and edge-cached.** The signed-in rule on page routes goes. Pages
   and covers are sent `public` with a long `max-age`, so Cloudflare keeps them near the reader.
2. **ThinkPad stays the main server, plus 3 Renders.** Three more Render free services, each in
   its own Render account and region (for example Singapore, Frankfurt, Oregon). Each account has
   its own 750 free hours, so each can stay awake all month. UptimeRobot pings each `/ready`
   every 5 minutes, as it does `fb.` today.
3. **Renders save to the ThinkPad.** What a Render fetches (pages, covers) is sent to the
   ThinkPad's disk. Before a Render fetches from a rate-limited site, it asks the ThinkPad if it
   has it, and takes it from the ThinkPad if so.
4. **All 4 servers share the fetching.** Each server has its own outgoing address, so each gets
   its own MangaDex allowance. Render's outgoing addresses are shared by all Render customers in a
   region, so first: a route that shows each server's outgoing address, and a check of what
   MangaDex really sees from each.
5. **One writer, regional read copies (GitHub's model).** Mumbai Supabase stays the only writer.
   Each Render account gets a free Supabase in its own region, a read-only copy fed by the same
   feed code as the ThinkPad's copy. Reads go to the nearest copy. After a reader writes, that
   reader's reads go to Mumbai for 30 seconds, so they always see their own writes.
6. **`change_log` is cleared only up to the slowest copy.** Each copy keeps its own cursor in
   Supabase. Pruning keeps every record some copy has not read yet (up to the 14-day limit that
   exists today).
7. **`page_panels` is fed.** It joins `FED_TABLES`, so every copy has panels.
8. **No regional buckets for pages.** Cloudflare's edge is the regional storage.

### Point 1, as built (2026-11-07)

- `shared/src/public.ts` lists the public paths: pages, a source chapter's page count, covers.
- No sign-in on them. Pages are sent `public, max-age=2592000` (30 days, owner's choice). Covers
  keep their own time (60 s to 7 days, `manga/covers.ts`) and tag, now `public`. Page counts
  `public, max-age=300`.
- They answer `Access-Control-Allow-Origin: *` with no credentials and no `Vary`, and skip Hono's
  `cors()` (`server/src/app.ts`). The app asks for them with no cookie (`frontend/src/lib/api.ts`).
- Every error, on every route, is sent `no-store` (`neverKept`, `server/src/lib/errors.ts`).
  Hono lays headers a route set before it failed over the error's own, so it is set on the
  answer being made.
- Cloudflare needs a Cache Rule for these paths (owner's choice over file endings), plus Smart
  Tiered Cache: `infra/README.md`, Edge cache for pages and covers.

Checked 2026-11-07 (Cloudflare and Render docs, and live headers):

- Cloudflare caches by file ending only. A live cover on `api.` said `cf-cache-status: DYNAMIC`.
- It keeps nothing `private`, `no-store`, `no-cache`, `max-age=0`, or with `Set-Cookie`.
- With no `Cache-Control`, it keeps a 200 for 120 minutes and a 404 for 3. Hence `no-store` on
  errors.
- It ignores `Vary` (except `Accept-Encoding`), but its default cache key holds the request's
  `Origin` header and the query string.
- How long it keeps a page: no set time; least used goes first.
- Tiered cache (Smart Topology) is on the free plan. It was off for breader.site; turned on
  2026-11-07.
- Free plan: 10 Cache Rules; the regex operator `matches` is Business and up.
- Live, 2026-11-07, after the ship (`e9823e7`) and the Cache Rule: a page and a cover answer
  `MISS` then `HIT` (a 3.9 MB page: 1.45 s, then 0.19 s); `?saver=1` is kept apart; errors say
  `BYPASS`; search and chapter lists stay `DYNAMIC`. `starts_with` works on the free plan.
- `fb.` is DNS only, behind Render's own Cloudflare. Render's edge cache is for paid services, so
  `fb.` pages are not edge-cached. The 3 Renders of point 2 would be the same unless proxied
  through breader.site's zone: not checked yet.

## To propose (each needs the owner's yes before building)

9. Edge-cache answers that are the same for every reader: Browse's AniList lists, AniList search,
   and `/manga/anilist/names`. All three are `private` today (checked).
10. Covers: Browse asks for 24 covers while 9 show, and picks 512 px on dpr 3 phones (covers are
    113 CSS px wide). Slow 4G, measured 2026-11-07: 1,258 KB and 8.5 s to fill the screen, against
    587 KB and 4.3 s at 256 px. Smaller covers, on-screen ones first.
11. Warm AniList lists deeper than `ANI_WARM_PAGES=20` and `ANI_WARM_KIND_PAGES=5`. Past those,
    cards are looked up one at a time, 12 to 24 s each.
12. Renders take AniList lists and names from the ThinkPad, like point 3. Otherwise 4 servers make
    4 times the AniList calls. Whether AniList limits per address: not checked yet.
13. A MangaDex 403 already turns into a 422 `manga_refused`. It will show if MangaDex refuses a
    Render's shared address.
14. Keep HTTP/2 end to end. Over HTTP/1.1 the browser's 6 connections to one host filled with slow
    card lookups and a names ask timed out after 5 s. `api.breader.site` answers over HTTP/2.
    Through a Worker: not checked yet.
15. Keep Browse's caches on the device. Today they are in-memory Maps only (`Browse.tsx`,
    `aniPick.ts`, `copies.ts`), lost when a phone drops the page. The rest of the app's saved
    data: not checked yet.
16. Rewrite the phone scripts that measure what a reader feels (Browse first show, covers on slow
    4G, scroll frames) for the load test. The old ones are gone.
17. Fake 4 servers for the load test with side copies of the API next to the Docker test stack
    (the `breader-server:manga` image on the stack's networks, its own env file, another port).

## Decided 2026-11-07: the app picks the server

No Worker in front. The app picks the server itself, as `frontend/src/lib/api.ts` already does
for two.

How it picks (owner's yes, 2026-11-07):

- At start, and every few minutes, the app asks each server's `/health` and times the answer.
- The ThinkPad is used unless it is down, says it is busy, or is much slower than the quickest
  Render (a far reader).
- The intent (owner): readers in Asia use the ThinkPad, readers on other continents their own
  region's Render. Timing each server gives that without a country list, and follows the
  network as it really is.
- Otherwise the quickest Render. A timeout or gateway error moves to the next one, as today.
- `/health` gains a busy sign from the ThinkPad. What counts as busy, and how much slower is
  "much slower": set from the first load test's numbers.

## Was open: the load balancer

Proposed then: a free Cloudflare Worker in front of all 4 servers.

- It routes by the reader's country and a busy sign from the ThinkPad.
- ThinkPad first. Renders when it is busy or down, or for readers far away.
- Database work prefers the ThinkPad or Mumbai.

Checked 2026-11-07 (Cloudflare's Workers limits page): the free plan gives 100,000 requests a
day (reset at midnight UTC) and 10 ms of CPU a request. Past the limit, the route fails open (the
Worker is skipped) or closed (error 1027). One reader reading manga asks for hundreds of pages an
hour, so a Worker in front of pages would use the day up fast. Whether answers from Cloudflare's
cache count against it: not checked yet.

Other way: the app picks the server itself, as `frontend/src/lib/api.ts` already does for two.
No daily cap, nothing new to run.

The owner chose the app (above).

## Found while writing this (checked)

- Point 5 is new work, not a switch: the API reads nothing from a copy today, not even on the
  ThinkPad (`server/src/api.ts` gives every route Supabase's pool). Each read must be sorted into
  "may come from a copy" and "must come from Mumbai". `backend-design.html` §2 planned browsing
  reads from the copy; the code never did it. The ThinkPad reads its own copy too, by the same
  30-second rule.
- AWS is no free home for the database (checked 2026-11-07, aws.amazon.com/free): new accounts
  get up to $200 of credits, and the account closes after 6 months or when the credits run out.
- Point 5 also needs the copy's feed to run on Supabase. The feed sets
  `session_replication_role=replica` so triggers and foreign keys stay quiet while it replays.
  Whether a free Supabase lets the `postgres` user set that: not checked yet.
- Point 6 needs `feed_state` to become one row per copy, and `lost_txid` per copy. Today only the
  machine holding the jobs lease acks (`hooks.acks`), so two copies don't fight over one cursor.
- Point 7 needs a `version` column on `page_panels`, its two feed triggers, and the
  "Not fed" comment in `schema.ts` and the README changed.
- Supabase free (checked 2026-11-07, supabase.com/pricing): 500 MB a project, 5 GB a month sent
  out, 2 active projects an account, paused after a week unused. Prod uses 32 MB (69 libraries,
  316 books). The owner checked that one person may hold several free accounts. Splitting the
  database is a later step, in `TODO.md` (More room in the database).
- An earlier memory says Render's 750 free hours are per workspace. The owner checked that one
  account each is allowed, so each Render has its own 750 hours.

## Not checked yet

- Render free: RAM, included bandwidth, outgoing addresses per region.
- Cloudflare: Worker free limits, Load Balancing price.
- Supabase free: size, pausing, `session_replication_role`, how many free projects per account.
- Whether AniList limits per address.
- Trip time from each Render region to Mumbai.
- The ThinkPad's home upload speed.
- `page_panels` row count.
- The ThinkPad's trip time to Supabase Mumbai.

## Build order (small pieces, each tested and shown before the next)

1. Load test before anything changes: numbers to beat. Done: `docs/load-tests.md`.
2. Find why 150 failed. Done: Docker port forwarding on the Mac.
3. Route that shows a server's outgoing address. Check what MangaDex sees.
4. Public, edge-cached pages and covers (point 1). Done: live 2026-11-07.
5. Feed: one cursor per copy, prune to the slowest (point 6). Then `page_panels` fed (point 7).
6. Renders ask the ThinkPad first and save to it (point 3).
7. Shared fetching across servers (point 4).
8. Regional read copies and read-your-own-writes (point 5).
9. The app picks among 4 servers.
10. Load test after, same scripts, numbers side by side.

## What this costs us

- More moving parts: 4 servers, 4 databases, one Worker. Each needs a monitor.
- Public pages can be read without signing in. That is the owner's choice (point 1).
- A reader far from Mumbai sees their own writes at Mumbai's speed for 30 seconds after each write.
