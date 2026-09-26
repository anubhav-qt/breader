# Running Breader

Every write lands in Supabase first. The laptop keeps a live copy, answers the app, and runs the
background work. A free Render server answers while the laptop is off. The app is static files on
Cloudflare Pages, and book files live in Cloudflare R2. Everything is on free plans; the domain
is the one cost. `breader.example` stands in for the real domain below.

| Address | Goes to | Runs |
| --- | --- | --- |
| `breader.example` | Cloudflare Pages | the app |
| `api.breader.example` | Cloudflare Tunnel → the laptop | `api` (ROLE=laptop), plus `worker`, `mirror`, `tunnel` |
| `fb.breader.example` | Render, Singapore | the same image as ROLE=fallback |
| — | Supabase, Mumbai | Postgres, the source of truth |
| — | Cloudflare R2 | book files (`breader-files`) and backups (`breader-backups`) |

The app calls `api.` and switches to `fb.` when `api.` fails: a network error, a 4-second timeout,
or a 502/503/504/530. Every write carries an id and applies once, so the retry is safe. While on
`fb.`, it checks `api.` every minute and moves back when it answers.

## Local development

```sh
npm install
npm run stack      # Postgres ×2, RustFS (stands in for R2), api :8787, fallback :8788, worker
npm run web        # the app on http://localhost:5173
npm test           # server tests; need the stack running
npm run stack:down
```

`http://a.localhost:5173` and `http://b.localhost:5173` act as two separate browsers for trying
sync and "Open library". To watch failover, run `docker compose -f infra/compose.dev.yml stop api`;
the app moves to :8788 within one request. Start it again and the app moves back within a minute.
`infra/dev.env` and `infra/dev-backup.agekey` are throwaway local values, safe to commit.

## Setting up production

Do these in order. Each step says which settings it produces; they go in `infra/.env` (from
`.env.example`), Render, Cloudflare Pages, or GitHub. Save `infra/.env` in your password manager.

### 1. Domain

Buy the domain at Cloudflare Registrar, so its DNS is already on Cloudflare.

### 2. Supabase

1. New project, region **South Asia (Mumbai)**, a strong database password.
2. Project Settings › Data API: turn it **off**. The app never uses it, and every table already
   has row-level security with no policies.
3. **Connect** shows the connection strings. Put in the password:
   - Transaction pooler (port 6543) → `PRIMARY_URL`
   - Session pooler (port 5432) → `PRIMARY_SESSION_URL`, and the GitHub secret `SUPABASE_SESSION_URL`

Both poolers work over IPv4. The direct connection is IPv6-only on the free plan. Free projects
pause after 7 days without activity; the worker and the monitor on `fb.` keep it active.

### 3. R2

1. Create buckets `breader-files` and `breader-backups`.
2. `breader-files` › Settings › CORS policy:
   ```json
   [{ "AllowedOrigins": ["https://breader.example"], "AllowedMethods": ["GET", "PUT", "HEAD"],
      "AllowedHeaders": ["content-type", "x-amz-checksum-sha256"], "ExposeHeaders": ["ETag"], "MaxAgeSeconds": 3600 }]
   ```
3. `breader-backups` › Settings › Object lifecycle rules: delete prefix `daily/` after 7 days and
   prefix `weekly/` after 28 days.
4. Manage API tokens, two tokens:
   - **laptop**: Object Read & Write on both buckets → `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`
   - **render**: Object Read & Write on `breader-files` only
5. The S3 endpoint `https://ACCOUNT_ID.r2.cloudflarestorage.com` → `S3_ENDPOINT`.

### 4. Backup key

```sh
brew install age
age-keygen -o breader-backup.agekey   # prints "Public key: age1…"
```

The public key goes in `BACKUP_RECIPIENT`. Keep the key file in your password manager and **delete
it from the laptop**. Backups are encrypted to it, so the laptop can write them but can't read them.

### 5. Secrets

