# Installing jukecord

jukecord is one program: the Discord bot, the panel and the API in one process, with its data in one folder. The image
has everything it needs (Node, ffmpeg, yt-dlp); from source you install those yourself.

## Docker Compose

On Linux, macOS, or Windows with WSL, with Docker and its Compose plugin 2.24 or newer (`docker compose version` says
which):

```bash
git clone https://github.com/kanggu12/jukecord.git && cd jukecord
./jukecord up
```

The first `up` builds the image, compiling FFmpeg for audio (about a minute on a fast desktop, longer on a small
machine), and makes `.env` from `.env.example`. The panel opens on this machine only; `./jukecord open` makes a login
link and opens it. Put the bot's token in `.env` (the [README](../README.md#the-discord-bot) says how to make the bot)
and run `./jukecord up` again.

The build leaves about 800 MB of build cache (FFmpeg's compilers and the panel's build tools), which makes the next
`./jukecord update` quicker. To see it, and to remove it while leaving other projects' build cache alone:

```bash
docker buildx du --filter description~=jukecord
docker buildx prune --filter description~=jukecord
```

The front door's other commands:

| Command                            | Does                                                                                                     |
| :--------------------------------- | :------------------------------------------------------------------------------------------------------- |
| `./jukecord status`                | whether it runs, the version, whether Discord is connected (`./jukecord version` says the same)          |
| `./jukecord logs` (`-f` to follow) | jukecord's log                                                                                           |
| `./jukecord doctor`                | checks Docker, the settings, the database, ffmpeg, yt-dlp, the cache and Discord; exits 1 when one fails |
| `./jukecord update`                | rebuilds the image from this checkout (after `git pull`), or pulls a released image, and restarts        |
| `./jukecord restart`               | stops it and starts it again (a changed `.env` needs `./jukecord up` instead)                            |
| `./jukecord backup`                | a copy of the database in `./backups`                                                                    |
| `./jukecord restore <file>`        | puts a backup back; the current database is kept beside it                                               |
| `./jukecord down`                  | stops it; the data stays in the `jukecord_jukecord-data` volume                                          |
| `./jukecord <command>`             | the [jukecord command](README.md#the-jukecord-command): `np`, `add`, `token create` ...                  |

To use a released image instead of building one, set `JUKECORD_IMAGE=ghcr.io/kanggu12/jukecord:0.2.1` in `.env`.
`gh attestation verify oci://ghcr.io/kanggu12/jukecord:0.2.1 --repo kanggu12/jukecord` checks that GitHub signed it as
built by this repository's release workflow (the chart's `.tgz` from the release page is checked the same way).

### A second copy on the same machine

Compose names the container, its network and the `jukecord_jukecord-data` volume after the project, `jukecord`. A
second checkout on the same machine needs a name and a port of its own, in its own `.env`:

```bash
COMPOSE_PROJECT_NAME=jukecord-second
JUKECORD_PORT=8796
```

Its data then lives in the `jukecord-second_jukecord-data` volume. Each copy needs its own bot: Discord lets one token
hold one connection.

### Friends on other machines

The panel is published on 127.0.0.1. For friends to log in and listen:

