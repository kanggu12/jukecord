# Changelog

All notable changes to jukecord are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each release's section here is its release notes.

## [Unreleased]

## [0.1.0] - 2026-11-12

### Added

- One queue per Discord server, kept in a SQLite database: add at the end, next or at a position, remove, move,
  reorder, shuffle (Fisher-Yates), remove duplicates, clear.
- A player per server that is the clock every listener follows: loading, playing, paused and idle, seeking with the
  first seek at once and the rest of a drag merged into the last, a time limit on getting a track ready, and a failed
  track skipped with the reason shown.
- History of played tracks (a skip in the first second is not a listen) and saved playlists.
- After a restart each server comes back with the same track, paused where it was.
- Settings from `JUKECORD_*` environment variables, all problems reported at once, secrets never printed.
- Logs as readable lines on the console and JSON lines in a file that is rotated at a size limit, with secrets masked.
- Adding by address or by search words: YouTube, SoundCloud and every other site yt-dlp supports; a playlist page
  adds its tracks (private, deleted and live entries left out); a video address with a playlist in it adds that video.
  Every spelling of one YouTube video is one track, and an address seen before is added without asking the site.
- A media cache with a size limit: each track is downloaded and encoded once (Opus, loudness evened out to -14 LUFS),
  its real length read from the file, the least recently used tracks removed first, the playing and next tracks never.
- The next tracks are fetched while the current one plays, one at a time, and a fetch the queue no longer needs stops.
  The player and the prefetcher share one download of the same track.
- An MP3 copy of a track is made for browsers that cannot play Opus (Safari), the first time one asks.
- A container image for linux/amd64 and linux/arm64 on Node 26 LTS and Debian 13 (ffmpeg 7.1), pinned by digest,
  with the official yt-dlp build checked against its published checksum. yt-dlp runs YouTube's scripts with the
  image's Node; no Python or Deno in the image.
- The Discord bot: slash commands for every action, with Korean names and descriptions (Discord shows each person
  their own language), answers as short cards with pause and skip buttons, and playlist names suggested as you type.
  It asks Discord only for the Guilds and GuildVoiceStates intents. Without a token jukecord runs browser-only.
- Voice: the cached Opus file is sent as it is (no encoder needed), a seek or a late join starts through ffmpeg from
  that place, voice is end-to-end encrypted (DAVE), and a dropped connection that recovers within 5 s is kept.
- Every action (add, play now, skip, pause, seek, queue edits, playlists, join, leave, status) lives in one place that
  the bot, the panel, the API and the CLI all call; a server's DJ role, when set, decides who may change the music.
- Repeat: off, this track (played again without fetching it again) or the queue (a finished track goes back to the
  end). The mode is kept across restarts.
- Download progress while a track loads, reported at most four times a second.
- Limits: tracks longer than `JUKECORD_TRACK_MAX` (3 hours) are left out and a server's queue holds at most
  `JUKECORD_QUEUE_MAX` (1000) tracks; the answer says how many were left out and why.
- A download that fails in a way that looks passing (a 5xx answer, a timeout, a reset connection) is tried once more
  after 2 s.
- When YouTube asks the server to sign in to prove it is not a bot, the error says so and how to give jukecord a
  cookies file (`JUKECORD_YTDLP_COOKIES`); yt-dlp works on a private copy, so the file can be mounted read-only.
- Secrets can come from files (`JUKECORD_DISCORD_TOKEN_FILE`, `JUKECORD_DISCORD_CLIENT_SECRET_FILE`), the way Docker
  and Kubernetes mount them.
- The bot joins your voice channel when you play something from Discord and it is not in one, and leaves a channel
  nobody is in after `JUKECORD_VOICE_IDLE` (5 minutes); the music goes on for the browsers.
- Slash commands are registered only when they change (Discord allows 200 registrations per server a day), and the
  "listening to" line under the bot's name changes at most every 15 s.
- The history keeps the newest 10,000 plays of each server.
- An error nothing handled is logged with its stack, and stopping gets 10 s before the process exits anyway.
- The HTTP API under `/api/v1`: every action and the operations of a login (who am I, servers, tokens, logs, login
  links, backups, the self-check), described in an OpenAPI 3.1 document at `/api/v1/openapi.json`. Errors are
  `{"error":{"code","message"}}` with the matching status.
- Live updates over WebSocket (`/api/v1/events`): a server's whole state on subscribe, then every change in the
  order it happened, who is listening in a browser, and a clock exchange so browsers play the same second.
- The audio of the playing track for browsers, with Range requests, and an MP3 copy for browsers without Opus.
- Logging in to the panel with Discord (OAuth2 with the identify scope only; membership and roles are asked through
  the bot), and one-time login links for the host (`jukecord link`). API tokens with read, control or admin scope.
- The `jukecord` command: a command for every API operation, the host token found in the data directory, 1-based
  queue numbers as people see them, `--json` for scripts, and exit codes 0, 1 (refused), 2 (typing) and 3 (no answer).
- Listening statistics: plays per day and per hour in your time zone, the most played tracks, who added most, and
  the time listened (`/stats` in Discord, the stats operation in the API and the CLI).
