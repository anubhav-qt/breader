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
The status page is at http://localhost:8787/admin, with the `ADMIN_TOKEN` from `infra/dev.env`.

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
openssl rand -hex 32      # ADMIN_TOKEN, which opens the status page
```

The laptop and Render need the same `KEY_PEPPER`, `SESSION_SECRET` and `ADMIN_TOKEN`. Changing
`KEY_PEPPER` stops every library key from working, and changing `SESSION_SECRET` signs every
reader out.

**Logins.** Readers can log in with Google or with an email and a password; a key still works
without either. Without the settings below the server offers email only, and logs its emails
instead of sending them.

- Google: console.cloud.google.com › a new project › Google Auth Platform. Branding: app name
  Breader, your support email, authorised domain `breader.example`. Audience: External, then
  **Publish app** (email and profile need no review). Clients › Create client › Web application:
  JavaScript origin `https://breader.example`, redirect URIs
  `https://api.breader.example/v1/auth/callback/google` and
  `https://fb.breader.example/v1/auth/callback/google`. Its ID and secret → `GOOGLE_CLIENT_ID`
  and `GOOGLE_CLIENT_SECRET` (laptop and Render).
- Email: Resend (free, 100 a day, 3,000 a month) › Domains › add `breader.example` and put the
  records it shows into Cloudflare DNS (DNS only), then wait for Verified. API keys › create one
  with sending access → `RESEND_API_KEY` (laptop and Render). Mail comes from
  `hello@breader.site` unless `MAIL_FROM` says otherwise.
- `PUBLIC_URL` is each server's own address, where Google sends readers back:
  `https://api.breader.example` on the laptop, `https://fb.breader.example` on Render.

**The server voice.** The laptop can read aloud for phones too slow for a voice of their own,
with the app's five Normal voices, sending each sentence as MP3 (about 22 MB an hour). It's open
only to the accounts in `SPEECH_EMAILS` (comma separated, laptop only; Render is too small to
speak), and only once each address is confirmed; they then see **Read on the server** in the voice
sheet. Each voice downloads into the `voices` volume the first time it's asked for, about 64 MB,
and the engine holds about 150 MB per voice while it reads, letting go after ten quiet minutes.
`SPEECH_THREADS` caps the processor threads it uses (4, or one less than the laptop has).

Errors go to Sentry (free plan, 5,000 errors a month). At sentry.io create a project on the
**Browser JavaScript** platform (one project takes the app, the API and the worker, each tagged
by `component`), then copy Project settings › Client keys › DSN → `SENTRY_DSN` (laptop and
Render) and `VITE_SENTRY_DSN` (Pages). Without them, errors are only logged.

### 6. GitHub

1. Push the repository. The first push to `dev` builds `ghcr.io/OWNER/breader-server`.
2. Your profile › Packages › breader-server › Package settings: make it **public**, so the laptop and
   Render can pull without credentials. It holds code only, no settings.
3. Settings › Secrets and variables › Actions: `SUPABASE_SESSION_URL`, then `RENDER_DEPLOY_HOOK`
   after step 8.

`IMAGE` in `infra/.env` is `ghcr.io/OWNER/breader-server:latest` (owner in lowercase).

### 7. The laptop

Only one laptop runs the stack at a time (see *Moving the laptop* below).

On a Mac:

1. Docker Desktop › Settings › General: **Start Docker Desktop when you sign in**.
2. System Settings › Battery › Options: **Prevent automatic sleeping on power adapter when the
   display is off**. A closed lid still sleeps the Mac; Render answers until it wakes.

On Linux (Arch shown; other distributions name the packages differently):

1. Docker, started at boot, usable without sudo (log out and in after `usermod`):
   ```sh
   sudo pacman -S --needed docker docker-compose git
   sudo systemctl enable --now docker
   sudo usermod -aG docker "$USER"
   ```
   The containers come back after a reboot by themselves (`restart: unless-stopped`).
2. Don't sleep with the lid closed on power. In `/etc/systemd/logind.conf` (or a file in
   `/etc/systemd/logind.conf.d/`) set `HandleLidSwitchExternalPower=ignore`, then reboot. Turn
   off automatic suspend on AC in your desktop's power settings too; GNOME and KDE have their own.
   On a machine that only serves Breader, `sudo systemctl mask sleep.target suspend.target
   hibernate.target hybrid-sleep.target` rules out sleep entirely.

Then, on either:

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
   `--install` adds a LaunchAgent on a Mac, or a systemd user timer on Linux, with lingering on so
   it runs before you log in. If it asks, run the `sudo loginctl enable-linger` line it prints.
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
CLIENT_IP_HEADER=cf-connecting-ip                 ADMIN_TOKEN=<same>
SENTRY_DSN=<the DSN>     PUBLIC_URL=https://fb.breader.example
GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / RESEND_API_KEY = <same>
```

Leave out `MIRROR_URL`, `S3_BACKUP_BUCKET`, `BACKUP_RECIPIENT` and `TUNNEL_TOKEN`; the fallback
has no copy and makes no backups. Render sets `PORT` itself.

`CLIENT_IP_HEADER` tells the server where the reader's address is, for its rate limits. Both
servers read `cf-connecting-ip`: the laptop sits behind the tunnel (set in `compose.yml`), and
Render sits behind Cloudflare's edge too. Cloudflare sets that header itself and refuses a request
that brings its own (error 1000). Don't use `x-forwarded-for` on Render: its last entry is
Render's internal proxy, which would put every reader under one limit. Once `fb.` answers, check:

```sh
curl -s -H "authorization: Bearer $ADMIN_TOKEN" -H 'x-forwarded-for: 6.6.6.6' \
  https://fb.breader.example/admin/status | grep -o '"request":{[^}]*}'
