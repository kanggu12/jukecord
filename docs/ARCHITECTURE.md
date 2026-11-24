# How jukecord is built

jukecord is written in TypeScript and run as it is (Node strips the types; there is no build step for the server, and
the image carries the source with the types already stripped, line for line). One Node process holds all of it by
default. The same code also runs as one core and any number of edges, for a host who splits it into services. Its
parts, from the outside in:

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/architecture-dark.webp">
    <img alt="jukecord's parts, from the outside in. Along the top, the ways in: the panel in a browser, where Mina, Joon and Sol play along, and the jukecord command and the HTTP API with a token reach the edges; slash commands in Discord reach the core, which plays in the voice channel. The edges, any number of them, hold the HTTP API, the panel and its live updates, the logins, who may do what, and the audio for browsers. The core, one, holds the actions, every server's player and queue, Discord's gateway and voice, and the media. Below them: the shared cache, in memory or on Redis or Valkey, which the edges use; the bus, in the process or on Redis or Valkey, carrying commands from the edges to the core and changes back; and the media cache, where yt-dlp and ffmpeg leave each track as Ogg Opus. The edges and the core both keep their data in one database: SQLite, PostgreSQL or MySQL/MariaDB, holding queues, history, playlists, settings, logins and tokens. Every service answers /metrics for Prometheus and /readyz part by part, and can log JSON lines. Rainbow lines are the music people hear: from the core to the voice channel, and through the edges to the browsers." src="assets/architecture-light.webp" width="100%">
  </picture>
</p>

In one process the edge and the core are the same process: the bus carries its events in memory, and the shared cache
is in memory too. The [roles](#one-process-or-a-core-and-its-edges) say what changes when they are apart.

## The actions are the product

`src/app/actions.ts` holds every action a person can take: add, play now, skip, seek, the queue edits, playlists,
voice, statistics, the DJ role. The panel, the slash commands, the API and the CLI only turn their input into a call
of one of these and show the answer. So a feature exists when it is an action, and the four ways in cannot drift apart:
the slash commands are a record over all action names (a missing one does not compile), the API is a table of
operations from which the server's routes, the OpenAPI document and the CLI's requests are all made, and a test checks
the four lists against each other.

## The player is the clock

Each server has one player (`src/core/player.ts`), a small state machine: idle, loading (fetching the track), playing,
paused. It decides where in the track everyone is. Every change ends in a snapshot: the status, the track, the place
(`positionMs`) at a server time (`at`), and a version number. The voice connection is told to start, pause or stop;
browsers get the snapshot over WebSocket and play the same file from the same place, correcting themselves when they
drift more than 300 ms. Each start of the outputs gets a session number, so an "ended" from a stream already replaced
(by a seek, or a skip) is recognised and ignored.

A server's changes take turns in its own lane (`src/core/lanes.ts`): an action, a player's transition, autoplay's pick
and the votes of one server run one after another, while other servers' run beside them. The database answers
asynchronously, and the lanes keep what a single synchronous step kept before: two changes of one server never land
inside each other. A player does its database work first and changes its state in memory in one step after, so nobody
outside its lane ever sees a half-changed player.

## Live updates for a crowd

Every panel showing a server gets the same messages, so each is made once for all of them (`src/web/events.ts`). The
queue goes out whole, at most four times a second: changes made close together are one message with the queue as it
ended, and the panel replaces its queue with each one. Who is listening goes out at most once a second, naming the
first twenty people. A big message is compressed once, as gzip, and the same bytes go to every panel whose browser can
unpack it; the WebSocket's own compression, which compressed every message again for each connection and kept a
compressor per connection, is off. A server's queue is serialised once per change, and a panel subscribing takes it
from there, adding only its own part (its voice channels). There are at most `JUKECORD_LIVE_MAX` connections (1000),
ten per login and twenty per address; one more is closed at once with 1013 and the reason, which the panel shows
before it tries again, later than after a drop. In a split, each edge holds its own panels' connections and these
caps, and makes its messages from the changes the core sends it.

## When it is busy

Changes are held to a rate per login and per address (token buckets: ten a second with twenty at once, and two a
second for the ones that start a fetch, like skip), and reads to a wider one (thirty a second with sixty at once, per
person, or per address without a login), answered with 429 and Retry-After beyond it. The buckets are kept in the
shared cache, so the edges of a split count a person together. While a process's event loop has fallen behind (the
99th percentile of its delay over the last second above 0.2 s) it turns away what can wait (audio for everyone, and
changes from anyone but the host) with 503 and Retry-After until it has caught up. The voice of every server and the
panels' live updates are what it catches up on. Fetches somebody waits for run at most twice the fetch limit at once
(four on two cores): in a storm of skips the newest waits a moment for a place, and the ones skipped while they waited
never start.