- The DJ role can be set from Discord (`/dj set`), the API and the CLI by people who can manage the server.
- `jukecord doctor` checks the data directory, the database, ffmpeg, yt-dlp (and whether a newer one is out), the
  cache, Discord and the login; `jukecord backup` writes a copy of the database; `jukecord logs` reads the log.
- `/healthz`, `/readyz` and `/metrics` (Prometheus text) for containers and monitoring.
- `JUKECORD_TRUST_PROXY` for running behind a reverse proxy or an Ingress.
- yt-dlp keeps what it learns between runs (YouTube's player code) in the data directory instead of fetching it for
  every lookup.
- A voice stream that breaks partway is started again where the track is (twice at most), and the track ends by the
  clock; three tracks in a row that cannot be got stop the player and leave the rest of the queue. A track that fails
  shows a short reason ("the video is unavailable"); the full text is in the log.
- Refusals in Discord are in the person's language, a confirmation says what was done, and commands that only look
  something up (the queue, the version, the DJ role, the playlists) answer the person alone.
- The `jukecord` command checks what was typed before it connects, takes `--version` and `-h`, names an unknown
  option, and `doctor` exits 1 when a check fails.
- Play a queued track now (`/jump`, the panel's play key on a row, `jukecord jump`), and the play key starts the queue
  again after a stop (`/resume`).
- The panel: the track playing on a disc that turns while it plays (the rainbow rim means "playing now"; white when
  paused), a progress bar to click or drag, the queue with covers and who added each track, dragging to reorder,
  search, playlists, the voice channel with who listens in browsers, recently played with "add again", in light and
  dark, in English and Korean, from phones to 4K screens.
- Listening in the browser: a bar at the bottom plays the track in time with the voice channel (within 300 ms), with
  its own volume, the system's media keys and lock screen, and MP3 for browsers without Opus.
- Statistics: plays per day and per hour, the most played tracks and who added most, over 7, 30 or 90 days or a year,
  each chart with a table view.
- The log page for the host, the login page, the menu (theme, language, motion, the DJ role, API tokens), keyboard
  shortcuts (Space, the arrows, N, /, ?).
- The mark: a jukebox's arch, lit in the colours of "playing now", with a record under it.
- `./jukecord`, the front door: up, open (a login link, opened in the browser), status, logs, doctor, update, backup,
  restore, down, and every `jukecord` command.
- `compose.yaml` at the top of the repository: the panel on 127.0.0.1, a read-only container without privileges, the
  data in a named volume.
- The Helm chart (`deploy/helm/jukecord`): one pod with the Recreate strategy, a volume kept on uninstall, a Secret or
  your own, an optional Ingress, a NetworkPolicy (in: the panel's port; out: DNS and the internet, not the cluster's
  private networks), three probes, a non-root read-only pod, a values schema and `helm test`; checked on a kind
  cluster by `deploy/kind/check.sh`.
- An optional systemd unit that starts the Compose project with the machine.
- Documents: the user guide, installing, Kubernetes, the API (its operations table made from the API itself),
  architecture, decisions, testing, troubleshooting, running offline, third-party notices.

### Security

- Logins, API tokens and login links are 32 random bytes; only their SHA-256 hashes are stored, so a copy of the
  database logs nobody in. The host token is a file only jukecord's user can read.
- A change made from the panel must carry the session's CSRF token; the session cookie is httpOnly and SameSite=Lax,
  and Secure when the public address is https. WebSocket connections with a cookie are accepted from the panel's own
  origin only.
- Twenty failed logins from one address within ten minutes block that address for a while. An IPv6 address counts
  by its /56, each address keeps only its latest twenty failures, and at most 10,000 addresses are remembered, the
  oldest forgotten first, so neither one address nor many can make the list long or every request slow. The audio,
  the live updates and logging out are refused to a blocked address too.
- Addresses on private networks (this machine, the home network, other containers and pods) are not fetched. Every
  connection yt-dlp makes goes through a proxy inside jukecord that connects only to public addresses, so redirects,
  a playlist's entries and names that change their answer are held to the same rule. `JUKECORD_ALLOW_PRIVATE_ADDRESSES`
  allows them, for a media server on the local network.
- At most four lookups (two per person) and two MP3 copies run at once; another is refused with "try again in a
  moment" instead of starting more processes than a small server has memory for. Names are asked of DNS directly with
  a time limit, so a name that never answers cannot hold up the panel's files.
- A browser gets the audio of a track only when a server it can open is playing it or has it queued.
- The panel lists only the voice channels a person can see in Discord (and does not name the bot's channel to those
  who cannot see it), and the bot joins a chosen channel only for someone who may go there themselves.
- After logging in with Discord, only a page of the panel itself can come next.
- Live updates end with their login: logging out closes that browser's connection at once, an expired session or a
  revoked token is noticed within 30 s, and someone no longer in the server within about a minute and a half.
- Pages carry a content security policy (scripts and styles from jukecord only), and nothing may frame them.
- Everything jukecord writes (the database, the cache, the logs) is readable by its own user only, and a database
  copied in with a looser mode (a restore, a move) is made so again when jukecord opens it.

[Unreleased]: https://github.com/kanggu12/jukecord/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kanggu12/jukecord/releases/tag/v0.1.0