```sh
openssl rand -base64 48   # KEY_PEPPER
openssl rand -base64 48   # SESSION_SECRET
openssl rand -hex 24      # MIRROR_PASSWORD
```

The laptop and Render need the same `KEY_PEPPER` and `SESSION_SECRET`. Changing `KEY_PEPPER` stops
every library key from working, and changing `SESSION_SECRET` signs every reader out.

### 6. GitHub

1. Push the repository. The first push to `dev` builds `ghcr.io/OWNER/breader-server`.
2. Your profile › Packages › breader-server › Package settings: make it **public**, so the laptop and
   Render can pull without credentials. It holds code only, no settings.
3. Settings › Secrets and variables › Actions: `SUPABASE_SESSION_URL`, then `RENDER_DEPLOY_HOOK`
   after step 8.

`IMAGE` in `infra/.env` is `ghcr.io/OWNER/breader-server:latest` (owner in lowercase).

### 7. The laptop

1. Docker Desktop › Settings › General: **Start Docker Desktop when you sign in**.
2. System Settings › Battery › Options: **Prevent automatic sleeping on power adapter when the
   display is off**. A closed lid still sleeps the Mac; Render answers until it wakes.
3. Cloudflare Zero Trust › Networks › Tunnels › Create a tunnel › Cloudflared, named
   `breader-laptop`. Choose Docker and copy the token after `--token` → `TUNNEL_TOKEN`. Under
   Public Hostname add `api` · `breader.example` → service **HTTP**, URL **`api:8787`**.
4. Fill in `infra/.env`, then:
   ```sh
   chmod 600 infra/.env
   docker compose -f infra/compose.yml up -d
   docker compose -f infra/compose.yml logs -f worker   # "copy reloaded", then "worker running"
   infra/update.sh --install                            # pull new releases every 5 minutes
   ```
5. `curl https://api.breader.example/ready` shows `"role":"laptop"` and the copy's lag.

### 8. Render

New › Web Service › **Existing image** `ghcr.io/OWNER/breader-server:latest`, region
**Singapore**, instance **Free**, health check path `/health`. Environment:

```
ROLE=fallback            NODE_ENV=production      PRIMARY_URL=<transaction pooler URL>
PRIMARY_SSL=require      KEY_PEPPER=<same>        SESSION_SECRET=<same>
ALLOWED_ORIGINS=https://breader.example           COOKIE_DOMAIN=breader.example
COOKIE_SECURE=true       S3_ENDPOINT=<same>       S3_BUCKET=breader-files
S3_REGION=auto           S3_FORCE_PATH_STYLE=true
S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY = the render token (files bucket only)
```

Leave out `MIRROR_URL`, `S3_BACKUP_BUCKET`, `BACKUP_RECIPIENT` and `TUNNEL_TOKEN`; the fallback
has no copy and makes no backups. Render sets `PORT` itself.

Settings › Custom Domains: add `fb.breader.example`, then in Cloudflare DNS add the CNAME it shows,
**DNS only** (grey cloud). Settings › Deploy Hook → GitHub secret `RENDER_DEPLOY_HOOK`.

### 9. Cloudflare Pages

Workers & Pages › Create › Pages › connect the repository, production branch `dev`:

- Build command `npm ci && npm run build -w frontend`, output directory `frontend/dist`, root `/`
- Environment variables `VITE_API_URL=https://api.breader.example`,
  `VITE_API_FALLBACK_URL=https://fb.breader.example`, `NODE_VERSION=24`
- Custom domain `breader.example`

### 10. Monitoring

UptimeRobot, free, every 5 minutes, alerts by email or Telegram:

| Monitor | Why |
| --- | --- |
| `https://fb.breader.example/ready` | keeps Render awake (it sleeps after 15 idle minutes) and Supabase active |
| `https://api.breader.example/health` | the laptop is reachable through the tunnel |
| `https://breader.example` | the app is up |

