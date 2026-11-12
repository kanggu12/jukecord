# Changelog

All notable changes to jukecord are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each release's section here is its release notes.

## [Unreleased]

### Changed

- The image carries jukecord's source with the types already taken out: JavaScript, with every line and column where
  it is in the TypeScript, so a stack trace still points into the source. Node no longer loads its TypeScript parser
  in each process: the server rests at about 78 MiB instead of 96, and a `jukecord` command answers in about 100 ms
  instead of 150.
- typebox 1.4.6.

### Fixed

- The watchdog ended jukecord when the whole process had been stopped for longer than half a minute and was let go
  again (`docker pause`, a laptop asleep), whenever its thread happened to look before the main one had moved its
  counter; every server then came back paused. A look that itself comes late now starts the count again.
- What Discord said about a person in a server is reused for a minute and then dropped; it was kept until the next
  start, one entry for every person who had opened the panel, in every server.
- On a small machine with other servers fetching long tracks, a server whose fetch had to wait for its place gave its
  tracks up as too slow before any of them had started, and stopped after three. The time limit of a fetch now counts
  from when it starts.
- A track that failed on every pass of a looping queue was fetched again on every pass, for as long as the loop ran.
  It now gets one more pass, and leaves the loop when it fails again while other tracks play.
- The reasons a track could not be got: an age-restricted video was taken for YouTube's bot check (and kept in a
  looping queue), YouTube's bot check itself read as "it could not be downloaded", and a video for Premium members,
  one locked by DRM, a page withheld for legal reasons (451) and a file too large were kept in a looping queue to be
  fetched again. A premiere or a live stream still to come now says that it has not started yet.
- The live hub, the rate limits and the bot's "listening to" line timed their waits by the system clock: set back (by
  hand, or by NTP after a machine slept), it stopped queue changes reaching open panels, and a login waited out the
  difference on 429s. They time by a clock that only goes forward.

## [0.2.0] - 2026-11-12

### Changed

- The panel is remade in glass, lit by the music. The cards are frosted glass over a field that takes its light from
  the cover of the track playing, and a glow of the cover's colours breathes behind the turning disc; with nothing
  playing the field rests near grey, and the login page is lit by the mark's rainbow. The rainbow travels round the
  disc's rim and runs along the progress bar while a track plays, and rests white when it is paused. Rows are bare
  until the pointer or the keyboard is on them, each with its cover and the record peeking out from behind it. Keys
  are glass, the main key solid, inputs sunk in. Both themes.
- The panel moves, softly: the cards rise into place when it opens, a new track fades in, Skip moves the old one out,
  rows glide to their new places when the queue is shuffled or reordered, come in when added and go out when removed,
  and the card to add music breathes when there is nothing to play. Motion off (in the menu, or asked by the system)
  keeps all of it still, and the system's setting for less transparency turns the glass solid.
- The top bar: the page in use is underlined along the bar's foot, the version is a plain word beside the name, and
  the account key opens the menu and closes it again.
- Refusals and failures read in the panel's language: the Korean panel showed the server's English ("no such site"),
  and the English one showed it without a capital. The panel and the bot now share one table.
- Statistics: each label stands under its own bar and each number on its line, the axis top stays close above the
  tallest bar (52 gives 60, not 100), a year of weeks is labelled by year and month, and the tables' columns say what
  they hold. The log: one record's level is in the singular and in the panel's language, and dates are year-month-day.
- A crowd of panels costs little more than one: each live message is made once for every panel showing the server,
  and a big one (a long queue) is compressed once, as gzip, and sent as the same bytes to every browser that can unpack
  it, instead of being compressed again for each connection. The queue goes out at most four times a second with the
  queue as it is, and who is listening at most once a second, naming the first twenty. On two cores a thousand panels
  at three queue changes a second stay connected and see each change in under a tenth of a second, where two hundred
  were cut off before; an idle panel takes about 15 KiB of memory instead of 0.36 MiB.
- Changes are held to ten a second per login and per address, twenty at once; skip, play now, jump and drop to two a
  second, five at once. Beyond that the answer is 429 `rate-limited` with Retry-After. The host is not held to them.
- While jukecord has fallen behind (its event loop over 0.2 s late), audio and changes from anyone but the host are
  answered at once with 503 `busy` and Retry-After, so the voice and the live updates catch up first. `/metrics` shows
  the delay.
