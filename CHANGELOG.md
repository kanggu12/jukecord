# Changelog

All notable changes to jukecord are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each release's section here is its release notes.

## [Unreleased]

### Changed

- The image is half the size: 423 MB instead of 843 MB on disk, 145 MiB instead of 290 MiB to download (gzip). FFmpeg
  7.1.5 is built in it for what jukecord does (every format FFmpeg reads on its own, https, Opus and MP3 out) instead
  of Debian's package with the libraries of every codec and device; it reads, measures and writes as before (sixteen
  kinds of file compared, the same lengths and loudness).
- The panel's first visit fetches about 300 KiB instead of 2.1 MiB: the font comes in pieces by character range
  (Pretendard's own dynamic subset), and the scripts and styles are sent compressed, made so once by the build.
- Live updates go compressed to browsers: a queue of a thousand tracks is about 60 KiB on the wire instead of
  330 KiB, sent to every listener whenever the queue changes.
- Browsers keep the font's pieces for a year (their names carry a hash of their content), so a page asks for none of
  them again.
- Tracks fetched ahead of time take turns across every server: at most half the processors' worth at once (2 to 6),
  after any track somebody is waiting for, which always starts at once. A few servers fetching ahead can no longer take
  a small machine over and hold up the track someone wants now.
- One server can have at most three of the four lookups at a time, so a busy server leaves room for another.

### Fixed

- A track whose file cannot be read as it arrives (an MP4 with its index at the end, as some sites serve it) is
  fetched whole and plays, instead of failing as "the downloaded audio is empty".
- Accessibility: the logo link has a name on phones, each page has one main landmark and one level-one heading, the
  menu's sheet is a valid dialog, the log can be scrolled from the keyboard, and the player's heading is not read out
  empty before the first state. The panel walk runs axe-core on the pages it photographs and fails on any rule broken.
- A server that removes the bot: its player stops (nothing more is fetched for it), the bot leaves its voice channel,
  and the commands are registered again if the server adds the bot back; before, a remembered fingerprint skipped them.
- A part that fails while hearing about a change (a panel's message, a card) no longer keeps the others from hearing
  it, nor takes the process down with every server's music when the change came from a player's timer.
- Audio files keep their day-long browser cache; the panel files' "no-cache" had replaced it.
- A track fetched whole after the stream could not be read: a time limit or a cancel says so, the download shows its
  progress, a file over 512 MB is not fetched, and what yt-dlp leaves beside the file is removed.

## [0.1.0] - 2026-11-12

The first release.

### Added

- A Discord music bot with one queue and one player for each server: add by address or search words from YouTube,
  SoundCloud and the other sites yt-dlp reads (a playlist page adds its tracks), play now or next, skip, seek, pause,
  repeat a track or the queue, reorder, shuffle, remove duplicates, saved playlists and the history. After a restart
  each server comes back paused where it was.
- Listening in the browser: **Listen here** plays the same file in step with the voice channel (within 0.3 s of the
  player's clock), at its own volume, with the media keys and the lock screen. Safari gets an MP3 copy.
- Tracks fetched once and kept as Opus with their loudness evened out, in a cache with a size limit. The next tracks
  are fetched while one plays, and the voice channel gets the cached file as it is. A voice stream that breaks starts
  again where the track is; three tracks in a row that cannot be got stop the player and go back to the front of the
  queue, with a short reason shown.
- Four ways in, with the same actions and rules: slash commands in English and Korean, answered with cards and
  buttons; the web panel; the `jukecord` command, with `--json` for scripts; and an HTTP API described by OpenAPI 3.1,
  with live updates over WebSocket.
- Logging in with Discord (the identify scope only), one-time links for the host, API tokens with read, control or
  admin scope, and a DJ role for each server.
- The panel in light and dark, in English and Korean, from phones to 4K screens: the player on a turning disc, the
  queue, the voice channel and who listens in browsers, recently played, statistics over a week up to a year with a
  table view for each chart, the log page and keyboard shortcuts.
- Running it: `./jukecord` with Docker Compose (up, open, status, logs, doctor, update, backup, restore, down); an
  image for amd64 and arm64 on Node 26 and Debian 13; a Helm chart with a NetworkPolicy, three probes, a read-only
  non-root pod and `helm test`; an optional systemd unit; `/healthz`, `/readyz` and `/metrics`.
- Settings from `JUKECORD_*` variables, secrets also from files, every problem reported at once. Logs on the console
  and in a rotated JSON file, with secrets masked.
- Guides: using it, installing, Kubernetes, without internet, the API, troubleshooting, architecture, decisions and
  testing.

### Security

Hardened before the release, after a review of the web side, the fetching and the chart:

- Logins, API tokens and login links are 32 random bytes, stored only as SHA-256 hashes, so a copy of the database logs
  nobody in. The host token is a file only jukecord's user can read.
- A change from the panel must carry the session's CSRF token. The session cookie is httpOnly and SameSite=Lax, and
  Secure behind https. A WebSocket with a cookie is accepted from the panel's own origin only, and it ends with its
  login: at once on logging out, within 30 s for an expired session or a revoked token, and within about a minute and a
  half for someone no longer in the server.
- Twenty failed logins from one address within ten minutes block it for a while, for the audio, the live updates and
  logging out too. IPv6 counts by its /56, and at most 10,000 addresses are remembered, the oldest forgotten first.
- Tracks come only from public addresses. Every connection yt-dlp makes, redirects and a playlist's entries included,
  goes through a proxy inside jukecord that refuses private networks; `JUKECORD_ALLOW_PRIVATE_ADDRESSES` allows them
  for a media server at home. DNS lookups have a time limit.
- At most four lookups (two per person) and two MP3 copies run at once; another is refused with "try again in a
  moment" instead of starting more processes than a small server has memory for.
- A browser gets a track's audio only while a server it can open plays or queues it. The panel lists only the voice
  channels a person can see, and the bot joins a channel only for someone who may go there.
- After logging in with Discord, only a page of the panel can come next. Pages carry a content security policy and
  cannot be framed.
- Everything jukecord writes is readable by its own user only, and a database copied in with a looser mode is made so
  again when it is opened.

[Unreleased]: https://github.com/kanggu12/jukecord/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kanggu12/jukecord/releases/tag/v0.1.0