Add a heartbeat check with a 5-minute period and 5 minutes' grace, and put its URL in
`HEARTBEAT_URL`. The worker pings it only while the copy is less than a minute behind. So an alert
means the worker stopped, the laptop is off, or the copy is stuck. UptimeRobot heartbeats need a
paid plan at the time of writing; Healthchecks.io's free plan has them.

## Day to day

**Shipping.** Push to `dev`. CI tests, publishes the image, migrates Supabase and redeploys
Render. The laptop picks the image up within 5 minutes, and Pages rebuilds the app. For those
minutes the laptop and Render can run different versions. So a migration only ever adds: a new
table, or a nullable column. Removals ship in a later release, once no running version reads them.
`/health` shows each server's `release` (the commit).

**Status.**

```sh
curl -s https://api.breader.example/ready   # primary up, the copy's lag
curl -s https://fb.breader.example/ready
docker compose -f infra/compose.yml ps
docker compose -f infra/compose.yml logs --since 1h api worker
tail infra/update.log
```

**Backups.** After 03:00 each night the worker dumps the copy, encrypts it to the backup key, and
keeps 14 nights in the `backups` volume. It also uploads each dump to `breader-backups/daily/`,
and Sunday's to `weekly/`.

## When something breaks

**The laptop is off or broken.** Nothing to do: the app is on Render. For a new laptop, run step 7
with the saved `infra/.env`. The worker rebuilds the copy from Supabase and downloads every file
from R2.

**Supabase is lost or corrupted.** If the laptop is running, its copy is seconds behind, so
you lose almost nothing. Otherwise you lose what changed since the last backup, up to a day.

1. Stop writers: Render › Settings › **Suspend**, and
   `docker compose -f infra/compose.yml stop api worker`. The app keeps working offline, and
   readers' changes wait in their browsers.
2. Make `breader.dump`. From the live copy, if the laptop is up (skip step 3):
   `docker compose -f infra/compose.yml exec -T mirror pg_dump -U breader -d breader --format=custom > breader.dump`
   Otherwise take the newest backup from `breader-backups/daily/`, or from the laptop with
   `docker compose -f infra/compose.yml cp worker:/data/backups ./backups`.
3. Decrypt a backup where the key is: `age -d -i breader-backup.agekey breader-DATE.dump.age > breader.dump`
4. Restore into an empty database. Use a new project (step 2, then update the URLs in
   `infra/.env`, Render and GitHub), or add `--clean --if-exists` to reuse the old one:
   ```sh
   docker run --rm -v "$PWD:/w" -e URL="<session pooler URL>?sslmode=require" ghcr.io/OWNER/breader-server \
     sh -c 'pg_restore --no-owner --no-privileges --exit-on-error -d "$URL" /w/breader.dump'
   ```
5. Make the copy reload from the restored database, then start everything:
   ```sh
   docker compose -f infra/compose.yml exec mirror psql -U breader -d breader -c "UPDATE mirror_state SET loaded_at = NULL"
   docker compose -f infra/compose.yml up -d
   ```
   The migrate step logs "moved the version sequence past restored rows". This is expected: it
   stops new writes from looking older than restored ones.
6. Resume Render.

**R2 is lost.** The laptop holds a copy of every file, in the same layout as the bucket:

```sh
docker compose -f infra/compose.yml cp worker:/data/files ./files
rclone copy ./files r2:breader-files   # an rclone remote for R2 with the laptop token
```

## Monthly restore drill

Prove a backup restores, without touching production:

```sh
age -d -i breader-backup.agekey breader-DATE.dump.age > breader.dump
docker run -d --name breader-drill -e POSTGRES_PASSWORD=drill postgres:17-alpine && sleep 5
docker exec -i breader-drill pg_restore -U postgres -d postgres --no-owner --exit-on-error < breader.dump
docker exec breader-drill psql -U postgres -c "select (select count(*) from libraries) libraries, (select count(*) from library_items) books"
docker rm -f breader-drill && rm breader.dump
```

The counts should be close to the live ones (the backup is from 03:00):
`docker compose -f infra/compose.yml exec mirror psql -U breader -d breader -c "select count(*) from library_items"`.
