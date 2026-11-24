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

**The panel** logs in with a cookie: from Discord, the host's identity provider (SSO), a directory account, or a
one-time link from `jukecord link` ([the browser's logins](#the-browsers-logins)). A cookie alone changes nothing: every
change must also carry the session's CSRF token, from `GET /api/v1/me`, in the `x-jukecord-csrf` header. Programs use
tokens instead and need no CSRF header.

**Members** logged in through the host's identity provider or directory, and their groups gave them a level at that
login: `admin` may do what the host may, `control` changes the music in every server, `read` looks and listens.
`GET /api/v1/me` says `kind: "member"` and, in `member`, where they logged in (`oidc` or `ldap`) and their level. A
member makes no API tokens; an admin member lists and revokes everyone's, as the host does.

Twenty failed logins (a wrong token, a used login link, a wrong directory password) from one address block that address
for ten minutes, counted from the first, with `429`, for credentials that do not work: a token, a cookie or a login link
that works still gets in from there. A directory login's failures count against the name typed as well. Logging in
with Discord or SSO waits for the block to end, since only the provider's answer says whether it works.

### The browser's logins

These are the panel's own pages, outside `/api/v1` and the OpenAPI document:

| Request                        | Does                                                                                          |
| :----------------------------- | :-------------------------------------------------------------------------------------------- |
| `GET /auth/login?next=/`       | to Discord, and back at `/auth/callback`                                                      |
| `GET /auth/sso?next=/`         | to the host's identity provider (OIDC, with PKCE), and back at `/auth/sso/callback`           |
| `POST /auth/directory`         | a directory account: `{"username", "password", "next"}` as JSON, from the panel's own pages   |
| `GET /auth/link/{code}`        | a one-time login link from `jukecord link`                                                    |
| `POST /auth/listen`            | a listening link's code, `{"code"}`, from the panel's own pages: a guest of that link         |
| `POST /auth/logout`            | ends the session; `{"next"}` for a login through SSO, the provider's logout to go to          |

A refused Discord or SSO login comes back to `/login?error=<code>`, which the login page puts in words. The directory
form's answers are JSON: `{"ok": true, "next"}` with the session's cookie, or an error of the usual shape:

| Status | Code               | Means                                                       |
| -----: | :----------------- | :---------------------------------------------------------- |
|    400 | `invalid`          | no name, or no password                                     |
|    401 | `wrong-password`   | the name or the password is wrong                           |
|    403 | `password-expired` | the password has expired, or must be changed first          |
|    403 | `account-disabled` | the account is turned off or locked                         |
|    403 | `no-group`         | the account is in none of the groups jukecord lets in       |
|    409 | `ambiguous`        | the directory has more than one account by that name        |
|    429 | `too-many`         | too many failed logins from this address or for this name   |
|    503 | `directory-down`   | the directory did not answer                                |

`GET /api/v1/auth/methods` says which ways are set up, and the words of their keys: `{"discord": true, "sso": {"label":
"Log in with Home SSO"}, "directory": {"label": null}}`, with `null` for a way that is not set up.

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
|    503 | `unavailable`  | a part jukecord needs is missing: no bot (browser-only), a feature turned off  |
|    503 | `unavailable`  | a moment's trouble: lookups all taken, Discord or LRCLIB silent; `Retry-After` |
|    503 | `busy`         | jukecord has fallen behind and turns away what can wait; `Retry-After` too     |

### Rates and busy moments

Changes (`POST`, `PUT`, `PATCH`, `DELETE`) are held to ten a second per login and per address, with twenty at once,
and the changes that start fetching a track at once (`skip`, `play-now`, `jump`, `remove-current`) to two a second
with five at once; a change refused before it did anything gives its address's share back, one refused after a
lookup (a search that found nothing) does not. Reads (`GET`) are held to thirty a second with sixty at once, per person
(every login and token of one Discord user together), or per address without a login. A request over its rate is answered with `429` (`rate-limited`) and `Retry-After` in seconds. While jukecord has fallen behind (its event loop more than 0.2 s late over the last second), audio
and changes are answered with `503` (`busy`) and `Retry-After`, until it has caught up. The host (its command line and
the browsers it logged in with a link) is held to neither rate, and its changes go through while jukecord is behind;
its audio waits like everyone's, as sending audio is the work that can wait.

`search`, which starts yt-dlp, is held to a rate of its own as well: one a second with five at once, counted as reads
are (per person, or per address without a login), the host apart.

Bodies are at most 64 KiB, but for `playlist-import`, which takes a file of up to 1 MiB.

A request must arrive whole within 30 s, its headers within 15 s; a slower one is answered `408` and its connection
closed. Sending an answer has no time limit while the reader takes it (audio to a slow line takes as long as it takes),
but a connection on which nothing moves either way for two minutes is closed; a WebSocket is not (it is pinged every
30 s). At most 4096 connections are open at once, 256 from one address (an IPv6 address counts by its /56), or 3840
from one address when `JUKECORD_TRUST_PROXY` says they come through a proxy; one more is closed as it arrives, and the
log says so once a minute. Requests sent one after another on one connection without waiting for the answers
(pipelining) are answered in order, sixteen made at a time and the rest waiting their turn; past 128 waiting, the
others are answered `429` at once.

## Servers

Operations on a server name it in the path: `/guilds/{guild}/...`, where `{guild}` is the Discord server's ID (turn on
Developer Mode in Discord, then right-click the server: Copy Server ID). `GET /api/v1/guilds` lists the servers a login
can use. Without a bot, jukecord has one queue of its own, called `local`.

`GET /api/v1/status`, which anyone may ask, says the version, whether Discord is connected, the mode (`discord` or
`browser-only`), how long jukecord has run, whether Discord login and lyrics are on, and `database`: `sqlite`,
`postgres`, `mysql` or `mariadb`.

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
| `skip` Skip to the next track; without the DJ role where votes are on, a vote (the answer says how it stands) | `POST /api/v1/guilds/{guild}/player/skip` | control | `jukecord skip` | `/skip` |
| `remove-current` Drop the current track without counting it as played | `POST /api/v1/guilds/{guild}/player/drop` | control | `jukecord drop` | `/drop` |
| `pause` Pause | `POST /api/v1/guilds/{guild}/player/pause` | control | `jukecord pause` | `/pause` |
| `resume` Play on: resume what is paused, or start the queue when nothing plays | `POST /api/v1/guilds/{guild}/player/resume` | control | `jukecord resume` | `/resume` |
| `seek` Go to a place in the current track | `POST /api/v1/guilds/{guild}/player/seek` | control | `jukecord seek` | `/seek` |
| `repeat` Repeat nothing, the current track, or the queue | `PUT /api/v1/guilds/{guild}/player/repeat` | control | `jukecord repeat` | `/repeat` |
| `stop` Stop playing; the queue stays | `POST /api/v1/guilds/{guild}/player/stop` | control | `jukecord stop` | `/stop` |
| `lyrics` The lyrics of the track playing, timed when they can be (from LRCLIB, kept once found) | `GET /api/v1/guilds/{guild}/lyrics` | read | `jukecord lyrics` | `/lyrics` |
| `stop-after` Stop when the current track ends (on), or play on after it (off); the queue stays | `PUT /api/v1/guilds/{guild}/player/stop-after` | control | `jukecord stop-after` | `/stop` |
| `autoplay` When the queue runs out: nothing, a track from past plays, or one related to the last track | `PUT /api/v1/guilds/{guild}/player/autoplay` | control | `jukecord autoplay` | `/autoplay` |

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
| `turns-now` Put the queue in turns once: each person's next track in turn | `POST /api/v1/guilds/{guild}/queue/turns` | control | `jukecord turns now` | `/turns now` |
| `search` What YouTube finds for some words, to pick from before adding | `GET /api/v1/guilds/{guild}/search` | control | `jukecord search` | `/play` |

### History and statistics

| Operation | Request | Needs | CLI | Discord |
| :-- | :-- | :-- | :-- | :-- |
| `history` Played tracks, newest first | `GET /api/v1/guilds/{guild}/history` | read | `jukecord history` | `/history` |
| `stats` Listening figures: plays per day and hour, most played tracks, whose picks played most | `GET /api/v1/guilds/{guild}/stats` | read | `jukecord stats` | `/stats` |
| `wrapped` The server's year (or a month, or the last 12 months) in music: totals, top five tracks and people, moments | `GET /api/v1/guilds/{guild}/wrapped` | read | `jukecord wrapped` | `/wrapped` |
| `likes` The tracks you liked, newest first | `GET /api/v1/guilds/{guild}/likes` | read | `jukecord likes` | `/likes show` |
| `like` Like a track this server is playing, has queued or played (the DJ role is not needed) | `PUT /api/v1/guilds/{guild}/likes/{track}` | control | `jukecord like` | `/like` |
| `unlike` Take a like back | `DELETE /api/v1/guilds/{guild}/likes/{track}` | control | `jukecord unlike` | `/likes remove` |
| `likes-add` Add every track you liked to the queue, newest first | `POST /api/v1/guilds/{guild}/likes/queue` | control | `jukecord likes add` | `/likes add` |

### Playlists

| Operation | Request | Needs | CLI | Discord |
| :-- | :-- | :-- | :-- | :-- |
| `playlists` Saved playlists | `GET /api/v1/guilds/{guild}/playlists` | read | `jukecord playlists` | `/playlist list` |
| `playlist-save` Save the current track and the queue under a name (replacing a list of that name) | `POST /api/v1/guilds/{guild}/playlists` | control | `jukecord playlist save` | `/playlist save` |
| `playlist-load` Add a saved playlist to the queue | `POST /api/v1/guilds/{guild}/playlists/{name}/load` | control | `jukecord playlist load` | `/playlist load` |
| `playlist-rename` Rename a saved playlist | `PATCH /api/v1/guilds/{guild}/playlists/{name}` | control | `jukecord playlist rename` | `/playlist rename` |
| `playlist-delete` Delete a saved playlist | `DELETE /api/v1/guilds/{guild}/playlists/{name}` | control | `jukecord playlist delete` | `/playlist delete` |
| `playlist-export` A saved playlist as a file: addresses (text), M3U, or jukecord's JSON | `GET /api/v1/guilds/{guild}/playlists/{name}/export` | read | `jukecord playlist export` | `/playlist export` |
| `playlist-import` Make a playlist from a file (addresses, M3U or jukecord JSON) or a pasted list, under a new name | `POST /api/v1/guilds/{guild}/playlists/import` | control | `jukecord playlist import` | `/playlist import` |

### Voice

| Operation | Request | Needs | CLI | Discord |
| :-- | :-- | :-- | :-- | :-- |
| `voice-channels` The voice channel the bot is in and the ones it could join | `GET /api/v1/guilds/{guild}/voice` | read | `jukecord channels` | `/join` |
| `join` Join a voice channel (your own when none is named) | `PUT /api/v1/guilds/{guild}/voice` | control | `jukecord join` | `/join` |
| `leave` Leave the voice channel; the music goes on in the browsers | `DELETE /api/v1/guilds/{guild}/voice` | control | `jukecord leave` | `/leave` |
| `volume` The voice channel's volume, 0 to 200 percent (each browser keeps its own) | `PUT /api/v1/guilds/{guild}/voice/volume` | control | `jukecord volume` | `/volume` |
| `sound` The voice channel's sound preset; browsers listening along apply it too | `PUT /api/v1/guilds/{guild}/voice/sound` | control | `jukecord sound` | `/sound` |

### Server

| Operation | Request | Needs | CLI | Discord |
| :-- | :-- | :-- | :-- | :-- |
| `settings` The server's settings and its roles | `GET /api/v1/guilds/{guild}/settings` | read | `jukecord settings` | `/dj show` |
| `dj-role` Set the role that may change the music (null: everyone); needs Manage Server | `PUT /api/v1/guilds/{guild}/settings/dj-role` | admin | `jukecord dj` | `/dj set` |
| `status` The version, the mode and whether Discord is connected | `GET /api/v1/status` | anyone | `jukecord status` | `/version` |
| `alerts-channel` Set the text channel where jukecord tells this server about trouble (null: nowhere); needs Manage Server | `PUT /api/v1/guilds/{guild}/settings/alerts-channel` | admin | `jukecord alerts` | `/alerts set` |
| `listen-links` The server's listening links that still work: yours, or all of them with Manage Server | `GET /api/v1/guilds/{guild}/listen-links` | control | `jukecord shares` | `/share list` |
| `listen-link-create` Make a link that lets guests without a Discord account listen along (1, 7 or 30 days); shown once | `POST /api/v1/guilds/{guild}/listen-links` | control | `jukecord share` | `/share create` |
| `listen-link-revoke` Revoke a listening link: its guests are out at once (its maker, or Manage Server) | `DELETE /api/v1/guilds/{guild}/listen-links/{id}` | control | `jukecord unshare` | `/share revoke` |
| `stay` Stay in voice when everyone has left (off: leave after the host's time alone); needs Manage Server | `PUT /api/v1/guilds/{guild}/settings/stay` | admin | `jukecord stay` | `/stay` |
| `vote-skip` Whether Skip from someone without the DJ role is a vote (on) or refused (off); needs Manage Server | `PUT /api/v1/guilds/{guild}/settings/vote-skip` | admin | `jukecord voteskip` | `/voteskip` |
| `take-turns` Take turns: the queue plays one track from each person in turn; needs Manage Server | `PUT /api/v1/guilds/{guild}/settings/take-turns` | admin | `jukecord turns` | `/turns set` |
| `person-limit` How many tracks each person may have queued (0: no limit); needs Manage Server | `PUT /api/v1/guilds/{guild}/settings/person-limit` | admin | `jukecord limit` | `/limit` |

### Your login

| Operation | Request | Needs | CLI | Discord |
| :-- | :-- | :-- | :-- | :-- |
| `me` Who is logged in | `GET /api/v1/me` | read | `jukecord whoami` |  |
| `guilds` The servers you can open and what you may do in each | `GET /api/v1/guilds` | read | `jukecord servers` |  |
| `tokens` Your API tokens (the host sees every token) | `GET /api/v1/tokens` | admin | `jukecord token list` |  |
| `token-create` Make an API token; the secret is shown in this answer only | `POST /api/v1/tokens` | admin | `jukecord token create` |  |
| `token-revoke` Revoke an API token | `DELETE /api/v1/tokens/{id}` | admin | `jukecord token revoke` |  |
| `auth-methods` The ways of logging in that are set up here (what the login page shows) | `GET /api/v1/auth/methods` | anyone | `jukecord auth methods` |  |

### The host

| Operation | Request | Needs | CLI | Discord |
| :-- | :-- | :-- | :-- | :-- |
| `logs` The newest log records, oldest first | `GET /api/v1/logs` | the host | `jukecord logs` |  |
| `login-link` Make a one-time link that logs a browser in (valid for 10 minutes): as the host, or as a friend who may only look (read) or also change the music (control) | `POST /api/v1/login-links` | the host | `jukecord link` |  |
| `backup` Write a copy of the database to the backups folder of the data directory | `POST /api/v1/backups` | the host | `jukecord backup` |  |
| `doctor` Check the parts jukecord needs and show the settings (secrets as set or not set) | `GET /api/v1/doctor` | the host | `jukecord doctor` |  |
| `auth-test-oidc` Test logging in through the identity provider (OIDC) without logging anyone in: its document, its keys, the client and its secret; with settings not saved yet, or the ones in use | `POST /api/v1/auth/test-oidc` | the host | `jukecord auth test-oidc` |  |
| `auth-test-ldap` Test logging in with a directory account (LDAP) without logging anyone in: the connection, the service account, the base DN, and with a name the person, their groups and their level (no password) | `POST /api/v1/auth/test-ldap` | the host | `jukecord auth test-ldap` |  |

<!-- operations:end -->

`auth-test-oidc` and `auth-test-ldap` check the logins' settings and log nobody in. `{"settings": {...}}` tests values
not saved yet, by their environment names (`JUKECORD_OIDC_ISSUER`, `JUKECORD_LDAP_URL` ...), in place of the ones in
use; a secret left out is the one in use, and a file's setting (a `_FILE`, `JUKECORD_LDAP_CA_FILE`) is refused.
`auth-test-ldap` also takes `"username"`, a person to look up. The answer is `ok` with each check's `name`, `status`
(`ok`, `warn`, `fail`) and `detail`, and for a person their `groups` and the `level` they would log in at.

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
(the host's own count in the total only); or the address failed to log in too often. The connections holding the
places are pinged then, and the ones that do not answer within 15 s are closed. Wait longer before trying again:
the panel waits 15 s, doubling up to a minute. `voice` lists the
channels the connection's own person can see in Discord (the host sees them all); when the bot is in a channel that
person cannot see, `current` has its ID and an empty `name`.

The player is the clock. A snapshot says where the track was (`positionMs`) at server time `at`; while `status` is
`playing`, the place now is `positionMs + (server time now - at)`. Use `pong` to learn the difference between your
clock and the server's: `serverTime - (t + time the pong arrived) / 2`, from the quickest of a few pings.

## Audio

`GET /api/v1/guilds/{guild}/tracks/{track}/audio` sends the audio of a track that server is playing or has queued:
Ogg Opus, or with `?format=mp3` an MP3 copy (made the first time someone asks, for browsers without Opus; two at a
time, `503` past that). A request waits up to 5 s for its copy; a longer one (a long track) answers `503` with
`Retry-After` while the copy goes on, and the same address sends it once it is made. Range requests work, so a player
can start in the middle. Any other track answers `404`, and one not prepared yet `409`.

## Covers

`GET /api/v1/guilds/{guild}/tracks/{track}/cover` sends a track's cover, for a track that server shows: playing,
queued, in its history or in one of its playlists (any other answers `404`). jukecord fetches each cover once, from the
address the site gave, by the same rule as everything it fetches (public addresses only, redirects checked again), at
most 2 MiB within ten seconds, and keeps it only when its own bytes say it is a JPEG, PNG, GIF, WebP or AVIF picture.
It is kept in the media cache beside the track's audio, counts towards `JUKECORD_CACHE_MAX`, and is sent from there
with a day's caching and an ETag. A track without a picture, or whose picture cannot be had, answers `404` (and is not
asked of the site again for an hour). Covers that must be fetched first are held to ten a second per login and per
address (sixty at once; the host is not held), and are not fetched while jukecord is behind (`503`); four are fetched
at once, and past a line of 32 waiting the answer is `503` too.

`GET /api/v1/guilds/{guild}/search/cover?url=<address>` sends the picture of a search's result before it is added, the
same way: `url` is a result's `url`, from a search made in the last half hour (any other address answers `404`), for
people who may search. It is kept under the same key as the track the result becomes, so adding it fetches nothing
more. The panel's add field shows its results' pictures from here, so a browser asks no image host at all.

## Health and metrics

| Path       | Answers                                                                                       |
| :--------- | :-------------------------------------------------------------------------------------------- |
| `/healthz` | `200 ok` while the process answers                                                            |
| `/readyz`  | `200` when jukecord can serve requests, `503` when it cannot; each part's state as JSON       |
| `/metrics` | Prometheus's text format, or OpenMetrics when asked for it                                    |

None of the three needs a login. In a split into services, the core's own port answers the three as well, and nothing
else.

### Readiness

`/readyz` answers with each part jukecord checks, its state (`ok`, `down`, `connecting` or `unknown`, before anything
has run) and whether jukecord cannot serve without it:

```json
{
  "ready": false,
  "discord": true,
  "parts": {
    "database": { "state": "down", "required": true, "kind": "postgres" },
    "bus": { "state": "ok", "required": true, "kind": "redis" },
    "cache": { "state": "ok", "required": true, "kind": "redis" },
    "discord": { "state": "ok", "required": false },
    "ffmpeg": { "state": "ok", "required": false },
    "yt-dlp": { "state": "ok", "required": false }
  }
}
```

- The required parts are the database (answering, at this jukecord's schema), the bus (`in-process`, or `redis`
  answering a ping) and the shared cache (`memory` or `redis`); an edge of a split has `core` too, its heartbeat heard
  lately. Discord (with a bot) and the media programs are reported without deciding it.
- `discord` is whether the bot is connected, as before the parts.
- The answer is kept for a second, and a part that has not answered within two seconds is down. It names states and
  kinds only, never an address or an error.

### Metrics

`/metrics` answers only a scraper beside jukecord (the same machine, cluster or private network) that asks directly: a
request that came through a reverse proxy (it carries `X-Forwarded-For` or `Forwarded`) or from a public address gets a
404, so the version and the counts are not given to the internet. With `JUKECORD_METRICS_TOKEN` set, a request with
`Authorization: Bearer <token>` is let in from anywhere; a wrong token gets `401` with `WWW-Authenticate: Bearer`, and a
request without one falls back to the address rule. A proxy that adds no `X-Forwarded-For` (nginx without
`proxy_set_header`, for one) cannot be told from a scraper beside jukecord; the examples in the installation guide answer
404 for `/metrics` at the proxy itself.

`Accept: application/openmetrics-text` gets OpenMetrics 1.0.0. Every series carries the labels Prometheus gives a
target, and these families besides:

| Families                                                                                                                   | What they count                                                                    |
| :------------------------------------------------------------------------------------------------------------------------ | :--------------------------------------------------------------------------------- |
| `jukecord_info{version,role,database,bus,cache}`, `jukecord_ready`, `jukecord_part_up{part}`                               | what runs, and whether it can serve                                                |
| `jukecord_players{status}`, `jukecord_queue_tracks`, `jukecord_queue_longest_tracks`, `jukecord_browser_listeners`         | the music                                                                          |
| `jukecord_fetches_total{outcome}`, `jukecord_fetch_failures_total{reason}`, `jukecord_fetch_duration_seconds`, `jukecord_fetch_jobs` | getting tracks                                                          |
| `jukecord_cache_bytes`, `_tracks`, `_covers`, `_limit_bytes`, `_lookups_total`, `_evictions_total`                         | the media cache                                                                    |
| `jukecord_media_tool_runs_total{tool,task,outcome}`, `jukecord_media_tool_duration_seconds`, `jukecord_media_tools_running` | yt-dlp and FFmpeg                                                                  |
| `jukecord_http_request_duration_seconds{method,route,class}`, `jukecord_http_responses_total{class}`                       | the HTTP answers                                                                   |
| `jukecord_panel_connections`, `jukecord_panel_messages_total{frame}`, `jukecord_panel_sent_bytes_total`                     | the live updates                                                                   |
| `jukecord_database_query_duration_seconds{operation}`, `_query_errors_total`, `_connections{state}`, `_waiting_queries`    | the database                                                                       |
| `jukecord_shared_cache_lookups_total{result}`, `_errors_total`, `_entries`                                                 | the shared cache                                                                   |
| `jukecord_logins_total{method,outcome}`                                                                                    | logins, by way (discord, link, listen, oidc, ldap)                                 |
| `jukecord_discord_connected`, `_gateway_state{state}`, `_gateway_latency_seconds`, `_guilds`, `jukecord_voice_connections{state}` | Discord and voice                                                           |
| `jukecord_bus_commands_total{command,outcome}`, `_command_duration_seconds`, `_commands_served_total`, `_events_total`, `jukecord_edges` | a split: an edge's commands to the core, the core's answers, the edges it hears |
| `jukecord_disk_free_bytes`, `jukecord_disk_size_bytes`, `jukecord_event_loop_behind_seconds_total`                         | the disk under the data folder, and time spent behind                              |
| `process_*`, `nodejs_*`                                                                                                    | the process and Node.js, with the event loop's delay over the last second          |

`jukecord_event_loop_delay_seconds` is the same as `nodejs_eventloop_lag_p99_seconds`, kept under its 0.3 name until
0.5.