- At most twice the fetch limit of tracks somebody waits for are fetched at once (four on two cores): a storm of skips
  no longer runs a hundred yt-dlp and ffmpeg processes.
- The chart's image is `ghcr.io/kanggu12/jukecord` in the checkout too, not only in the packaged chart. The pod asks
  for 250m and 512Mi and may use 1536Mi (was 100m, 256Mi and 1Gi): Node's heap ceiling is about half the limit, and
  yt-dlp and ffmpeg share the rest. The readiness probe waits 5 s and six misses, the startup probe 3 s; the image's
  health check runs once a minute.
- Upgrading the chart: `env` refuses the token, the OAuth secret and the names the chart sets; `discord.existingSecret`
  together with `discord.token` or `discord.clientSecret` stops the install; an existing Secret must hold `token`, and
  with a client ID set, `clientSecret` too. Give your values file again rather than `--reuse-values`.
- Compose gives the container 1 GiB of memory without swap, at most 1024 processes and a 256 MiB `/tmp`, and needs
  Compose 2.24 or newer.
- The front door lists `restart` and `version`, builds the image before the first start instead of trying to pull
  `jukecord:local`, takes a relative backup name from where it is typed, and `doctor` exits 1 when a check fails.
- The release image says when and on which base it was built; its notes are the CHANGELOG section alone.

### Added