- **A reverse proxy with HTTPS** (Caddy, nginx, Traefik) in front of jukecord, with `JUKECORD_PUBLIC_URL` set to its
  address and `JUKECORD_TRUST_PROXY=1` (one proxy in front, whose `X-Forwarded-For` and `X-Forwarded-Proto` jukecord
  then believes). It must pass WebSocket upgrades for `/api/v1/events` and allow a long read timeout (the panel keeps
  that connection open). `/metrics` answers without a login, and jukecord gives it only to a scraper on this machine
  or its network (a request that carries `X-Forwarded-For` or comes from a public address gets a 404); the examples
  below answer 404 for it at the proxy as well. With Caddy, which gets the certificate itself:

  ```
  music.example.com {
    # The figures for Prometheus stay on this machine.
    respond /metrics 404
    reverse_proxy 127.0.0.1:8795
  }
  ```

  With nginx, and a certificate of yours (certbot's paths here):

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

- **On the same network only**: `JUKECORD_BIND=0.0.0.0` publishes the port on every address of the machine, and
  `JUKECORD_PUBLIC_URL=http://<the machine's address>:8795`.

### Logging in with Discord

The host logs in with `./jukecord open`. For everyone else, set `JUKECORD_DISCORD_CLIENT_ID` and
`JUKECORD_DISCORD_CLIENT_SECRET` (the application's **OAuth2** page) and add `<JUKECORD_PUBLIC_URL>/auth/callback`
(or `http://localhost:<JUKECORD_PORT>/auth/callback` without a public address) to the application's **Redirects**. jukecord asks
Discord for the `identify` scope only; who is in which server is asked through the bot.

### Starting with the machine

Docker's restart policy (`unless-stopped`) brings jukecord back after a crash, a restart of Docker and a restart of the
machine, as long as Docker itself starts at boot (`sudo systemctl enable docker` on most Linux systems; Docker Desktop
has a setting of its own). When Docker stops, at shutdown too, it gives jukecord the 15 seconds `compose.yaml` asks
for, in which it saves where every server was and leaves voice.

The systemd unit is for the rest. It starts jukecord's Compose project after Docker at every boot, even after a
`./jukecord down`, which otherwise keeps it down, and it stops the project before Docker at shutdown, which matters
when Docker's `live-restore` setting keeps containers running past Docker itself. Run `./jukecord up` once before you
install it, so the image is built: the unit gives up on a start after 10 minutes, and a first build on a Raspberry Pi
can take longer.

```bash
sudo sed "s#/opt/jukecord#$PWD#" deploy/systemd/jukecord.service | sudo tee /etc/systemd/system/jukecord.service >/dev/null
sudo systemctl daemon-reload && sudo systemctl enable --now jukecord
```

### Raspberry Pi and other arm64 machines

The same commands work on a Raspberry Pi 4 or 5 with a 64-bit OS and on ARM servers: the image is built for arm64
too. Building it on a Pi compiles FFmpeg, which takes a long while; a released image (`JUKECORD_IMAGE` in `.env`)
avoids it. Give the cache a size that
fits the card or disk (`JUKECORD_CACHE_MAX`).

## From source

With Node 24.11 or newer, ffmpeg built with libopus and libmp3lame, and yt-dlp:

```bash
git clone https://github.com/kanggu12/jukecord.git && cd jukecord
npm ci && npm run build
JUKECORD_DISCORD_TOKEN=YOUR_BOT_TOKEN npm start
```

The data goes to `./data`; the host token is `./data/host-token`, so `node src/cli/main.ts link` in the same folder
makes a login link. yt-dlp needs a JavaScript runtime for YouTube: jukecord passes it the Node it runs on.

## Updating

```bash
./jukecord backup && git pull && ./jukecord update
```

With `JUKECORD_IMAGE` set to a version, set the new version's tag first. The database moves to a newer schema by
itself on the first start of a newer jukecord; an older jukecord refuses a database a newer one has written (restore
the backup made before the update instead).

## Backups

`./jukecord backup` writes a consistent copy while jukecord runs. The media cache is not in it (tracks are fetched
again when they are played). `./jukecord restore backups/jukecord-<time>.db` stops jukecord, puts the copy back and
starts it again, also after `./jukecord down`; a relative name counts from the folder the command is typed in. The
database it replaces stays in the volume as `jukecord.db.before-restore-<time>`, and a file that is not a whole
jukecord backup (another file, or a backup cut short) is refused before anything is stopped, whatever its size (it is
read in the data volume, not in the container's small `/tmp`). `./jukecord backup` prints the backup's whole path,
which `restore` takes from anywhere.

jukecord can also make one every day by itself: `JUKECORD_BACKUP_AT=04:30` in `.env` (then `./jukecord up`) makes a
backup at that time in this machine's time zone, or when jukecord starts after that time if the day has none yet, into
the volume's `backups` folder, where the newest `JUKECORD_BACKUP_KEEP` (7) stay. `./jukecord doctor` says how old the
newest backup is and how big the database is; a daily backup that failed is in the log and in the alerts channels.
These stay in the volume: copy one out with `docker compose cp jukecord:/data/backups/<file> .`, or make a copy here
with `./jukecord backup`. The container runs in this machine's time zone (`./jukecord` passes it on; `TZ` in `.env` sets
another).
