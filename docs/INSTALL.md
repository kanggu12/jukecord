# Installing jukecord

For the person who hosts jukecord: Docker Compose step by step, an address for friends, logging in with Discord,
starting with the machine, a Raspberry Pi, running from source, updates and backups.
[Kubernetes](KUBERNETES.md) has the Helm chart.

## Docker Compose

On Linux, macOS, or Windows with WSL, with Docker and its Compose plugin 2.24 or newer (`docker compose version` says
which):

```bash
git clone https://github.com/kanggu12/jukecord.git && cd jukecord
./jukecord up
```

1. The first `up` makes `.env` from `.env.example` and builds the image, which carries Node, ffmpeg and yt-dlp. It
   compiles FFmpeg: about a minute on a fast desktop, longer on a small machine.
2. `./jukecord open` makes a login link and opens the panel, on this machine only until you give it
   [an address for friends](#friends-on-other-machines).
3. For Discord, put the bot's token in `.env` as `JUKECORD_DISCORD_TOKEN`
   ([making the bot](../README.md#the-discord-bot)), then run `./jukecord up` again.

The build leaves about 800 MB of build cache (FFmpeg's compilers, the panel's build tools) for the next
`./jukecord update`. To see it, then remove it without touching other projects' cache:

```bash
docker buildx du --filter description~=jukecord
docker buildx prune --filter description~=jukecord
```

| Command                     | Does                                                                                                     |
| :-------------------------- | :------------------------------------------------------------------------------------------------------- |
| `./jukecord status`         | whether it runs, the version, whether Discord is connected (`./jukecord version` says the same)          |
| `./jukecord logs`           | jukecord's log; `-f` follows it                                                                          |
| `./jukecord doctor`         | checks Docker, the settings, the database, ffmpeg, yt-dlp, the cache and Discord; exits 1 when one fails |
| `./jukecord update`         | rebuilds the image from this checkout, or pulls a released image, and restarts                           |
| `./jukecord restart`        | stops and starts it; a changed `.env` needs `./jukecord up` instead                                      |
| `./jukecord backup`         | a copy of the database in `./backups` ([backups](#backups))                                              |
| `./jukecord restore <file>` | puts a backup back                                                                                       |
| `./jukecord down`           | stops it; the data stays in the `jukecord_jukecord-data` volume                                          |
| `./jukecord <command>`      | the [jukecord command](README.md#the-jukecord-command): `np`, `add`, `token create` ...                  |

### A released image

To run a released image instead of building one, set it in `.env`:

```bash
JUKECORD_IMAGE=ghcr.io/kanggu12/jukecord:0.3.2
```

This checks that GitHub signed it as built by this repository's release workflow (the chart's `.tgz` from the release
page is checked the same way):

```bash
gh attestation verify oci://ghcr.io/kanggu12/jukecord:0.3.2 --repo kanggu12/jukecord
```

### A second copy on the same machine

Compose names the container, its network and the `jukecord_jukecord-data` volume after the project, `jukecord`. A
second checkout needs a name and a port of its own, in its own `.env`:

```bash
COMPOSE_PROJECT_NAME=jukecord-second
JUKECORD_PORT=8796
```

Its data is then in the `jukecord-second_jukecord-data` volume. Each copy needs its own bot: Discord lets one token
hold one connection.

### Friends on other machines

The panel is published on 127.0.0.1, this machine only. For friends to log in and listen, set one of these in
`.env`:

| Friends reach it through                           | Set                                                                                   |
| :------------------------------------------------- | :------------------------------------------------------------------------------------ |
| A reverse proxy with HTTPS (Caddy, nginx, Traefik) | `JUKECORD_PUBLIC_URL` to the proxy's address, and `JUKECORD_TRUST_PROXY=1`            |
| The same network only                              | `JUKECORD_BIND=0.0.0.0` and `JUKECORD_PUBLIC_URL=http://<the machine's address>:8795` |

- With `JUKECORD_TRUST_PROXY=1` jukecord believes the `X-Forwarded-For` and `X-Forwarded-Proto` of one proxy.
- The proxy passes WebSocket upgrades for `/api/v1/events`, with a long read timeout: the panel keeps that connection
  open.
- `/metrics` needs no login, so jukecord answers it only for this machine and its network: a request with
  `X-Forwarded-For`, or from a public address, gets a 404. The examples below refuse it at the proxy too.

Caddy, which gets the certificate itself:

```
music.example.com {
  # The figures for Prometheus stay on this machine.
  respond /metrics 404
  reverse_proxy 127.0.0.1:8795
}
```

nginx, with a certificate of yours (certbot's paths here):

```nginx
# In the http block (nginx.conf, or a file in conf.d): Connection follows the browser's Upgrade header.
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}

server {
  listen 443 ssl;
  server_name music.example.com;
  ssl_certificate     /etc/letsencrypt/live/music.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/music.example.com/privkey.pem;

  # The figures for Prometheus stay on this machine.
  location = /metrics {
    return 404;
  }

  location / {
    proxy_pass http://127.0.0.1:8795;
    # WebSocket needs HTTP/1.1, and the Upgrade and Connection headers passed on.
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    # Who asked, and whether over https, for JUKECORD_TRUST_PROXY=1.
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # The panel's live connection stays open for hours.
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
  }
}
```

### Logging in with Discord

The host logs in with `./jukecord open`. For everyone else:

1. Set `JUKECORD_DISCORD_CLIENT_ID` and `JUKECORD_DISCORD_CLIENT_SECRET` in `.env`, from the application's **OAuth2**
   page.
2. Add `<JUKECORD_PUBLIC_URL>/auth/callback` to the application's **Redirects**; without a public address,
   `http://localhost:<JUKECORD_PORT>/auth/callback`.
3. Run `./jukecord up`.

jukecord asks Discord for the `identify` scope only; who is in which server is asked through the bot.

### Starting with the machine

Docker's restart policy (`unless-stopped`) brings jukecord back after a crash or a restart, as long as Docker starts
at boot (`sudo systemctl enable docker` on most Linux systems; Docker Desktop has its own setting). When Docker stops,
jukecord has 15 seconds to save where every server was and leave voice.

The systemd unit also starts jukecord after Docker at every boot, even after a `./jukecord down`, and stops it before
Docker at shutdown, which matters when Docker's `live-restore` keeps containers running past Docker. It gives up on a
start after 10 minutes, and a first build on a Raspberry Pi can take longer, so run `./jukecord up` once first. Then,
in the checkout:

```bash
sudo sed "s#/opt/jukecord#$PWD#" deploy/systemd/jukecord.service | sudo tee /etc/systemd/system/jukecord.service >/dev/null
sudo systemctl daemon-reload && sudo systemctl enable --now jukecord
```

### Raspberry Pi and other arm64 machines

The same commands work on a Raspberry Pi 4 or 5 with a 64-bit system and on ARM servers: the image is built for arm64
too. Building it on a Pi compiles FFmpeg, which takes a long while; a [released image](#a-released-image) skips that.
The cache holds up to 2 GiB by default; `JUKECORD_CACHE_MAX` sets a size that fits the card or disk.

## From source

With Node 24.11 or newer, ffmpeg built with libopus and libmp3lame, and yt-dlp:

```bash
export JUKECORD_DISCORD_TOKEN=YOUR_BOT_TOKEN
git clone https://github.com/kanggu12/jukecord.git && cd jukecord
npm ci && npm run build
npm start
```

Without the token it runs browser-only. The data goes to `./data`, with the host token in `./data/host-token`, so
`node src/cli/main.ts link` in the same folder makes a login link. yt-dlp needs a JavaScript runtime for YouTube:
jukecord passes it its own Node.

## Everyday use

| To                   | With Docker Compose                                              |
| :------------------- | :--------------------------------------------------------------- |
| Open the panel       | `./jukecord open`                                                |
| See how it runs      | `./jukecord status`, and `./jukecord doctor` to check every part |
| Read the log         | `./jukecord logs`, or the **Log** page in the panel              |
| Back up the database | `./jukecord backup`, into `./backups`                            |
| Update               | `./jukecord backup && git pull && ./jukecord update`             |
| Stop                 | `./jukecord down`; the data stays                                |

Any other word goes to the `jukecord` command inside: `./jukecord np`, `./jukecord add <address or words>`
([the jukecord command](README.md#the-jukecord-command)). On Kubernetes it runs through `kubectl exec`.

## Updating

```bash
./jukecord backup && git pull && ./jukecord update
```

- With `JUKECORD_IMAGE` set to a version, set the new version's tag first.
- The database moves to a newer schema by itself on the first start of a newer jukecord.
- An older jukecord refuses a database a newer one has written: to go back, restore the backup made before the update.

## Backups

`./jukecord backup` writes a consistent copy of the database while the music and the panel go on, however big the
database, and prints its whole path. The media cache stays out: tracks are fetched again when played. To put one back:

```bash
./jukecord restore backups/jukecord-<time>.db
```

- It stops jukecord, puts the copy back and starts it again, also after `./jukecord down`.
- A relative name counts from the folder the command is typed in; the whole path that `backup` printed works from
  anywhere.
- The database it replaces stays in the volume as `jukecord.db.before-restore-<time>`.
- A file that is not a whole jukecord backup (another file, or a backup cut short) is refused before anything stops,
  whatever its size.

### Every day

`JUKECORD_BACKUP_AT=04:30` in `.env`, then `./jukecord up`, makes a backup every day at that time in this machine's
time zone (`TZ` in `.env` sets another), or on the first start after that time on a day without one. The volume's
`backups` folder keeps the newest `JUKECORD_BACKUP_KEEP` (7). `./jukecord doctor` says how old the newest backup is
and how big the database is; a failed one is in the log and the alerts channels. To copy one out of the volume:

```bash
docker compose cp jukecord:/data/backups/<file> .
```