```

`ip` must be your own address (`curl -s ifconfig.me`), not 6.6.6.6 and not a `10.…` address;
`headers` lists what arrived.

Settings › Custom Domains: add `fb.breader.example`, then in Cloudflare DNS add the CNAME it shows,
**DNS only** (grey cloud). Settings › Deploy Hook → GitHub secret `RENDER_DEPLOY_HOOK`.

### 9. Cloudflare Pages

Workers & Pages › Create › Pages › connect the repository, production branch `dev`:

- Build command `npm ci && npm run build -w frontend`, output directory `frontend/dist`, root `/`
- Environment variables `VITE_API_URL=https://api.breader.example`,
  `VITE_API_FALLBACK_URL=https://fb.breader.example`, `VITE_SENTRY_DSN=<the DSN>`, `NODE_VERSION=24`
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

The status page, `https://api.breader.example/admin` (or `fb.` while the laptop is off), asks for
`ADMIN_TOKEN` and shows which server answered, how far behind the copy is, how full Supabase and R2
are, and when each worker job last worked or failed.

## Day to day

**Shipping.** Push to `dev`. CI tests, publishes the image, migrates Supabase and redeploys
Render. The laptop picks the image up within 5 minutes, and Pages rebuilds the app. For those
minutes the laptop and Render can run different versions. So a migration only ever adds: a new
table, or a nullable column. Removals ship in a later release, once no running version reads them.
`/health` shows each server's `release` (the commit).

**Status.** The status page at `https://api.breader.example/admin` has it all on one page. From
a terminal:

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

**Restore test.** Every four weeks, after that night's backup, the worker restores a dump of the
copy into a scratch database, checks that every table came back row for row, and checks that the
night's backup in R2 matches the one on the laptop. It can't decrypt the backup itself (the key
isn't on the laptop), so that part stays a manual drill, below. A failure shows on the status page
and in Sentry.

**Clean-up.** Every hour the worker removes books removed more than 30 days ago, files no book has
used for 7 days (their space goes back to the library), upload links never finished after a day,
and key libraries unused for a year, with their files.

**R2 check.** Once a day the worker lists R2 and puts back any file missing from it, from the
laptop's copy. A file missing from both makes the job fail every day, on the status page and in
Sentry, until someone looks.

## When something breaks

**The laptop is off or broken.** Nothing to do: the app is on Render. For a new laptop, run step 7
with the saved `infra/.env`. The worker rebuilds the copy from Supabase and downloads every file
from R2.

**Moving the laptop.** Stop the old one before starting the new one. Two stacks at once would
both answer `api.` through the same tunnel, both run the nightly jobs, and each tell Supabase to
prune change records the other hasn't read yet, forcing reloads. On the old laptop:

```sh
docker compose -f infra/compose.yml down     # the volumes stay, in case you need to go back
infra/update.sh --uninstall
```

Then run step 7 on the new one with the same `infra/.env`: the tunnel token, heartbeat URL and
every secret come with it. Copy the file over something private (`scp`, or your password
manager), never chat or email. Render answers in between; expect one "down" email from the `api.`
monitor and one from the heartbeat, then two "up" emails.

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
   The migrate step logs "moved the version sequence past restored rows and started a new sync
   timeline". This is expected. The first part stops new writes from looking older than restored
   ones. The new timeline tells every browser that the server lost changes, so each one sends
   everything it holds again: books, places, edits and files that R2 still has, which aren't
   uploaded again.
6. Resume Render.

**R2 is lost.** The laptop holds a copy of every file, in the same layout as the bucket, and the
worker's daily R2 check puts back whatever is missing. To do it at once, for a whole bucket:

```sh
docker compose -f infra/compose.yml cp worker:/data/files ./files
rclone copy ./files r2:breader-files   # an rclone remote for R2 with the laptop token
```

## Restore drill with the key

The worker tests every month that its dumps restore (see Restore test). A few times a year, prove
the rest by hand: that the backup key opens a real backup. Without touching production:

```sh
age -d -i breader-backup.agekey breader-DATE.dump.age > breader.dump
docker run -d --name breader-drill -e POSTGRES_PASSWORD=drill postgres:17-alpine && sleep 5
docker exec -i breader-drill pg_restore -U postgres -d postgres --no-owner --exit-on-error < breader.dump
docker exec breader-drill psql -U postgres -c "select (select count(*) from libraries) libraries, (select count(*) from library_items) books"
docker rm -f breader-drill && rm breader.dump
```

The counts should be close to the live ones (the backup is from 03:00):
`docker compose -f infra/compose.yml exec mirror psql -U breader -d breader -c "select count(*) from library_items"`.