## Getting a track

The resolver turns what was typed into tracks: an address seen before without asking the site, anything else through
yt-dlp (one request for a whole playlist). The preparer runs yt-dlp and ffmpeg together through a pipe: yt-dlp fetches
the best audio, ffmpeg evens the loudness (measured once per track and stored), adds a short fade in and out, and
writes Ogg Opus. That file is what Discord carries, so voice sends it as it is, and browsers get the same file (or an
MP3 copy made the first time a browser without Opus asks). A server that set a volume for its voice channel or a sound
gets that stream decoded, filtered and encoded again by ffmpeg, from the place the track is; browsers apply the same
sound themselves (`src/core/sound.ts` holds the sounds for both). The next tracks are prepared while one plays. Each
track's cover is fetched once too, by jukecord itself under the same address rule, and kept beside the audio; the panel
shows it from jukecord. The cache keeps the files up to its size limit, removing the least recently used first (a cover
by its own use) and never the one playing or the next ones.

Search words can also be searched first (`src/media/search.ts`): the results are kept for a while in the shared cache,
and the one picked is added from what the search learned. A link of Deezer, Spotify or Apple Music
(`src/media/links.ts`) is read from that service for its tracks, each found on YouTube, and what was found is kept in
the shared cache for a day; such lists, and an imported playlist's lines, take their turns three at a time
(`src/media/batch.ts`), apart from the lookups people wait for. Autoplay (`src/app/autoplay.ts`) listens to the players
and queues one track when a queue is about to run out.

yt-dlp reaches the internet only through a small proxy inside jukecord (`--proxy` to 127.0.0.1). The proxy resolves
each name itself, refuses addresses on private networks, and connects to the very address it checked, so a redirect, a
playlist entry or a name that answers differently the second time cannot make the server fetch from its own network.
An address someone types is also checked before yt-dlp starts, which gives the clearer message.

## Looking after itself

A few watches run beside the music, each in a file of its own. `src/app/rest.ts` pauses a playing server nobody hears
anywhere (the bot out of its voice channel, no browser playing along) after two minutes, from the bus's player, voice
and listener events. `src/discord/rejoin.ts` keeps the voice channel each server's bot is in, from the bus's voice
events, and goes back to it after a restart when people are there. `src/discord/keeper.ts` edits the newest
now-playing card of each server as its player changes, at most every five seconds. `src/app/alerts.ts` tells the
alerts channel a server chose (and the log) about trouble, each kind at most once an hour: YouTube's check for bots
(from how fetches and lookups go), a restart by the watchdog (it leaves a mark the next start reads), a disk nearly
full, a track taken out of a looping queue, connections turned away at a cap, a scheduled backup that failed.
`src/app/backups.ts` makes the backups, the daily one too.

## The ports

The parts that a host can swap sit behind interfaces of their own, each with an adapter for one process and one for
services:

