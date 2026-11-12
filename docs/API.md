# The jukecord API

Everything the panel does, a program can do over HTTP. The panel itself uses this API, the `jukecord` command uses it,
and the Discord bot calls the same actions inside the process, so the four always offer the same things.

- Every path is under `/api/v1`.
- The whole API is described as OpenAPI 3.1 at `/api/v1/openapi.json` (any OpenAPI viewer or client generator reads it).
- Requests and answers are JSON. Fields an operation does not know are ignored.

## Logging in

**API tokens** are for programs. Make one in the panel (menu, API tokens) or with the command line, and send it in the
`Authorization` header:

```bash
./jukecord token create my-script --scope control
curl -H "Authorization: Bearer jkc_..." http://localhost:8795/api/v1/me
```

A token has one of three scopes:

| Scope     | It may                                                              |
| :-------- | :------------------------------------------------------------------ |
| `read`    | look: what plays, the queue, the history, statistics                |
| `control` | also change the music: add, skip, pause, edit the queue, join voice |
| `admin`   | also change the server's DJ role and manage tokens                  |

A token acts as the person who made it: in Discord servers they are not a member of, it can do nothing, and where the
server has a DJ role, changing the music needs that role (or Manage Server). Only the token's SHA-256 is stored, so a
lost token cannot be shown again; revoke it and make another.

**The host** is the machine jukecord runs on. Its token is in the data directory (`host-token`, readable by jukecord's
user only), which is how `./jukecord <command>` works without logging in. The host may do everything, including the
operations marked "the host" below, which span every server: the log, login links, backups and the self-check.

**The panel** logs in with a cookie (Discord login, or a one-time link from `jukecord link`). A cookie alone changes
nothing: every change must also carry the session's CSRF token, from `GET /api/v1/me`, in the `x-jukecord-csrf` header.
Programs use tokens instead and need no CSRF header.

Twenty failed logins (a wrong token, a used login link) from one address within ten minutes block that address for ten
minutes with `429`, for credentials that do not work: a token, a cookie or a login link that works still gets in from
there. Logging in with Discord waits for the block to end, since only Discord's answer says whether it works.

## Errors

Every error is the same shape, with the HTTP status that matches its code:

```json
{ "error": { "code": "conflict", "message": "nothing is playing" } }
```

| Status | Code           | Means                                                                          |
| -----: | :------------- | :----------------------------------------------------------------------------- |
|    400 | `invalid`      | the request is not valid (a missing field, a playlist name that is taken)      |
|    401 | `unauthorized` | no login, or a token that is not valid                                         |
|    403 | `forbidden`    | not allowed: the DJ role, the token's scope, the host only, no CSRF header     |
|    404 | `not-found`    | no such server, queue item, playlist or token                                  |
|    409 | `conflict`     | not possible now: nothing is playing, the queue is full                        |
|    429 | `too-many`     | too many failed logins from this address                                       |
|    429 | `rate-limited` | changes faster than the rates below; `Retry-After` says when to try again      |
|    503 | `unavailable`  | a part jukecord needs is missing: no bot (browser-only), Discord not answering |
|    503 | `busy`         | jukecord has fallen behind and turns away what can wait; `Retry-After` too     |

### Rates and busy moments

Changes (`POST`, `PUT`, `PATCH`, `DELETE`) are held to ten a second per login and per address, with twenty at once,
and the changes that start fetching a track at once (`skip`, `play-now`, `jump`, `remove-current`) to two a second
with five at once. Reads (`GET`) are held to thirty a second with sixty at once, per login and per address (without
a login, per address). A request over its rate is answered with `429` (`rate-limited`) and `Retry-After` in seconds. While jukecord has fallen behind (its event loop more than 0.2 s late over the last second), audio
and changes are answered with `503` (`busy`) and `Retry-After`, until it has caught up. The host (its command line and
the browsers it logged in with a link) is held to neither rate, and its changes go through while jukecord is behind;
its audio waits like everyone's, as sending audio is the work that can wait.

