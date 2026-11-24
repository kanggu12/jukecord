# Installing jukecord

For the person who hosts jukecord: Docker Compose step by step, an address for friends, logging in with Discord,
starting with the machine, a Raspberry Pi, the release's programs without Docker, running from source, the database,
logins through your own accounts, a split into services, monitoring, updates and backups.
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
| `./jukecord status`         | whether it runs, the version, the database, whether Discord is connected (`./jukecord version` too)      |
| `./jukecord logs`           | jukecord's log; `-f` follows it                                                                          |
| `./jukecord doctor`         | checks Docker, the settings, the database, ffmpeg, yt-dlp, the cache and Discord; exits 1 when one fails |
| `./jukecord update`         | rebuilds the image from this checkout, or pulls a released image, and restarts                           |
| `./jukecord restart`        | stops and starts it; a changed `.env` needs `./jukecord up` instead                                      |
| `./jukecord backup`         | a copy of the database in `./backups` ([backups](#backups))                                              |
| `./jukecord restore <file>` | puts a backup back                                                                                       |
| `./jukecord db ...`         | the database itself, also while jukecord is stopped ([the database](#the-database))                      |
| `./jukecord down`           | stops it; the data stays in the `jukecord_jukecord-data` volume                                          |
| `./jukecord <command>`      | the [jukecord command](README.md#the-jukecord-command): `np`, `add`, `token create` ...                  |

### A released image

To run a released image instead of building one, set it in `.env`:

```bash
JUKECORD_IMAGE=ghcr.io/kanggu12/jukecord:0.3.4
```

This checks that GitHub signed it as built by this repository's release workflow (the chart's `.tgz` from the release
page is checked the same way):

```bash
gh attestation verify oci://ghcr.io/kanggu12/jukecord:0.3.4 --repo kanggu12/jukecord
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
  `X-Forwarded-For`, or from a public address, gets a 404 ([monitoring](#monitoring)). The examples below refuse it
  at the proxy too.

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

jukecord asks Discord for the `identify` scope only; who is in which server is asked through the bot. A login page
can offer your own identity provider or directory as well ([your own accounts](#logging-in-through-your-own-accounts)).

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

## Without Docker

Each release has jukecord for Linux, macOS and Windows, on x64 and on arm64: one folder with its own Node.js, FFmpeg
and yt-dlp, so nothing else is installed. It runs on Linux with glibc 2.28 or newer (Debian 10, Ubuntu 20.04, a
64-bit Raspberry Pi OS and later), on macOS 13.5 or newer and on Windows 10 or newer.

**Linux** (x64; on a Raspberry Pi 4 or 5 and other ARM machines, `x64` becomes `arm64`)

```bash
curl -fL https://github.com/kanggu12/jukecord/releases/download/v0.3.4/jukecord-0.3.4-linux-x64.tar.gz | tar -xz
cd jukecord-0.3.4-linux-x64 && ./jukecord start
```

**macOS** (Apple silicon; on Intel, `arm64` becomes `x64`)

```bash
curl -fL https://github.com/kanggu12/jukecord/releases/download/v0.3.4/jukecord-0.3.4-macos-arm64.tar.gz | tar -xz
cd jukecord-0.3.4-macos-arm64 && ./jukecord start
```

**Windows** (PowerShell; on Arm, `x64` becomes `arm64`)

```powershell
iwr https://github.com/kanggu12/jukecord/releases/download/v0.3.4/jukecord-0.3.4-windows-x64.zip -OutFile jukecord-0.3.4-windows-x64.zip -UseBasicParsing
tar -xf jukecord-0.3.4-windows-x64.zip
cd jukecord-0.3.4-windows-x64; .\jukecord start
```

`jukecord start` runs jukecord in that terminal until Ctrl+C. In a second terminal in the same folder, `./jukecord open`
(`.\jukecord open` on Windows) logs this computer's browser in to the panel, and every other
[jukecord command](README.md#the-jukecord-command) works the same way: `./jukecord np`,
`./jukecord add <address or words>`.

- **Settings**: copy `.env.example` to `.env` in the folder. It takes the settings of Compose's `.env`
  (`JUKECORD_DISCORD_TOKEN` for the bot); `JUKECORD_HOST=0.0.0.0` opens the panel to the network.
- **Data**: the database, the cache, the logs and the backups are in `~/.local/share/jukecord` on Linux,
  `~/Library/Application Support/jukecord` on macOS and `%LOCALAPPDATA%\jukecord` on Windows. `JUKECORD_DATA_DIR`
  puts them elsewhere, and `JUKECORD_DATABASE_URL` puts the database on a server ([the database](#the-database)).
- **Updating**: unpack the newer release beside the folder and copy `.env` into it. It finds the same data, and the
  database moves to the newer schema on the first start, as with Compose.
- **Downloaded with a browser**, macOS keeps the programs in the folder from starting until they are let through:
  `xattr -dr com.apple.quarantine jukecord-0.3.4-macos-arm64`. curl, as above, leaves no such mark.

On macOS and Windows it runs while its terminal is open; for a machine that plays around the clock, Docker Compose
(Docker Desktop starts with the machine) or Linux suits better.

### Starting with the machine, on Linux

A systemd user service keeps it running and starts it at boot. It names one path, so a link points at the release in
use (after an update, point the link at the new folder and restart the service):

```bash
ln -sfn "$PWD/jukecord-0.3.4-linux-x64" ~/jukecord
mkdir -p ~/.config/systemd/user && cat > ~/.config/systemd/user/jukecord.service <<'EOF'
[Unit]
Description=jukecord

[Service]
ExecStart=%h/jukecord/jukecord start
Restart=on-failure

[Install]
WantedBy=default.target
EOF
systemctl --user enable --now jukecord
sudo loginctl enable-linger "$USER"   # from boot, before anyone logs in
```

`journalctl --user -u jukecord` shows its console; `systemctl --user stop jukecord` stops it, saving where every
server was.

### What each file of a release is

| File                                                                   | What it is                                                                                         |
| :--------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------- |
| `jukecord-0.3.4-linux-x64.tar.gz`, `jukecord-0.3.4-linux-arm64.tar.gz` | jukecord for Linux on x64, and on arm64 (a Raspberry Pi 4 or 5, an ARM server)                     |
| `jukecord-0.3.4-macos-arm64.tar.gz`, `jukecord-0.3.4-macos-x64.tar.gz` | jukecord for macOS on Apple silicon, and on Intel                                                  |
| `jukecord-0.3.4-windows-x64.zip`, `jukecord-0.3.4-windows-arm64.zip`   | jukecord for Windows on x64, and on Arm                                                            |
| `jukecord-0.3.4-helm-chart.tgz`                                        | the Helm chart, the same as `oci://ghcr.io/kanggu12/charts/jukecord` ([Kubernetes](KUBERNETES.md)) |
| `jukecord-0.3.4-checksums.txt`                                         | the SHA-256 of every file above                                                                    |

The image is not a file of the release but `ghcr.io/kanggu12/jukecord:0.3.4` ([a released image](#a-released-image)).

### Checking a download

The checksums file has a SHA-256 for each file, and GitHub keeps a signed record of where each was built:

```bash
sha256sum -c --ignore-missing jukecord-0.3.4-checksums.txt
gh attestation verify jukecord-0.3.4-linux-x64.tar.gz --repo kanggu12/jukecord
```

On macOS `shasum -a 256 -c --ignore-missing` checks the same; on Windows, compare
`Get-FileHash jukecord-0.3.4-windows-x64.zip` with its line. Each program is unpacked and run on its own system and
processor (a track played through yt-dlp and FFmpeg) before a release is published, and again from the published
release's addresses after.

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

## The database

jukecord keeps the queues, the history, the playlists, the logins and the tokens in one database. By default it is a
SQLite file in the data folder, `jukecord.db`, which needs nothing set up. A host who already runs PostgreSQL or
MySQL/MariaDB, wants the data on a database server with its own backups, or [splits jukecord into
services](#split-into-services) points `JUKECORD_DATABASE_URL` at one instead. The media cache, the logs and the
backups stay in the data folder either way.

| Database   | Versions           | Needs                                         |
| :--------- | :----------------- | :-------------------------------------------- |
| SQLite     | the one in Node.js | nothing: the default                          |
| PostgreSQL | 14 or newer        | a database in UTF-8, and a user that owns it  |
| MySQL      | 8.0 or newer       | a database, and a user with every right on it |
| MariaDB    | 10.11 or newer     | the same                                      |

CI runs the database's tests on the oldest and the newest of each: PostgreSQL 14 and 18, MySQL 8.0 and 8.4, MariaDB
10.11 and 11.8.

### PostgreSQL

As a superuser (`psql -U postgres`), make a user and a database it owns:

```sql
CREATE ROLE jukecord LOGIN PASSWORD 'choose-a-password';
-- UTF-8 whatever the server's own locale is.
CREATE DATABASE jukecord OWNER jukecord ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0;
```

```bash
JUKECORD_DATABASE_URL=postgres://jukecord:choose-a-password@db.example.internal:5432/jukecord
```

jukecord makes its tables at its first start. `?schema=music` at the end of the address keeps them in a schema of
their own, made when it is missing. A database in another encoding is refused, and so is one that already has tables
of jukecord's names that jukecord did not make.

### MySQL and MariaDB

As the server's root:

```sql
CREATE DATABASE jukecord CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE USER 'jukecord'@'%' IDENTIFIED BY 'choose-a-password';
GRANT ALL PRIVILEGES ON jukecord.* TO 'jukecord'@'%';
```

```bash
JUKECORD_DATABASE_URL=mysql://jukecord:choose-a-password@db.example.internal:3306/jukecord
```

`mariadb://` names a MariaDB the same way. jukecord sets each connection up itself (its SQL mode, utf8mb4 with names
that differ only by case or accent kept apart, serializable transactions), whatever the server's defaults are.

### The address

`JUKECORD_DATABASE_URL` takes:

| Address                                       | The database                                                      |
| :-------------------------------------------- | :---------------------------------------------------------------- |
| `sqlite:` (the default)                       | `jukecord.db` in the data folder                                  |
| `sqlite:/var/lib/jukecord/music.db`           | a file of its own (a relative path is taken from the data folder) |
| `postgres://user:password@host:5432/database` | PostgreSQL (`postgresql://` too)                                  |
| `mysql://user:password@host:3306/database`    | MySQL, or MariaDB (`mariadb://` too)                              |

- **The password** is percent-encoded, as in any address: `@ : / ? # % [ ]` and a space are `%40 %3A %2F %3F %23 %25
  %5B %5D %20`. `openssl rand -hex 16` makes a password with none of them; this encodes one that has them, printing
  `pa%3Ass%40word%2F1`:

  ```bash
  python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' 'pa:ss@word/1'
  ```

- **TLS** is asked for in the address, in PostgreSQL's words for both kinds of server (MySQL's own are taken too):

  | `sslmode=`              | `ssl-mode=`       | The connection                                                    |
  | :---------------------- | :---------------- | :---------------------------------------------------------------- |
  | `disable` (the default) | `DISABLED`        | not encrypted                                                     |
  | `require`               | `REQUIRED`        | encrypted, the server's certificate not checked                   |
  | `verify-ca`             | `VERIFY_CA`       | encrypted, the certificate signed by an authority jukecord trusts |
  | `verify-full`           | `VERIFY_IDENTITY` | that, and made out to the host name in the address                |

  `sslrootcert=/path/to/ca.crt` (or `ssl-ca=`) names the authority of a certificate no public authority signed, a file
  in the volume with Compose (`sslrootcert=/data/db-ca.pem`); without it the authorities Node.js trusts are the ones
  checked. `sslcert=` and `sslkey=` give jukecord a certificate of its own,
  for a server that asks for one. A mode that may fall back to no encryption (`prefer`, `allow`) is refused: the address
  says whether it wants TLS.
- `connect_timeout=` (seconds, 10 by default), `schema=` (PostgreSQL), `host=` for PostgreSQL's socket folder
  (`postgres://jukecord@/jukecord?host=/run/postgresql`) and `socket=` for MySQL's socket are the other parameters.
  Any other is refused, so a misspelt one does not pass unseen.
- `JUKECORD_DATABASE_URL_FILE` reads the address from a file (a Docker or Kubernetes secret), since it holds a password.
  The log and `jukecord doctor` show the address without its user and password.
- `JUKECORD_DATABASE_POOL` (10) is the most connections jukecord opens to the server. A hosted database may allow few
  per user; each service of a split opens its own.

At its start, jukecord waits up to a minute for a database server that does not answer yet (a database container
started beside it, a name a cluster's DNS learns a moment late), and logs each try with the reason. A failure that
waiting cannot mend (a wrong password, no such database, a certificate refused) ends the wait at once. It then logs
`jukecord cannot reach its database`, with the reason, and exits 1; Docker's restart policy or Kubernetes starts it
again.

### A database beside jukecord, with Compose

Compose reads a `compose.override.yaml` beside `compose.yaml` by itself, so a PostgreSQL for jukecord is one more file
in the checkout. It holds the password, as `.env` does:

```yaml
# compose.override.yaml: a PostgreSQL for jukecord, on Compose's network only.
services:
  database:
    image: postgres:18-alpine
    environment:
      POSTGRES_USER: jukecord
      POSTGRES_DB: jukecord
      POSTGRES_PASSWORD: choose-a-password
    volumes:
      - database-data:/var/lib/postgresql
    healthcheck:
      test: [CMD-SHELL, pg_isready -U jukecord -d jukecord]
      interval: 5s
      timeout: 3s
      retries: 20
    restart: unless-stopped
  jukecord:
    depends_on:
      database:
        condition: service_healthy
volumes:
  database-data:
```

In `.env`, with the same password:

```bash
JUKECORD_DATABASE_URL=postgres://jukecord:choose-a-password@database:5432/jukecord
```

`./jukecord up` and `./jukecord down` then start and stop the database with jukecord. A MySQL or MariaDB goes the
same way with its own image and variables, as `deploy/split/compose.mysql.yaml` has them.

### Moving to another database

`jukecord db copy <from> [<to>]` copies every row of one database into another, of the same kind or not. It reads the
source as one moment's view, so jukecord may keep running on it, and writes the target in one transaction: a copy that
fails changes nothing. A target that holds data is refused, unless `--replace` empties it first in the same
transaction. Without `<to>`, or with the word `configured`, the target is the database jukecord is set to use. Copy
into a database jukecord uses only while it is stopped.

With Docker Compose, from the SQLite file in the volume to the PostgreSQL above:

```bash
./jukecord backup                # the database as it is, to come back to
./jukecord down
docker compose up -d database    # the database alone
# JUKECORD_DATABASE_URL=postgres://... in .env, then:
./jukecord db copy sqlite:/data/jukecord.db
./jukecord up
```

```
Copied 12571 rows in 0.3 s
  from SQLite (/data/jukecord.db)
  to   PostgreSQL (database:5432, database jukecord, without TLS)
  tracks            1000
  ...
```

`./jukecord db ...` runs in jukecord's container, or in a container of its own while jukecord is stopped, so a SQLite
address there is a path inside the container, where `/data` is the volume. `./jukecord status` then says
`Database: PostgreSQL`. The SQLite file stays in the volume until you remove it, and the media cache stays where it
was.

- **The release's programs**: stop jukecord, set `JUKECORD_DATABASE_URL` in `.env`, run `./jukecord db copy sqlite:`
  (the data folder's file), and start it again.
- **Kubernetes**: [a database server](KUBERNETES.md#a-database-server) in the Kubernetes guide.

`jukecord db status [<address>]` says what a database holds, the one jukecord uses when no address is given:

```
Database: PostgreSQL (database:5432, database jukecord, without TLS)
Server: PostgreSQL 18.7
Schema: 8, this jukecord's
Size: 3.2 MiB
Round trip: 0.85 ms
Rows: 12571 (1000 tracks, 10000 plays, 1000 queued, 3 playlists)
```

Both end with the command's [exit codes](README.md#the-jukecord-command): 1 for a refusal (a target that holds data, a
schema of another jukecord, the same database twice), 2 for a typing mistake, 3 when the database does not answer.
`--json` prints what they report as JSON.

## Logging in through your own accounts

Besides Discord and the host's login links, people can log in through your identity provider (OpenID Connect:
Keycloak, Authentik, Microsoft Entra ID, Okta, Google and others) or with an account of your directory (LDAP:
OpenLDAP, FreeIPA, Active Directory). Each way is off until its address is set, and the login page shows the ways that
are set up.

Someone who logs in this way is a **member**, at the level their groups give them at that login:

| Level     | May                                                                                |
| :-------- | :--------------------------------------------------------------------------------- |
| `admin`   | what the host may: every server and its settings, the log, login links and backups |
| `control` | change the music in every server, as a friend with control                         |
| `read`    | look and listen                                                                    |

- The groups decide every login: someone in none of the three lists is refused, and `*` in a list gives its level to
  everyone the provider or the directory lets in. Someone in several gets the widest.
- A level changes at the person's next login.
- What a member adds, likes and saves shows their name. jukecord keeps that name and the time of their last login,
  nothing else of theirs.
- Members make no API tokens, since a token would outlast what their groups say at the next login. An admin member
  sees and revokes everyone's.

### OpenID Connect

Register jukecord with the provider as a client whose redirect is `<JUKECORD_PUBLIC_URL>/auth/sso/callback`, and whose
address after logging out is `<JUKECORD_PUBLIC_URL>/login`. Then set:

| Setting                                                                                   | What it is                                                                                                                                    |
| :---------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------- |
| `JUKECORD_OIDC_ISSUER`                                                                    | the issuer, exactly as the provider names itself (`https://sso.example.com/realms/home`)                                                      |
| `JUKECORD_OIDC_CLIENT_ID`                                                                 | the client's ID                                                                                                                               |
| `JUKECORD_OIDC_CLIENT_SECRET` (or `_FILE`)                                                | the client's secret; none for a public client, which proves itself with PKCE alone                                                            |
| `JUKECORD_OIDC_SCOPES`                                                                    | the scopes asked for (`openid profile`)                                                                                                       |
| `JUKECORD_OIDC_GROUPS_CLAIM`                                                              | the claim with the groups or roles: `groups`, or a dotted path such as `realm_access.roles`                                                   |
| `JUKECORD_OIDC_ADMIN_GROUPS`, `JUKECORD_OIDC_CONTROL_GROUPS`, `JUKECORD_OIDC_READ_GROUPS` | the groups of each level, separated by commas                                                                                                 |
| `JUKECORD_OIDC_LABEL`                                                                     | the words on the login key (`Log in with SSO`), 40 characters at most                                                                         |
| `JUKECORD_OIDC_DISCORD_CLAIM`                                                             | a claim with a Discord user ID: such a login is that Discord user, with their Discord rights in each server and the level where it gives more |

jukecord finds the provider from the issuer's discovery document, sends the browser there with the authorization code
flow (PKCE, state and nonce), and checks the ID token's signature against the issuer's keys, with its issuer, audience,
expiry and nonce; it asks the provider's userinfo when the token carries too little. Nothing of the provider's is kept
once the person is in. Logging out of jukecord logs out at the provider too, when the provider offers it. Groups are
compared regardless of case, and a leading `/` (Keycloak's full group path) is the same as none.

#### Keycloak, step by step

In the realm people log in to (`home` here), in Keycloak's admin console:

1. **Clients**, **Create client**: client type **OpenID Connect**, client ID `jukecord`. Next: **Client
   authentication** on and **Standard flow** on. Next: **Valid redirect URIs**
   `https://music.example.com/auth/sso/callback` and **Valid post logout redirect URIs**
   `https://music.example.com/login`. Save.
2. The client's **Credentials** tab shows its **Client Secret**.
3. **Groups**: make `jukecord-admins` and `jukecord-djs`, and put people in them (**Users**, a person, **Groups**,
   **Join Group**).
4. The groups in the tokens: the client's **Client scopes** tab, `jukecord-dedicated`, **Configure a new mapper**,
   **Group Membership**. Name and **Token Claim Name** `groups`, **Full group path** off, **Add to ID token** and **Add
   to userinfo** on. Save.
5. In `.env`, then `./jukecord up`:

   ```bash
   JUKECORD_PUBLIC_URL=https://music.example.com
   JUKECORD_OIDC_ISSUER=https://sso.example.com/realms/home
   JUKECORD_OIDC_CLIENT_ID=jukecord
   JUKECORD_OIDC_CLIENT_SECRET=<the client secret>
   JUKECORD_OIDC_LABEL=Log in with Home SSO
   JUKECORD_OIDC_ADMIN_GROUPS=jukecord-admins
   JUKECORD_OIDC_CONTROL_GROUPS=jukecord-djs
   JUKECORD_OIDC_READ_GROUPS=*
   ```

6. `./jukecord auth test-oidc` reads the provider's document and keys and tries the client's secret, logging nobody
   in. The login page then has a **Log in with Home SSO** key.

Keycloak's realm roles in place of groups: `JUKECORD_OIDC_GROUPS_CLAIM=realm_access.roles`, and in **Client scopes**,
`roles`, **Mappers**, `realm roles`, turn **Add to userinfo** on (Keycloak puts realm roles in the access token alone
unless told). A wrong client secret is Keycloak's `unauthorized_client`.

Other providers take the same two addresses. Set `JUKECORD_OIDC_GROUPS_CLAIM` to the claim their tokens carry the
groups or roles in, and add the scope that brings it to `JUKECORD_OIDC_SCOPES` when the provider wants one asked for.
A provider that speaks only SAML can reach jukecord through a broker that speaks both, such as Keycloak.

### LDAP and Active Directory

jukecord's service account finds the person under the base DN with the user filter and reads their groups; then the
directory checks the person's password, by a bind as them. The login page's form sends the name and the password to
jukecord, which never logs or keeps either.

| Setting                                                                                   | What it is                                                                                                                         |
| :---------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------- |
| `JUKECORD_LDAP_URL`                                                                       | `ldaps://host` (encrypted) or `ldap://host`, with a port when not the usual                                                        |
| `JUKECORD_LDAP_STARTTLS`                                                                  | `yes` encrypts an `ldap://` connection before anything is sent                                                                     |
| `JUKECORD_LDAP_CA_FILE`                                                                   | the certificates (PEM) of a private authority that signed the directory's                                                          |
| `JUKECORD_LDAP_BIND_DN`, `JUKECORD_LDAP_BIND_PASSWORD` (or `_FILE`)                       | the service account: a DN, or for Active Directory `jukecord@corp.example.com` or `CORP\jukecord`; neither for an anonymous search |
| `JUKECORD_LDAP_BASE_DN`                                                                   | where people are looked for                                                                                                        |
| `JUKECORD_LDAP_USER_FILTER`                                                               | the filter that finds one person, `{username}` where the typed name goes (`(uid={username})`)                                      |
| `JUKECORD_LDAP_GROUP_FILTER`, `JUKECORD_LDAP_GROUP_BASE_DN`                               | groups from a search, `(member={dn})` say, in place of the person's `memberOf`                                                     |
| `JUKECORD_LDAP_NESTED_GROUPS`                                                             | `yes`: Active Directory's nested groups, a group inside a group counting too                                                       |
| `JUKECORD_LDAP_ADMIN_GROUPS`, `JUKECORD_LDAP_CONTROL_GROUPS`, `JUKECORD_LDAP_READ_GROUPS` | the groups of each level, by DN or by name, separated by semicolons                                                                |
| `JUKECORD_LDAP_TIMEOUT`                                                                   | how long each request may take (`10s`)                                                                                             |
| `JUKECORD_LDAP_LABEL`                                                                     | the words on the form's key, 40 characters at most                                                                                 |

The typed name is escaped before it goes into a filter, and an empty password is refused before the directory is
asked. Failed logins count against the address and against the name: twenty block them for ten minutes.

OpenLDAP, with groups read from the person's `memberOf` (its memberof overlay keeps it):

```bash
JUKECORD_LDAP_URL=ldaps://ldap.example.org
JUKECORD_LDAP_BIND_DN=cn=jukecord,ou=services,dc=example,dc=org
JUKECORD_LDAP_BIND_PASSWORD=<the service account's password>
JUKECORD_LDAP_BASE_DN=ou=people,dc=example,dc=org
JUKECORD_LDAP_ADMIN_GROUPS=jukecord-admins
JUKECORD_LDAP_CONTROL_GROUPS=jukecord-djs
JUKECORD_LDAP_READ_GROUPS=*
```

A directory without `memberOf` finds the groups by a search instead:
`JUKECORD_LDAP_GROUP_FILTER=(uniqueMember={dn})` (or `(member={dn})`, or `(memberUid={username})` for POSIX groups)
with `JUKECORD_LDAP_GROUP_BASE_DN=ou=groups,dc=example,dc=org`. The service account needs to read people and groups,
never passwords.

Active Directory:

```bash
JUKECORD_LDAP_URL=ldaps://dc1.corp.example.com
JUKECORD_LDAP_CA_FILE=/data/corp-ca.pem
JUKECORD_LDAP_BIND_DN=jukecord@corp.example.com
JUKECORD_LDAP_BIND_PASSWORD=<the service account's password>
JUKECORD_LDAP_BASE_DN=OU=People,DC=corp,DC=example,DC=com
JUKECORD_LDAP_USER_FILTER=(sAMAccountName={username})
JUKECORD_LDAP_NESTED_GROUPS=yes
JUKECORD_LDAP_ADMIN_GROUPS=CN=Music Admins,OU=Groups,DC=corp,DC=example,DC=com
JUKECORD_LDAP_CONTROL_GROUPS=DJs
JUKECORD_LDAP_READ_GROUPS=*
```

- A domain controller that requires LDAP signing (Samba does by default) takes passwords over an encrypted connection
  only: `ldaps://`, or `ldap://` with `JUKECORD_LDAP_STARTTLS=yes`. Its certificate is usually signed by the domain's
  own authority, whose certificate `JUKECORD_LDAP_CA_FILE` names; with Compose it goes into the volume, readable:
  `chmod 644 corp-ca.pem && docker compose cp corp-ca.pem jukecord:/data/corp-ca.pem`.
- The login page tells an expired password, or one that must be changed first, from an account that is turned off or
  locked.
- `JUKECORD_LDAP_NESTED_GROUPS` is Active Directory's rule; OpenLDAP answers it with no groups at all.

`./jukecord auth test-ldap` connects, binds as the service account and reads the base DN;
`./jukecord auth test-ldap mina` also finds that person and says their groups and the level those give, without their
password.

## Split into services

jukecord runs as one process by default, which suits a group of friends. The same image can also run as one **core**
and any number of **edges**:

- **The core**, exactly one: Discord's gateway and voice, every server's player and queue, the media and its cache
  (the one volume), the daily backup and the alerts.
- **An edge**, as many as you like: the panel, the API, the live updates, the logins, and the browsers' audio, which it
  streams from the core.

They share a PostgreSQL or MySQL/MariaDB database (a SQLite file belongs to one process) and a Redis or Valkey server
(Redis 6.2 or newer). That server carries the bus between them, each change the core announces and each command an
edge sends it, and the shared cache: the rate limits, the login links, the logins under way through SSO, the
searches. Edges come and go while the core plays on: one restarted or drained leaves the others serving. The core
stays one, since a bot token holds one Discord connection: restarting it pauses the music as restarting one process
does, and the panels reconnect to the new one by themselves.

| Setting                                 | For           | What it is                                                                                        |
| :-------------------------------------- | :------------ | :------------------------------------------------------------------------------------------------ |
| `JUKECORD_ROLE`                         | every service | `core` or `edge` (`all`, one process, by default)                                                 |
| `JUKECORD_DATABASE_URL`                 | every service | the database they share, on a server                                                              |
| `JUKECORD_BUS_URL` (or `_FILE`)         | every service | the Redis or Valkey server: `redis://valkey:6379`, `rediss://` for TLS, a password in the address |
| `JUKECORD_CACHE_URL` (or `_FILE`)       | every service | the shared cache, on the bus's server unless this names another                                   |
| `JUKECORD_KEY_PREFIX`                   | every service | what jukecord's keys and channels go under (`jukecord`), so several jukecords share one server    |
| `JUKECORD_INTERNAL_SECRET` (or `_FILE`) | every service | the secret the core and its edges share, 32 characters or more                                    |
| `JUKECORD_INTERNAL_PORT`                | the core      | its port for the edges, the audio and the covers (`8796`)                                         |
| `JUKECORD_CORE_URL`                     | an edge       | where that port is (`http://core:8796`)                                                           |

The core's `JUKECORD_PORT` answers `/healthz`, `/readyz` and `/metrics` only, and its internal port only requests that
carry the secret; an edge's `JUKECORD_PORT` is the panel's. One process may keep its cache on Redis or Valkey too, with
`JUKECORD_CACHE_URL` alone: the searches and the matches of other services' links then outlast a restart.

### A split with Docker Compose

`deploy/split/compose.yaml` runs a core, two edges, PostgreSQL, Valkey, and Caddy in front, which spreads browsers
over the edges. In the checkout:

```bash
cp deploy/split/split.env.example deploy/split/.env
# Set JUKECORD_DB_PASSWORD and JUKECORD_INTERNAL_SECRET in it (openssl rand -hex 32 makes each).
docker compose -f deploy/split/compose.yaml up -d --build
docker compose -f deploy/split/compose.yaml exec edge1 jukecord link
```

- Every service reads jukecord's settings from the checkout's `.env`, the one process's own, so a jukecord that grows
  into services keeps them. `deploy/split/.env` has the split's own: the two secrets, the port, the image. In
  `deploy/split` itself, a plain `docker compose` finds `compose.yaml` and that `.env`.
- Only the front is published, on `JUKECORD_BIND` and `JUKECORD_PORT` (127.0.0.1:8795).
- With MySQL in place of PostgreSQL, every command also takes `-f deploy/split/compose.mysql.yaml`.
- The `jukecord` command runs in an edge: `docker compose -f deploy/split/compose.yaml exec edge1 jukecord status`.
  `./jukecord` is the one process's front door.

A one-process jukecord's data moves in before the split's first start, with the copy run in the core's place:

```bash
./jukecord down
docker compose -f deploy/split/compose.yaml up -d database
docker compose -f deploy/split/compose.yaml run --rm --no-deps -v jukecord_jukecord-data:/old core \
  jukecord db copy sqlite:/old/jukecord.db
docker compose -f deploy/split/compose.yaml up -d --build
```

`exec edge1 jukecord backup` makes a backup in the core's volume (the core makes it), as `JUKECORD_BACKUP_AT` does
every day; `docker compose -f deploy/split/compose.yaml cp core:/data/backups/<file> .` copies one out. To put one
back, stop what writes to the database, bring the file in as jukecord's own user (a file copied in with `cp` keeps
this machine's owner, which that user cannot read), copy it into the database, and start again:

```bash
split="docker compose -f deploy/split/compose.yaml"
$split stop core edge1 edge2
$split run --rm --no-deps -T --entrypoint sh core -c 'cat > /data/restore.db' < jukecord-<time>.db
$split run --rm --no-deps core jukecord db copy sqlite:/data/restore.db --replace
$split run --rm --no-deps --entrypoint rm core /data/restore.db
$split up -d
```

A backup still in the core's `/data/backups` needs no copying in or removing: the copy takes it from there
(`sqlite:/data/backups/<file>`). On Kubernetes, the chart's `mode: split` runs the same
([Kubernetes](KUBERNETES.md#split-into-services)).

## Monitoring

### Metrics

`/metrics` answers in Prometheus's text format, or in OpenMetrics when asked for it: the players by state, the queues,
the fetches and the media cache, the HTTP answers and their times, the live connections, the database's statements and
connections, the shared cache, the logins, Discord's gateway, the bus between services, and the process's and Node.js's
own figures ([every family](API.md#metrics)).

It needs no login, so jukecord answers it only to a scraper on this machine or its private network that asks
directly: a request that came through a reverse proxy (it carries `X-Forwarded-For` or `Forwarded`), or from a public
address, gets a 404. A Prometheus elsewhere shows a token instead:

```bash
JUKECORD_METRICS_TOKEN=<openssl rand -hex 32>
```

```yaml
scrape_configs:
  - job_name: jukecord
    static_configs:
      - targets: ["jukecord.example.internal:8795"]
    authorization:
      credentials_file: /etc/prometheus/jukecord-metrics-token
```

A request that shows the right token is let in from anywhere, one with a wrong token gets a 401, and one with none
falls back to the address rule. The token is one word of 16 characters or more; `JUKECORD_METRICS_TOKEN_FILE` reads it
from a file.

### Readiness, health and logs

`/healthz` answers 200 while the process runs. `/readyz` says, part by part, whether jukecord can serve:

```json
{
  "ready": true,
  "discord": false,
  "parts": {
    "database": { "state": "ok", "required": true, "kind": "postgres" },
    "bus": { "state": "ok", "required": true, "kind": "in-process" },
    "cache": { "state": "ok", "required": true, "kind": "memory" },
    "ffmpeg": { "state": "ok", "required": false },
    "yt-dlp": { "state": "ok", "required": false }
  }
}
```

It answers 503 while a required part does not work: the database, the bus, the shared cache, and for an edge its core.
Discord and the media programs are reported without deciding it, so the panel still loads and says what is wrong.

`JUKECORD_LOG_FORMAT=json` writes the console's lines as JSON, one object a line, for a log shipper (Loki,
Elasticsearch, CloudWatch); the log files in the data folder are JSON either way.

### Prometheus and Grafana beside jukecord

`deploy/monitoring` runs both with Compose, beside a running jukecord:

```bash
cd deploy/monitoring
docker compose up -d
```

- Grafana opens on jukecord's dashboard at http://127.0.0.1:3000 (anyone on this machine may look; log in as `admin`,
  password `admin` the first time, to change anything), and Prometheus is at http://127.0.0.1:9090 with jukecord's
  alert rules loaded.
- Both join jukecord's Compose network and scrape it there, from a private address, so no metrics token is needed. A
  jukecord under another project name is reached with `JUKECORD_NETWORK=<project>_default`; `GRAFANA_PORT` and
  `PROMETHEUS_PORT` move the two ports.
- For the Compose split: `JUKECORD_NETWORK=jukecord-split_default`, and in `prometheus.yml` the targets
  `["core:8795", "edge1:8795", "edge2:8795"]`.
- `docker compose down` stops them; their data stays in two volumes until `docker compose down -v`.

The dashboard (`grafana-dashboard.json`) imports into a Grafana of your own: it asks which Prometheus to read, then
which jukecord jobs and instances. The rules (`alerts.yaml`) load into a Prometheus with `rule_files`, or into a
PrometheusRule for the Prometheus Operator:

| Alert                           | Fires when                                                                             |
| :------------------------------ | :------------------------------------------------------------------------------------- |
| `JukecordDown`                  | Prometheus has not scraped jukecord for five minutes                                   |
| `JukecordNotReady`              | `/readyz` has answered 503 for five minutes                                            |
| `JukecordDiscordDisconnected`   | the bot has been away from Discord for ten minutes                                     |
| `JukecordFetchFailuresClimbing` | most of the last half hour's fetches failed, five at least                             |
| `JukecordCacheFull`             | the media cache is over its limit, or the disk under it has less than 1 GiB free       |
| `JukecordEventLoopStalling`     | jukecord has been behind for a quarter of the time for five minutes                    |
| `JukecordNoEdges`               | a split's core has heard from no edge for ten minutes                                  |
| `JukecordCoreNotAnswering`      | most of an edge's commands to the core went unanswered in ten minutes, twenty at least |

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
- The database moves to a newer schema by itself on the first start of a newer jukecord. A database server is moved
  under a lock, so the services of a split starting at once wait for the first.
- An older jukecord refuses a database a newer one has written: to go back, restore the backup made before the update.
  In a split, every service runs the same version.

## Backups

`./jukecord backup` writes a consistent copy of the database while the music and the panel go on, however big the
database, and prints its whole path; when it cannot, it says why and ends with the jukecord command's
[exit code](README.md#the-jukecord-command). The media cache stays out: tracks are fetched again when played. To put
one back:

```bash
./jukecord restore backups/jukecord-<time>.db
```

- It stops jukecord, puts the copy back and starts it again, also after `./jukecord down`.
- A relative name counts from the folder the command is typed in; the whole path that `backup` printed works from
  anywhere.
- The database it replaces stays in the volume as `jukecord.db.before-restore-<time>`.
- A file that is not a whole jukecord backup (another file, or a backup cut short) is refused before anything stops,
  whatever its size.

### On a database server

A backup of PostgreSQL or MySQL/MariaDB is a SQLite file of the whole database too, read as one moment's view, so any
backup goes back into any kind of database. The server's own tools (`pg_dump`, `mysqldump`, a hosted database's
snapshots) work beside it.

- With `JUKECORD_DATABASE_URL` in `.env`, `./jukecord restore <file>` copies the backup into that database in one
  transaction, all of it or nothing. What the database held is saved in the volume first, as
  `jukecord-before-restore-<time>.db`.
- With the release's programs, stop jukecord, then copy the backup into the database jukecord uses, and start it
  again:

  ```bash
  ./jukecord db copy configured sqlite:before-restore.db    # what it holds now, beside the data
  ./jukecord db copy sqlite:/path/to/jukecord-<time>.db --replace
  ```

- On Kubernetes, [backup and restore](KUBERNETES.md#backup-and-restore) has both kinds.

### Every day

`JUKECORD_BACKUP_AT=04:30` in `.env`, then `./jukecord up`, makes a backup every day at that time in this machine's
time zone (`TZ` in `.env` sets another), or on the first start after that time on a day without one. The volume's
`backups` folder keeps the newest `JUKECORD_BACKUP_KEEP` (7) of jukecord's own, `jukecord-<time>.db`; a file put there
under another name is left alone and not counted. `./jukecord doctor` says how old the newest backup is and how big
the database is; a failed one is in the log and the alerts channels. To copy one out of the volume:

```bash
docker compose cp jukecord:/data/backups/<file> .
```
