# ADR 0003: Readers' next chapters in R2

- Status: proposed, 2026-11-18. Waits for the owner's yes.
- Goal: the pages readers are about to read come from Cloudflare R2, not from the ThinkPad or
  Render. The ThinkPad's home connection sends each page once, and those chapters still open when
  the ThinkPad and Render are both away (MangaFire too, which Render can't reach).

## Today

- Pages go reader ← Cloudflare's edge cache ← the tunnel ← the ThinkPad (ADR 0001, point 1). Smart
  Tiered Cache is on, so a page leaves the ThinkPad about once per upper-tier data centre, until
  Cloudflare drops it from its cache, which it may do at any time.
- The ThinkPad's keeper (`server/src/manga/keeper.ts`) already fetches every library series, the
  chapter read to and 10 after it, onto its SSD, a turn every 15 minutes.
- On Render, Suwayomi's sites come from the AWS Suwayomi; MangaFire there is shut (Cloudflare bans AWS).

## Decided (owner, 2026-11-18)

1. Each reader's most recently read manga, the chapter they're on and the 25 after it, go into R2.
2. R2 stays free: pages only take the room left under R2's free 10 GB (9 GB, a margin kept). When
   they don't all fit, the series read longest ago leave first.

## Proposed

3. A bucket of its own, `breader-pages`, public on `pages.breader.site` (Cloudflare serves it and
   caches it at the edge; no server in the way). `breader-files` stays private.
4. The address of a page: `c/<chapter key>/<n>`, the key being the first 32 hex characters of
   SHA-256 of the chapter's id. Next to them `c/<key>/index.json`: `{ "pages": n }`. Every object is
   sent with `cache-control: public, max-age=2592000, immutable`.
5. Which: per library, its 3 manga read most lately in the last 30 days (2026-11-18: 45 series in
   49 libraries), each from the chapter read to, 25 ahead, the way Read picks uploads
   (`pickChapters`). A series in several libraries counts once.
6. Who: the keeper, on the ThinkPad only. After keeping a chapter on the SSD it puts its pages and
   then its index (the index last, so a half-sent chapter is never used). The pages come off the SSD,
   so nothing is fetched twice.
7. Room: once a day the keeper lists the other buckets for their size, and the pages may use what's
   left under 9 GB. It knows its own bucket by a listing at start, then by what it puts and removes.
   A chapter no longer wanted, or past the room, is removed (removing is free in R2).
8. Writes: R2 gives 1,000,000 a month free. The keeper counts its writes each month and stops
   putting at 900,000, saying so on the admin page. Measured 2026-11-18: a chapter is 20 to 163
   pages (5 to 19 MB), so filling 9 GB is about 100,000 writes.
9. The app: before a chapter's pages, it asks `pages.breader.site/c/<key>/index.json` (one ask a
   chapter). Found, every page comes from R2; any page that fails there comes from the server, as
   today. Not found, it's today's path. MangaDex's data-saver pages always come from the server.
10. MangaDex: its rules say apps must pass its pages through their own server (done) and say nothing
    against keeping copies. Its pages go in R2 like the others.
11. While the ThinkPad is away, Render reads a MangaFire series from its Weeb Central copy
    (`books/remote.ts` readFrom), whose chapter ids differ, so those chapters miss R2. Accepted.

## Setting up (owner, once)

- Cloudflare › R2: create `breader-pages`, connect the custom domain `pages.breader.site`, CORS for
  `https://breader.site`, GET and HEAD.
- The `breader-laptop` R2 token gets Object Read & Write on `breader-pages` too.
- `PAGES_BUCKET=breader-pages` and `PAGES_URL=https://pages.breader.site` in `infra/.env`;
  `VITE_PAGES_URL` in `infra/.env.ship`.