A request must arrive whole within 30 s, its headers within 15 s; a slower one is answered `408` and its connection
closed. Sending an answer has no time limit while the reader takes it (audio to a slow line takes as long as it takes),
but a connection on which nothing moves either way for two minutes is closed; a WebSocket is not (it is pinged every
30 s). At most 4096 connections are open at once, and 256 from one address (an IPv6 address counts by its /56) unless
`JUKECORD_TRUST_PROXY` says they come through a proxy; one more is closed as it arrives. More than 16 requests sent
on one connection without reading their answers close it.

## Servers

Operations on a server name it in the path: `/guilds/{guild}/...`, where `{guild}` is the Discord server's ID (turn on
Developer Mode in Discord, then right-click the server: Copy Server ID). `GET /api/v1/guilds` lists the servers a login
can use. Without a bot, jukecord has one queue of its own, called `local`.

## Operations

Each operation, the request, who may call it, and the same thing on the command line and in Discord. Operations that
change something are `POST`, `PUT`, `PATCH` or `DELETE`; the answer is the new state (the player, the queue, the
playlist) so a program does not need to ask again.

<!-- operations:start -->

### Player

| Operation | Request | Needs | CLI | Discord |
| :-- | :-- | :-- | :-- | :-- |
| `now-playing` What is playing and where | `GET /api/v1/guilds/{guild}/player` | read | `jukecord np` | `/np` |
| `play-now` Play now: what the input finds goes first and the current track is skipped | `POST /api/v1/guilds/{guild}/player/play` | control | `jukecord play` | `/play` |
| `skip` Skip to the next track | `POST /api/v1/guilds/{guild}/player/skip` | control | `jukecord skip` | `/skip` |
| `remove-current` Drop the current track without counting it as played | `POST /api/v1/guilds/{guild}/player/drop` | control | `jukecord drop` | `/drop` |
| `pause` Pause | `POST /api/v1/guilds/{guild}/player/pause` | control | `jukecord pause` | `/pause` |
| `resume` Play on: resume what is paused, or start the queue when nothing plays | `POST /api/v1/guilds/{guild}/player/resume` | control | `jukecord resume` | `/resume` |
| `seek` Go to a place in the current track | `POST /api/v1/guilds/{guild}/player/seek` | control | `jukecord seek` | `/seek` |
| `repeat` Repeat nothing, the current track, or the queue | `PUT /api/v1/guilds/{guild}/player/repeat` | control | `jukecord repeat` | `/repeat` |
| `stop` Stop playing; the queue stays | `POST /api/v1/guilds/{guild}/player/stop` | control | `jukecord stop` | `/stop` |

### Queue

| Operation | Request | Needs | CLI | Discord |
| :-- | :-- | :-- | :-- | :-- |
| `queue` The queue in play order | `GET /api/v1/guilds/{guild}/queue` | read | `jukecord queue` | `/queue` |
| `add` Add what an address or a search finds (all of a playlist); playing starts if nothing was | `POST /api/v1/guilds/{guild}/queue` | control | `jukecord add` | `/add` |
| `clear` Empty the queue | `DELETE /api/v1/guilds/{guild}/queue` | control | `jukecord clear` | `/clear` |
| `remove` Remove a track from the queue | `DELETE /api/v1/guilds/{guild}/queue/{item}` | control | `jukecord remove` | `/remove` |
| `move` Move a queued track to a place (0 is next) | `POST /api/v1/guilds/{guild}/queue/{item}/move` | control | `jukecord move` | `/move` |
| `jump` Play a queued track now (the current one is skipped) | `POST /api/v1/guilds/{guild}/queue/{item}/play` | control | `jukecord jump` | `/jump` |
| `shuffle` Shuffle the queue | `POST /api/v1/guilds/{guild}/queue/shuffle` | control | `jukecord shuffle` | `/shuffle` |
| `dedupe` Remove later copies of tracks queued twice | `POST /api/v1/guilds/{guild}/queue/dedupe` | control | `jukecord dedupe` | `/dedupe` |

### History and statistics

| Operation | Request | Needs | CLI | Discord |
| :-- | :-- | :-- | :-- | :-- |
| `history` Played tracks, newest first | `GET /api/v1/guilds/{guild}/history` | read | `jukecord history` | `/history` |
| `stats` Listening figures: plays per day and hour, most played tracks, who added most | `GET /api/v1/guilds/{guild}/stats` | read | `jukecord stats` | `/stats` |

