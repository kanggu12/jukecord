# Installing jukecord

jukecord is one program: the Discord bot, the panel and the API in one process, with its data in one folder. The image
has everything it needs (Node, ffmpeg, yt-dlp); from source you install those yourself.

## Docker Compose

On Linux, macOS, or Windows with WSL, with Docker and its Compose plugin:

```bash
git clone https://github.com/kanggu12/jukecord.git && cd jukecord
./jukecord up
```

The first `up` builds the image, compiling FFmpeg for audio (about a minute on a fast desktop, longer on a small
machine), and makes `.env` from `.env.example`. The build leaves about 400 MB of build cache, which
`docker builder prune` removes. The panel opens on this machine
only; `./jukecord open` makes a login link and opens it. Put the bot's token in `.env` (the [README](../README.md#the-discord-bot)
says how to make the bot) and run `./jukecord up` again.

The front door's other commands:

| Command                            | Does                                                                                              |
| :--------------------------------- | :------------------------------------------------------------------------------------------------ |
| `./jukecord status`                | whether it runs, the version, whether Discord is connected                                        |
| `./jukecord logs` (`-f` to follow) | jukecord's log                                                                                    |
| `./jukecord doctor`                | checks Docker, the settings, the database, ffmpeg, yt-dlp, the cache and Discord                  |
| `./jukecord update`                | rebuilds the image from this checkout (after `git pull`), or pulls a released image, and restarts |
| `./jukecord backup`                | a copy of the database in `./backups`                                                             |
| `./jukecord restore <file>`        | puts a backup back; the current database is kept beside it                                        |
| `./jukecord down`                  | stops it; the data stays in the `jukecord-data` volume                                            |
| `./jukecord <command>`             | the [jukecord command](README.md#the-jukecord-command): `np`, `add`, `token create` ...           |

To use a released image instead of building one, set `JUKECORD_IMAGE=ghcr.io/kanggu12/jukecord:0.1.0` in `.env`.

### Friends on other machines

The panel is published on 127.0.0.1. For friends to log in and listen:

- **A reverse proxy with HTTPS** (Caddy, nginx, Traefik) in front of jukecord, with `JUKECORD_PUBLIC_URL` set to its
  address and `JUKECORD_TRUST_PROXY=1` (one proxy in front). It must pass WebSocket upgrades for `/api/v1/events` and allow a long read
  timeout (the panel keeps that connection open). With Caddy:

  ```
  music.example.com {
    reverse_proxy 127.0.0.1:8795
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

Docker's restart policy brings jukecord back after a crash or a restart of Docker. Where Docker itself does not start at
boot, or where the machine's shutdown must wait for jukecord to save its place, install the systemd unit:

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
starts it again, also after `./jukecord down`. The database it replaces stays in the volume as
`jukecord.db.before-restore-<time>`, and a file that is not a jukecord backup changes nothing.