| Port      | In one process                    | Apart                                         | Where                                      |
| :-------- | :-------------------------------- | :-------------------------------------------- | :----------------------------------------- |
| The store | SQLite (Node's own `node:sqlite`) | PostgreSQL (`pg`) or MySQL/MariaDB (`mysql2`) | `src/store/`                               |
| The bus   | in memory                         | Redis or Valkey (`@redis/client`)             | `src/bus/`, `src/core/bus.ts`              |
| The cache | in memory, with size bounds       | Redis or Valkey                               | `src/cache/`                               |
| Metrics   | one registry per process          | one per service                               | `src/metrics/`                             |
| Health    | the parts of one process          | each role's own parts                         | `src/app/health.ts`, `src/roles/health.ts` |

**The store.** Sixteen repositories (tracks, queues, history, playlists, sessions, tokens ...) write their SQL by
hand, with `?` for each value, over an executor (`src/store/sql.ts`): `run`, `get`, `all`, and `transaction`, which
the repositories' calls inside it join by themselves (the open transaction follows the call through
`AsyncLocalStorage`). The executors are SQLite's (`sqlite.ts`: write-ahead log, prepared statements kept, one writer
at a time), PostgreSQL's and MySQL's (`postgres.ts`, `mysql.ts`, over a pool and the shared transaction, retry and
savepoint logic of `pooled.ts`). What differs between the three is in `dialect.ts`: upserts, the id of a row just made,
null-safe comparisons, whole-number division, a long address as a unique key (its hash, on the servers). `schema.ts` holds the migrations; `copy.ts`
copies every row of one database into another; `open.ts` opens the database an address names
(`address.ts`), waiting for a server that is not up yet.

**The bus.** In one process, the players' and queues' changes go to their listeners (the live updates, the Discord
cards, the watches) through an event emitter. Apart, the same events reach the edges over Redis or Valkey
(`relay.ts`), the edges' calls reach the core as commands with a time limit (`commands.ts`), each edge reports who
listens there (`presence.ts`), and the core's heartbeat says it runs (`beat.ts`).

**The cache.** Short-lived state that every process serving browsers must agree on: the rate limits, failed logins by
address and by name, one-time login links, a login through SSO under way, the searches' results, the matches of other
services' tracks. Losing it costs a lookup again, or a login link made again; nothing in it is the only copy.

**Metrics and health.** Each part declares its figures into one registry (`registry.ts`), which writes Prometheus's
text format or OpenMetrics; the database's executors, the bus and the cache report through small interfaces of their
own, so the adapters of one process and of services report alike. `src/app/health.ts` checks the parts `/readyz`
answers with, at most once a second.

## One process, or a core and its edges

`JUKECORD_ROLE` decides what a process is (`src/main.ts` puts each together):

- **all** (the default): everything above, in one process.
- **core**, exactly one: the actions, every server's player and queue, Discord's gateway and voice, the media and its
  cache, the backups and the alerts (`src/roles/core.ts`). Its own port answers `/healthz`, `/readyz` and `/metrics`
  only; its internal port sends the edges the audio and the covers of its media cache, to a request that carries the
  secret the core and its edges share (`internal.ts`).
- **edge**, any number: the HTTP API, the panel's files, the live updates, the logins, and the audio for browsers,
  streamed from the core (`src/roles/edge.ts`). The web server is the one of one process, over what it asks of the
  core (`src/web/core.ts`): every action, the access rules, and the host's jobs (a backup, the log, the self-check) are
  commands over the bus, answered by the core; the core's events feed the edge's live updates.

What stays where:

- **In the database**, which every service reaches: the queues, the history, the playlists, the settings, the people,
  and the sessions, tokens and listening links. So any edge serves any browser, and a token made on one works on all.
- **In the shared cache**: the rates, the login links, the SSO logins under way, the searches.
- **In the core alone**, since one place holds them: the players' clocks, the voice connections, what Discord said about
  members (kept a minute), the votes, autoplay's state, the media cache's index. Nothing to share: there is one core.
- **In each process**: its connections and the caps on them, which protect its own memory.