- `JUKECORD_LIVE_MAX`: the most open panels at once (1000 by default); also at most ten per login and twenty per
  address (the host's own count in the total only). One more is told why (1013), and the panel says so in the bar and
  tries again later than after a drop (15 s, doubling to a minute).
- A watchdog: when jukecord's main thread has not answered for 30 seconds, the process ends itself with a line in the
  log, and the restart policy starts it again with every server paused where it was. Docker restarts a container that
  exits, not one that hangs.
- The data folder keeps the newest seven backups.
- The chart: a README (`helm show readme`), `extraEnv` for what `env` cannot hold (`NODE_OPTIONS`, `TZ`,
  `HTTPS_PROXY`, a value from a ConfigMap), `podLabels`, and `networkPolicy.ingressFrom`, which lets only the peers
  named reach the panel's port: behind an Ingress, its controller alone, so the `X-Forwarded-For` jukecord believes
  cannot come from another pod. It has an icon, a maintainer and Artifact Hub's annotations.
- A weekly check fails when a newer yt-dlp is out than the image carries, and prints the sums to bump to; the FFmpeg
  check adds a notice when a newer line than 7.1 exists. Dependabot proposes newer actions, base-image digests and npm
  packages once a week, one pull request per kind.
- [Questions and answers](docs/FAQ.md): what it takes to run, how many people can use it at once, listening with
  friends, what leaves your computer. The guides gain upgrading, uninstalling, backup and restore on Kubernetes,
  memory and CPU, nginx beside Caddy, a second copy on one machine (`COMPOSE_PROJECT_NAME`), and checking a release
  with `gh attestation verify`.
- `tests/perf/measure.sh` measures a server used every day for a year (a thousand tracks queued, 10,000 plays) on two
  processor cores: memory, each read the panel makes, a track's encoding, and a crowd of a thousand panels.
  [Testing](docs/TESTING.md#measurements) has the figures.

### Fixed

- On phones a long title made the page wider than the screen, with the menu key and the cards cut off.
- On phones and tablets the menu could not be closed by touch: it has a close key now, and the key that opens it closes
  it.
- Toasts on phones were cut off at the screen's edge and pushed the menu key off it: they hang under the bar there,
  on up to two lines.
- Escape closes only the newest layer (a rename dialog over the playlists, not both), Tab stays inside it, and the
  player's shortcuts wait while a menu or a dialog is open (an arrow key in the menu seeked the music). Opening the
  menu from the keyboard on a wide window left the focus on the page behind it.
- Discord avatars never appeared: the picture was only attached once loaded, and never started loading.
- The Add key looked ready again while its lookup was still running, when anything else changed meanwhile.
- Badges ("View only", a log record's level) broke inside the word and spilled out of their pill; the log page was
  wider than a phone.
- Touch targets: the seek bar, the volume, the motion switch, the Discord login key and the logo are a finger's size;
  on the narrowest phones the playing card's keys keep to two tidy rows.
- The first connection says "Connecting", not "Reconnecting"; before it, the card says so instead of standing blank,
  and people who may only look are told why the keys are off on touch screens too.
- Light theme: the state colours and the paused disc's rim reach the contrast they need.
- Removing 900 duplicates from a thousand-track queue took about a second, during which no server's music was fed;
  it takes a few milliseconds.
- With the queue on repeat, a track that failed once left the loop for good; it goes back to the end unless it is
  gone for good (removed, private, nothing playable). An outage emptied a queue of one or two tracks; they are put
  back, as three failures in a row put theirs back.
- A server that removed the bot kept fetching and pinning its next tracks; a stopped player needs nothing ahead. The
  next tracks were fetched ahead only once the current one had loaded.
- MP3 copies of long tracks always failed (a fixed minute); they get the time fetching the track gets.
- A DJ role deleted in Discord left only the server's managers able to change the music; it counts as none.
- An address blocked for failed logins also refused the right token, cookie or login link; only failing ones are
  refused now.
- yt-dlp no longer waits on a site that stops in the middle of an answer: the proxy closes yt-dlp's side too.
- The history pages in the order entries were written, so a clock set back cannot hide an entry.
- The front door says why when Docker is not answering or Compose cannot read `.env` (with the line), instead of "not
  running", a doctor that passed, or no message at all; `restore` refuses a file that is not a database before it
  stops anything; the time zone is read on macOS too.
- The notes after `helm install` give https for an Ingress with TLS, as the pod gets, and say when a secret is in the
  values, when the Ingress has no TLS, and when it has no host. helm test's pod takes the image pull secrets, node
  selector and tolerations jukecord's pod has.
- The guides name the Compose volume as Docker does (`jukecord_jukecord-data`), the Kubernetes example has TLS, the
  build cache (about 800 MB) can be removed alone, and they say what the systemd unit is for.

### Security

- yt-dlp, ffmpeg and the JavaScript runtime yt-dlp starts no longer inherit jukecord's settings, the bot's token and
  the OAuth secret among them. The chart gives jukecord both as files (`JUKECORD_DISCORD_TOKEN_FILE`,
  `JUKECORD_DISCORD_CLIENT_SECRET_FILE`), not as variables.
- `/metrics` answers only a scraper beside jukecord: a request through the reverse proxy or from a public address gets
  a 404 instead of the version and the counts.
- A client that sends half a request no longer holds its connection for good: a request must arrive within 30 s
  (its headers within 15 s), and at most 4096 connections are open at once. Answers (audio to a slow phone) and live
  connections have no time limit.
- The image keeps no npm and no setuid or setgid program, and jukecord's files are 644 and its folders 755 instead of
  all 755.
- The release's outside actions that hold a token with write access are pinned by commit; the chart test runs on pull
  requests, and CI runs the image without capabilities.

## [0.1.1] - 2026-11-12

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
  fetched whole, up to 512 MB and with its progress shown, and plays, instead of failing as "the downloaded audio is
  empty".
- Accessibility: the logo link has a name on phones, each page has one main landmark and one level-one heading, the
  menu's sheet is a valid dialog, the log can be scrolled from the keyboard, and the player's heading is not read out
  empty before the first state. The panel walk runs axe-core on the pages it photographs and fails on any rule broken.
- A server that removes the bot: its player stops (nothing more is fetched for it), the bot leaves its voice channel,
  and the commands are registered again if the server adds the bot back; before, a remembered fingerprint skipped them.
- A part that fails while hearing about a change (a panel's message, a card) no longer keeps the others from hearing
  it, nor takes the process down with every server's music when the change came from a player's timer.
- Audio files keep their day-long browser cache; the panel files' "no-cache" had replaced it.

### Security

- The image's FFmpeg has only the four libraries it needs (Opus, LAME, OpenSSL and zlib) instead of the libraries of
  every codec and device that Debian's package brings, so much less code reads the media sites send. Debian's updates
  no longer reach it by themselves: a weekly check fails when a newer FFmpeg release of its line is out, and a patch
  release of jukecord brings it.

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

[Unreleased]: https://github.com/kanggu12/jukecord/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/kanggu12/jukecord/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/kanggu12/jukecord/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/kanggu12/jukecord/releases/tag/v0.1.0