### Playlists

| Operation | Request | Needs | CLI | Discord |
| :-- | :-- | :-- | :-- | :-- |
| `playlists` Saved playlists | `GET /api/v1/guilds/{guild}/playlists` | read | `jukecord playlists` | `/playlist list` |
| `playlist-save` Save the current track and the queue under a name (replacing a list of that name) | `POST /api/v1/guilds/{guild}/playlists` | control | `jukecord playlist save` | `/playlist save` |
| `playlist-load` Add a saved playlist to the queue | `POST /api/v1/guilds/{guild}/playlists/{name}/load` | control | `jukecord playlist load` | `/playlist load` |
| `playlist-rename` Rename a saved playlist | `PATCH /api/v1/guilds/{guild}/playlists/{name}` | control | `jukecord playlist rename` | `/playlist rename` |
| `playlist-delete` Delete a saved playlist | `DELETE /api/v1/guilds/{guild}/playlists/{name}` | control | `jukecord playlist delete` | `/playlist delete` |

### Voice

| Operation | Request | Needs | CLI | Discord |
| :-- | :-- | :-- | :-- | :-- |
| `voice-channels` The voice channel the bot is in and the ones it could join | `GET /api/v1/guilds/{guild}/voice` | read | `jukecord channels` | `/join` |
| `join` Join a voice channel (your own when none is named) | `PUT /api/v1/guilds/{guild}/voice` | control | `jukecord join` | `/join` |
| `leave` Leave the voice channel; the music goes on in the browsers | `DELETE /api/v1/guilds/{guild}/voice` | control | `jukecord leave` | `/leave` |

### Server

| Operation | Request | Needs | CLI | Discord |
| :-- | :-- | :-- | :-- | :-- |
| `settings` The server's settings and its roles | `GET /api/v1/guilds/{guild}/settings` | read | `jukecord settings` | `/dj show` |
| `dj-role` Set the role that may change the music (null: everyone); needs Manage Server | `PUT /api/v1/guilds/{guild}/settings/dj-role` | admin | `jukecord dj` | `/dj set` |
| `status` The version, the mode and whether Discord is connected | `GET /api/v1/status` | anyone | `jukecord status` | `/version` |

### Your login

| Operation | Request | Needs | CLI | Discord |
| :-- | :-- | :-- | :-- | :-- |
| `me` Who is logged in | `GET /api/v1/me` | read | `jukecord whoami` |  |
| `guilds` The servers you can open and what you may do in each | `GET /api/v1/guilds` | read | `jukecord servers` |  |
| `tokens` Your API tokens (the host sees every token) | `GET /api/v1/tokens` | admin | `jukecord token list` |  |
| `token-create` Make an API token; the secret is shown in this answer only | `POST /api/v1/tokens` | admin | `jukecord token create` |  |
| `token-revoke` Revoke an API token | `DELETE /api/v1/tokens/{id}` | admin | `jukecord token revoke` |  |

### The host

| Operation | Request | Needs | CLI | Discord |
| :-- | :-- | :-- | :-- | :-- |
| `logs` The newest log records, oldest first | `GET /api/v1/logs` | the host | `jukecord logs` |  |
| `login-link` Make a one-time link that logs a browser in as the host (valid for 10 minutes) | `POST /api/v1/login-links` | the host | `jukecord link` |  |
| `backup` Write a copy of the database to the backups folder of the data directory | `POST /api/v1/backups` | the host | `jukecord backup` |  |
| `doctor` Check the parts jukecord needs and show the settings (secrets as set or not set) | `GET /api/v1/doctor` | the host | `jukecord doctor` |  |

<!-- operations:end -->

## Live updates

`GET /api/v1/events` upgrades to a WebSocket. Log in as for any request (a token in the `Authorization` header, or the
panel's cookie; a cookie is accepted from the panel's own pages only). Every message is JSON with `v`, the protocol
version (now `1`), and `type`:

| From jukecord | When                                                                    | Carries                                                                |
| :------------ | :---------------------------------------------------------------------- | :--------------------------------------------------------------------- |
| `hello`       | on connecting                                                           | `serverTime`, `you` (the login's name)                                 |
| `state`       | after `subscribe`                                                       | the server's `player`, `queue`, `voice` and `listeners`                |
| `player`      | every change of the player                                              | `player` (the same shape as `GET .../player`)                          |
| `queue`       | a change of the queue, at most four times a second                      | `queue`: the whole queue as it is now (as `GET .../queue`)             |
| `voice`       | joining or leaving voice                                                | `voice` (as `GET .../voice`)                                           |
| `listeners`   | a browser starts or stops playing along, at most once a second          | `listeners`: `people` (the first twenty) and `count` (every browser)   |
| `pong`        | answer to `ping`                                                        | `t` (yours) and `serverTime`                                           |
| `error`       | a refused `subscribe`                                                   | `code` and `message`                                                   |

Changes made close together come as one `queue` message with the queue as it is after the last of them, so its `version`
can jump by more than one: keep the message with the highest `version`, there is nothing to fetch.

Add `gzip=1` to the address (`/api/v1/events?gzip=1`) when the client can decompress gzip: messages over 2 KiB (a
`queue` or `state` with more than a few tracks) then come as binary frames holding the JSON as gzip, the same bytes for
everyone showing that server. The panel asks for it when the browser has `DecompressionStream`, and handles messages
strictly in the order they arrived, since unpacking one takes a moment. Without `gzip=1` every message is text. jukecord
does not use the WebSocket's own per-message compression.

| To jukecord | Does                                                                            |
| :---------- | :------------------------------------------------------------------------------ |
| `subscribe` | `{"type":"subscribe","guild":"..."}` shows a server (also `?guild=` on the URL) |
| `listening` | `{"type":"listening","on":true}` counts this connection as playing along        |
| `ping`      | `{"type":"ping","t":<your clock>}`, answered with `pong`                        |

jukecord closes a connection for good with `4401` when its login ends (logged out, expired, revoked), `4403` when a
cookie comes from a page that is not the panel's (the panel's address differs from `JUKECORD_PUBLIC_URL`), and `4410`
when the login may no longer open the server it shows. Any other close is worth reconnecting after. `1013` (try again
later) comes at once, with the reason, when a connection would be one too many: jukecord has as many as
`JUKECORD_LIVE_MAX` allows (1000 by default), or ten are open from the same login, or twenty from the same address
(the host's own count in the total only); or the address failed to log in too often. Wait longer before trying again:
the panel waits 15 s, doubling up to a minute. `voice` lists the
channels the connection's own person can see in Discord (the host sees them all); when the bot is in a channel that
person cannot see, `current` has its ID and an empty `name`.

The player is the clock. A snapshot says where the track was (`positionMs`) at server time `at`; while `status` is
`playing`, the place now is `positionMs + (server time now - at)`. Use `pong` to learn the difference between your
clock and the server's: `serverTime - (t + time the pong arrived) / 2`, from the quickest of a few pings.

## Audio

`GET /api/v1/guilds/{guild}/tracks/{track}/audio` sends the audio of a track that server is playing or has queued:
Ogg Opus, or with `?format=mp3` an MP3 copy (made the first time someone asks, for browsers without Opus; two at a
time, `503` past that). Range requests work, so a player can start in the middle. Any other track answers `404`, and
one not prepared yet `409`.

## Health and metrics

| Path       | Answers                                                                                    |
| :--------- | :----------------------------------------------------------------------------------------- |
| `/healthz` | `200 ok` while the process answers                                                         |
| `/readyz`  | `200` when jukecord can serve requests, with whether Discord is connected; `503` otherwise |
| `/metrics` | Prometheus text: players by state, queued tracks, the cache, panel connections, answers    |

These three need no login. `/metrics` answers only a scraper beside jukecord (the same machine, cluster or local
network): a request that came through a reverse proxy (it carries `X-Forwarded-For`) or from a public address gets a
404, so the version and the counts are not given to the internet. A proxy that adds no `X-Forwarded-For` (nginx
without `proxy_set_header`, for one) cannot be told from a scraper beside jukecord; the examples in the installation
guide answer 404 for `/metrics` at the proxy itself.