The core takes a lease on the bus's server before anything else starts (20 seconds, renewed every four), so a second
core waits and takes over when the first stops; a core that cannot renew its lease for 15 seconds steps down. An edge
takes the core for lost after five seconds without its heartbeat, or at its goodbye: then every command waiting for it
is refused at once (503), and every live connection is closed with 1012, so each panel reconnects and asks for the
whole state of the new core. A command is published once: when no core hears it, it is refused at once, and one that
reaches the core after its caller gave up is not run.

## Storage

One database, SQLite by default: a file in the data folder (Node's built-in driver, no native add-on, so the same image
runs on amd64 and arm64), with the write-ahead log. PostgreSQL 14 or newer and MySQL 8.0 or newer (MariaDB 10.11 or
newer) are the other choices, through `JUKECORD_DATABASE_URL`. The database holds tracks, queues, history (the newest
10,000 plays per server), playlists, each player's state (so a restart comes back paused at the same place), settings,
the people jukecord has met (for names in the panel), panel logins and API tokens (both as SHA-256 hashes).

Migrations are numbered and recorded in the database. SQLite runs them from the first; PostgreSQL and MySQL start at a
baseline that is schema 8 in one step, and every migration after it is written for the three. A server's migrations
run under a lock of the server's own, so services starting at once on a new database wait for the first. On servers
every transaction is serializable, and one the server refuses for another's sake is run again from the start.

A backup is a consistent copy of the whole database as a SQLite file, while jukecord runs: SQLite's own `VACUUM INTO`,
or for a server a copy read as one moment's view. So any backup goes back into any kind of database, with
`jukecord db copy` or the front door's restore.

## Logging in

The host (the machine running jukecord) has a token in the data directory, readable by jukecord's user only; its
command line uses it, and it can make one-time login links for a browser. People log in with Discord (OAuth2, the
`identify` scope only); whether they are in a server, and with which roles, is asked through the bot and kept for a
minute. A host can also let people in through an identity provider of its own (OpenID Connect, `src/auth/oidc.ts`) or
a directory (LDAP, Active Directory, `src/auth/ldap.ts`): these are members, at the level their groups give at each
login (`src/auth/levels.ts`). Programs use API tokens with a scope. A panel session changes nothing without its CSRF
token in a header. Sessions, tokens and listening links are rows of the database; login links, failed logins and an
SSO login under way wait in the shared cache, so they work across edges.

## Files

| Path            | What is there                                                                         |
| :-------------- | :------------------------------------------------------------------------------------ |
| `src/main.ts`   | starts the parts of a role in order and stops them in order                           |
| `src/config.ts` | the settings, every problem reported at once                                          |
| `src/app/`      | the actions, who may do what, the self-check, readiness, the watches above            |
| `src/core/`     | queue, player, lanes, clock, event bus                                                |
| `src/media/`    | yt-dlp, ffmpeg, the cache, preparing and prefetching                                  |
| `src/discord/`  | the bot, slash commands, cards, voice                                                 |
| `src/web/`      | the API table, routes, logins, live updates, OpenAPI                                  |
| `src/auth/`     | logging in through OIDC and LDAP, and their settings                                  |
| `src/store/`    | the store, its executors and dialects, the migrations, copying a database             |
| `src/bus/`      | the bus between services: transports, commands, events, presence, heartbeat           |
| `src/cache/`    | the shared cache, in memory or on Redis or Valkey                                     |
| `src/metrics/`  | the registry, the figures of each part, who may read `/metrics`                       |
| `src/roles/`    | the core's and the edge's own parts, and the core's ports                             |
| `src/cli/`      | the `jukecord` command, and `jukecord db`                                             |
| `panel/`        | the browser app (TypeScript, bundled with esbuild)                                    |
| `deploy/`       | the Dockerfile, the Helm chart, the split's Compose files, monitoring, the kind tests |
| `tests/`        | unit, integration, packaging, UI, login, split and performance tests                  |
