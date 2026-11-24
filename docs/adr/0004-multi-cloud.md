# ADR 0004: Free servers on several clouds

- Status: built on branch `feat/multi-cloud`, 2026-11-24. Not deployed; no account is wired up.
- Goal: more servers near readers for $0, without a new writer. Readers keep reading when the
  ThinkPad is off, and the costly parts (pictures, the voices) go where they're free.

## Decided (owner)

1. Supabase Mumbai stays the only writer. No Xata, no second primary.
2. The servers the app picks from (ADR 0001): the ThinkPad (home), Render, one Azure Container
   App (Southeast Asia; the free plan allows one environment a subscription), and a GCP
   e2-micro. GCP and Modal are each easy to leave out (below).
3. Pages live in a storage pool of free buckets: R2, Backblaze B2, Tigris and Fastly. No cold tier:
   Breader's backups stay in R2 `breader-backups`, and cold manga stays on the ThinkPad's disk.
   (Storj was dropped: it has no free tier today. Paribelle's backups move to MEGA, outside Breader.)
4. The voices and the panel model have a fallback engine on Modal, which stops when unused.

## Built

### Reads from the copies

- Any server may keep a read copy on any Postgres (`COPY_URL`) and feeds it itself, with no
  superuser, foreign keys on and checked as each batch ends (`server/src/mirror/copy.ts`).
- Safe reads come from the copy (`c.var.read`, `server/src/db/reads.ts`): panels kept, the voice
  list and voice file links, the AI's notes, file lists. Writes, and a reader's reads right after
  their own write, go to Mumbai.

### The storage pool (`server/src/manga/pool.ts`)

- `POOL_MEMBERS` lists the buckets, home first (R2). A chapter's pages go to one bucket with room;
  its index (`c/<key>/index.json`, `{pages, base}`) is always in the home bucket, and the app reads
  the pages from `base`.
- Room per bucket: its size the owner set (`POOL_<NAME>_MB`), less its chapters, less every other
  bucket on that account (measured daily). An optional monthly writes limit (`POOL_<NAME>_WRITES`).
- A table, `pool_chapters`, is the ledger, so several servers can put at once without going over.
- The ThinkPad's keeper fills it with readers' next chapters, letting go of those wanted least.
  Regional servers (`POOL_UPLOADS`) put a chapter once a reader has read it from them, only where
  there's room. The ThinkPad, whenever it's up, reads a chapter from the pool before the site.
- Public addresses: R2 through Cloudflare; B2, Tigris and Fastly through CloudFront.

### GCP: JSON only, egress counted, a standby

- The VM has IPv6 only (a public IPv4 costs money). Readers come in through a Cloudflare Tunnel.
  Outgoing IPv4 (MangaDex, ghcr.io, GitHub) goes through Cloudflare WARP. Supabase's poolers have no
  IPv6, so GCP uses the direct host `db.<ref>.supabase.co`. `infra/gcp/setup.sh` and `compose.yml`.
- MangaDex sees a shared Cloudflare WARP address there. Whether it rate-limits that: not checked yet.
- `JSON_ONLY`: it sends no pictures or sound. A page the pool holds is a 302 to the pool's CDN;
  anything else a 302 to `MEDIA_ELSEWHERE` (an Azure server), or a 503 `media_elsewhere`, and the
  app asks the next server (`server/src/lib/media.ts`).
- Egress: the network card's sent bytes, counted for the month (`server/src/lib/egress.ts`). At
  `GCP_EGRESS_LIMIT_MB` (owner: 800 of the free 1 GB), `/health` says `egress.near`, the app stops
  using it, and the standby stops feeding.
- The standby (`server/src/standby.ts`, `server/src/mirror/standby.ts`): the ThinkPad's worker says
  it's up each 30 s (`worker_seen`) and, while it leads, feeds every copy in `COPY_URLS`. When the
  ThinkPad hasn't been heard from for 90 s and its lease has lapsed, the standby takes the lease and
  feeds them. It hands back as soon as the ThinkPad is heard from again.

### Modal: an engine on call (`infra/modal/engine.py`, `server/src/engine/index.ts`)

- The same image, protocol (`/v1/info`, `/v1/run`) and `ENGINE_TOKEN` as the ThinkPad's engine.
  One container at most, gone after two quiet minutes.
- `ENGINE_FALLBACK_URLS`: a job goes there only when every engine in `ENGINE_URLS` is down or
  turns it away as busy. Azure and GCP list Modal alone. The API asks it nothing until a job comes,
  and nothing again after two quiet minutes, so it can stop.
- The app never calls Modal itself: it asks home for the voice and panels, and the next server
  when home is away (`frontend/src/lib/api.ts`).

### The app picks (`frontend/src/lib/servers.ts`, `api.ts`)

- A server whose `/health` says `busy` (`BUSY_LAG_MS`, the event loop's p95 delay; off unless set)
  isn't picked, but is tried when the one in use is down. One that says `egress.near` isn't used.

## Leaving parts out

- GCP: don't create the VM and leave it out of `VITE_API_SERVERS`. The ThinkPad's worker feeds the
  copies as before; with it off, they wait.
- Modal: don't set `ENGINE_FALLBACK_URLS`. Azure and GCP then have no voices or panels (devices do
  their own), as on Render.

## Not checked yet

- cloudflared and WARP side by side on one VM; WARP on Debian trixie; the card name `ens4`.
- The Supabase direct host over IPv6 from GCP; the GCP memory fitting 1 GB.
- Free limits for Tigris and Fastly writes and requests; CloudFront in front of B2, Tigris, Fastly.
- Modal: the image with `add_python`, its `node` user and the voices volume; request time limits.
- Azure: the free grant against one region; cold starts against the app's timing; the reader's
  address behind Cloudflare (`cf-connecting-ip`).
