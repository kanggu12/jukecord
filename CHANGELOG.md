# Changelog

All notable changes to jukecord are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each release's section here is its release notes.

## [Unreleased]

## [0.3.1] - 2026-11-13

A pass over the whole of 0.3 for bugs and awkward corners, and a panel with its colour back.

### Changed

- The panel has its colour back: a deep blue-black field with the brand's blue and violet far behind the glass, the
  brand's blue for the main keys, the page in use and the choice made, a colour of its own for each person's face, and
  the playing card lit by its own cover. The cover's light no longer tints the whole panel.
- Room that grows with the window: the cards' insets and the gaps between them step up on a laptop and on a wide
  screen, and a short window keeps the small room its lists need.
- The listening bar: Listen here is a key in words, its bars dancing while the music plays here; the sleep timer is a
  moon, there while this browser listens; pause and skip are bare icons. On a phone the state under the title no
  longer breaks into single letters.
- The playing card's title is the player's state with its lamp ("● Playing"), no longer "Now playing" beside it.
- Wrapped's picture heads its cards as the panel does, in the words as written, without spaced capitals.
- A question over a dialog shades the dialog under it, which no longer takes clicks.
- History and liked rows in a laptop's side column show who added each track; their keys are behind "…".
- Autoplay from this server's plays plays on a new server too, picking one of the tracks heard longest ago.
- The command line refuses words after a command that takes none (`stop after`, `skip 3`) and names the command likely
  meant; it says a wrong channel or role ID, a per-person limit over 1000 or a move past the end in its own words, with
  exit code 2; `jukecord playlist`, `jukecord token` and `jukecord help <group>` list the group's commands.
- Refusals say what they mean: revoking a listening link cuts its guests off at once; a friend refused is told what a
  friend may not do; a login that may only look is told it can look and listen; a guest whose link ended is told to ask
  whoever shared it; the vote-to-skip setting says it works once a DJ role is chosen; `/clear` says what it removed.

### Fixed

- Each local file in a Spotify playlist got the first one's recording; each is matched on its own.
- `/queue`, `/history`, `/likes show` and `/playlist list` failed on long titles, long addresses or many playlists; they
  say how many more lines there are, and titles show `*`, `~`, `|` and backticks as written.
- Lyrics hung for minutes while LRCLIB asked jukecord to wait; they are refused at once, with Retry-After.
- `./jukecord` lost a playlist import's file when options such as `--guild` came before the command.
- "Still connecting to Discord" and "Discord did not answer" came without Retry-After, so the command line exited 1
  instead of 4.
- `jukecord doctor` said "none yet" when every daily backup had failed; it warns with the reason.
- The same search words again just after a search was stopped failed.
- Copy that failed on a listening link spoke of a token; it says the link is selected.
- On a phone, the lyrics sheet's close key hung across the line under its head.

## [0.3.0] - 2026-11-13

What no other bot does, made more of: the queue heard in any browser in step with the voice channel now has guests
without a Discord account, lyrics everyone follows at the same line, a light that moves with the music, and an app to
install. And what the others had that jukecord lacked: search and pick, autoplay, likes, vote skip, taking turns, a
voice volume and sound, links from other services, playlists as files, and a year in music.

### Added

- **Search and pick.** Search words show what YouTube found (cover, title, length, channel) under the add field, to
  play now, play next or add; Discord suggests the same while `/play` and `/add` are typed, and `jukecord search`
  prints it. Results are kept for half an hour, and searches have a rate of their own. The add card has a Play next
  key, history rows have play now, play next and add again, and a link pasted or dropped anywhere on the page is
  added.
- **Autoplay.** When the queue runs out, a track from this server's own plays (likes count double, nothing of the last
  30 plays) or from YouTube's mix of the track playing; one is queued as the last track starts, so there is no gap.
  Its rows say "Autoplay", and statistics and Wrapped leave them out of who added most. `/autoplay`,
  `jukecord autoplay`, the queue card's head.
- **Likes.** A heart on the playing track, in a queue row's menu and on history rows; a Liked list in the card of
  Recently played, with play now, next, add and add all. `/like`, `/likes`, `jukecord like|likes|unlike`.
- **Playlists as files.** A saved playlist exported as a list of addresses, M3U or jukecord's JSON, and imported from
  any of those or a pasted list: up to 500 entries, of which at most 100 that need looking up (an address jukecord has
  not met, or words, searched on YouTube). From the playlists dialog, `/playlist export|import` (a file up to 1 MiB)
  and `jukecord playlist export|import`; `./jukecord` reads the file where the command is typed.
- **Links from other services.** Deezer tracks, albums and playlists; Spotify tracks (albums and playlists too with
  the host's app credentials, `JUKECORD_SPOTIFY_CLIENT_ID` and `JUKECORD_SPOTIFY_CLIENT_SECRET` or `_SECRET_FILE`);
  Apple Music tracks. Each is matched to a YouTube recording by length and title, official audio first, at most 100
  per link. `JUKECORD_LINK_SERVICES` chooses the services (all three by default, `none` for none).
- **Lyrics in time.** The words of the track playing, from LRCLIB, beside the player (a sheet on a phone), the line
  being sung lit; whoever may change the music picks a line to play from there. `/lyrics`,
  `jukecord lyrics [--synced]`; `JUKECORD_LYRICS=off` turns them off. jukecord sends LRCLIB the song's title, artist,
  album and length, once per track, only when someone opens its lyrics.
- **Listening links for guests.** A link for 1, 7 or 30 days lets anyone listen along to one server in a browser
  without a Discord account: the player, the queue and Listen here, nothing to change. Revoking it ends its guests at
  once. The host can also let a friend in to look or to change the music with a login link
  (`jukecord link --scope read|control`). Both from one Invite dialog, with a QR code drawn by the panel; `/share`,
  `jukecord share|shares|unshare`.
- **A light that moves with the music** while a browser listens: the glow behind the disc and the light behind the
  glass follow the low end; it rests when the tab is hidden, the music pauses or motion is off.
- **An app on a phone.** The panel installs to a home screen and opens like an app (over https or on this computer);
  on Android, a video shared from another app opens a page to add it to the queue.
- **Stop after this track, and a sleep timer.** The player stops when the track ends (the player's menu,
  `/stop after-track:`, `jukecord stop --after-track`), and a browser stops listening after 15, 30 or 60 minutes or at
  the end of the track.
- **Vote skip.** Where a DJ role is set, Skip from anyone without it is a vote; the track goes when half of the people
  listening in the voice channel and in their browsers have voted (guests of a listening link do not vote). The Skip
  key and the Discord card show the count. On by default; `/voteskip`, `jukecord voteskip on|off` or the menu's Server
  settings turn it off.
- **Taking turns, and a limit per person.** Tracks added go so that people take turns, or the queue is put in turns
  once; a server can limit how many tracks one person queues. `/turns`, `/limit`, `jukecord turns|limit`, the menu's
  Server settings.
- **Stay in voice.** A server can keep the bot in its channel when everyone has left (`/stay`, `jukecord stay`, the
  menu).
- **A volume and a sound for the voice channel.** 0-200 %, and presets: more bass, clearer voices, brighter, softer at
  night. Browsers playing along hear the same preset at their own volume. At 100 % with no preset the cached sound
  goes to Discord untouched; another volume or a preset costs 2 to 3 % of one core per stream. The voice card,
  `/volume`, `/sound`, `jukecord volume|sound`.
- **Wrapped.** A server's year in music, a month, or the last 12 months: plays and hours, the song of the year (the
  track played on the most days), the most played tracks and who added most, the busiest day and hour, the longest
  day and the first track; saved as a picture for a story or a post. `/wrapped`, `jukecord wrapped`.
- **Looks after itself.** A server nobody hears anywhere (the bot out of voice, no browser playing) pauses after two
  minutes instead of fetching and counting plays for nobody (`JUKECORD_REST_AFTER`); after a restart the bot goes back
  to its voice channel when people are there; the newest now-playing card in Discord follows the music; an alerts
  channel of the server's choosing (`/alerts`, `jukecord alerts`, the menu) hears about trouble (YouTube refusing
  jukecord, a watchdog restart, a disk nearly full, a daily backup that failed, a track leaving a looping queue,
  connections turned away); and a backup can be made every day (`JUKECORD_BACKUP_AT`, `JUKECORD_BACKUP_KEEP`), which
  `doctor` reports with what the database's write-ahead log holds.

### Changed

- The panel, evened out: the controls of a row one height on one centre, a key's words on the centre of its icon, and
  cards side by side one top and one bottom, measured to half a pixel on every screen the walk opens; one spacing
  scale, six type sizes whose lines centre their letters, and one rule for corners; flat frosted glass, its keys a face
  and a 1px line; no glows or pools of light, coloured stripes, tinted boxes or boxes inside boxes; a row's title on
  two lines at most (the whole of it on hover) with one line under it; two lines nobody needed taken out.
- Covers come from jukecord: each track's picture, and a search result's, is fetched once by the server (public
  addresses only) and kept with the track in its cache, so browsers never ask the image hosts.
- The add card sits above the queue, and on top of an empty one with an example of what to add.
- The player says "Waiting for its turn" while a track waits for a fetch, and a notice under the title when something
  happened to the music ("Paused with nobody listening", a track taken out of a looping queue).
- Look-ups in Discord (`/history`, `/stats`, `/lyrics`, `/likes` and the rest) answer the person who asked only, as
  `/queue` already did.
- The command line exits with 4 when jukecord says to try again in a moment (an answer with Retry-After, which a busy
  moment now carries too), gives its errors as JSON under `--json`, shows one command with `help <command>`, and says
  validation mistakes in words.
- `./jukecord` runs the container in the host's time zone, and statistics count their days in jukecord's time zone
  instead of UTC.
- Korean throughout, read again by a native reader: 추가 for adding, 라이트/다크/시스템 for the themes, 맞춰 재생 중 for
  "In time", and the refusals the bot and the panel share. `/resume` is `/이어재생` in Korean (it was `/다시재생`).
- The API has 22 new operations (`docs/API.md`) and two pictures of its own (a track's cover, a search result's); a
  skip may name the track it is for (`?track=`); `/metrics` counts the cached covers.
- The database moves to a new schema the first time 0.3.0 starts, which 0.2.1 does not open: a backup made before
  updating (`./jukecord backup`) is the way back.

### Fixed

- A long track could not be heard in a browser that needs MP3 (Safari, iOS): the wait for the copy ran into the
  two-minute idle close. It is answered "not now" until the copy is ready.
- `./jukecord restore` refused any backup over 256 MiB and gave the Node version as the reason.
- A looping queue let a track go during a YouTube bot-check or an outage, as a track played from the cache counted as
  proof that the site worked.
- The player timed its position and seeks by the system clock; set back, the bar and seeks stood still.
- More than 16 pipelined requests lost every answer; the cap of 256 connections per address and the read rate per
  address turned away people sharing one address (a household, Docker's bridge) and said nothing; the probe at a cap
  closed a tab that stalled for five seconds.
- A second press of Skip, or the Skip of a stale card, skipped the next track as well: a skip names the track it is
  for.
- Pause on a paused track said nothing was playing, and a stale card's button refused wrongly.
- A backup of a large database stalled the voice and could set off the watchdog: it is written in a worker thread.
- A machine that could not reach the internet was told that every site did not exist; adding and playing now say
  that jukecord cannot reach the internet.
- In Discord: a voice channel at its member limit is said to be full at once, `/join` to the bot's own channel does
  nothing, `/playlist save` over a name says it replaced the list, and `/queue` past its last page shows the last.
- On the command line: an uptime past a day reads in days and hours, a listening time never reads "0 h 60 min", and
  `./jukecord` says a mistyped command is not one while jukecord is down, and passes on words it does not know while
  it runs.
- In the panel: the focus was lost after almost every key press; a reverse proxy's error page showed as a JavaScript
  error; short laptop windows hid the add field; the N shortcut did nothing in Hangul input mode; people who may only
  look saw drag grips.

### Security

- Guests of a listening link have their own kind of login: an allow-list of what they reach (the player, the queue
  and the lyrics of their server), codes of 32 random bytes kept as hashes and sent after "#", a cap of guests per link.
- Every outside request (covers, lyrics, Deezer, Spotify) resolves the name itself, connects only to the public
  address it checked, and checks each redirect again (unless `JUKECORD_ALLOW_PRIVATE_ADDRESSES` is set); lyrics follow
  no redirect at all.
- The panel's content security policy allows pictures from jukecord and from Discord's own address only; it allowed
  any https address.

## [0.2.1] - 2026-11-12

### Changed

- The image carries jukecord's source with the types already taken out: JavaScript, with every line and column where
  it is in the TypeScript, so a stack trace still points into the source. Node no longer loads its TypeScript parser
  in each process: the server rests at about 78 MiB instead of 96, and a `jukecord` command answers in about 100 ms
  instead of 150.
- Reads are held to a rate of their own, thirty a second with sixty at once, per login and per address (a panel reads
  a handful when it opens and gets the rest over its live connection), and connections to sixteen answers under way
  each and 256 from one address, unless `JUKECORD_TRUST_PROXY` says they come through a proxy. The host is held to
  none of the rates.
- The image's build stages are named jukecord and jukecord-…, so `docker buildx prune --filter description~=jukecord`
  (docs/INSTALL.md) finds the final stage's cache too (about 170 MB a build), which it left before.
- typebox 1.4.6.

### Fixed

- The panel froze for a moment at every change of a long queue: with a thousand tracks queued, each change (every
  track start is one) took about 220 ms of the page, and a second on a slower phone. Rows are measured first and
  then glide, the ones out of sight do not, a row from far away fades in, and clearing a search no longer glides:
  under 50 ms now, and 0.2 s on that phone.
- On phones a message raised while the menu was open was hidden under it, and one raised over a dialog sat under its
  shade. Messages show over the menu, inside the dialog that is open, and on wide windows in two lines with their
  whole text.
- On a touch screen a finger that started a scroll on the progress bar moved the track for everyone; a vertical swipe
  now scrolls the page.
- A tablet held sideways showed one row of the queue or none. Short windows get the one-column page (below 820 px of
  height on touch, 720 with a mouse), and two columns always show three rows of the queue or more.
- Why the live connection was turned away (jukecord full, or refused) was shown in English in the Korean panel and
  went with the message; it is said in the panel's language and stays on the playing card while the panel waits.
- In the system's high-contrast colours (forced colours) the progress bar, the motion switch, every selection and
  the charts were invisible or looked alike; they are drawn in the system's colours.
- Skip with a slow answer blanked the playing card until the answer came; it comes back after a second.
- With nothing to play, the card that invites adding music repainted the page sixty times a second for as long as it
  was open, and the listening bars seventy; both now move what the graphics card moves by itself (near nothing at
  rest, twelve a second while listening), and the card rests lit after a few breaths. The look is the same.
- A start-up that could not reach jukecord left a blank page; the waiting page shows and the panel tries again.
- The playing card's keys left Remove alone on a second row at some two-column widths; they drop their words by the
  width of their own row.
- A removed row came back for a moment before it went; Enter pressed twice removed once and showed an error; the
  focus was lost. The row stays gone, one press removes it, and the focus moves to the row that takes its place.
- A long display name pushed the menu key off narrow screens; it is cut with an ellipsis, its whole text as a title.
- Dragging a track's title or cover dragged its row; it carries the track's address.
- On the dark theme faint text fell under 4.5:1 when a bright cover lit the glass behind it; it is lifted, and the
  glass and the light stay.
- At 200 % zoom the list of keyboard shortcuts could not be read to its end without a mouse: dialogs use the height
  of short windows, and a list that still overflows is scrolled with the keyboard.
- Keyboard focus: the playlists dialog opens on its first Load key; the focus stays through a rename, a delete, a new
  or revoked token and a language change; the menu's choices are named for screen readers. Enter in the rename dialog
  no longer opens a second one.
- A server switch said "Reconnecting" and slid every row of the new queue in as if just added.
- The listening bar's small disc started its turn again at every change, each volume step included.
- Skips in quick succession cut the cover's light instead of fading it.
- Alt+arrow at either end of the queue showed an error; it does nothing.
- Statistics: the tooltip says "5 plays · 11-12 · 9 min" (it wrote the time listened like a time of day), the labels
  stand under their bars, and Korean dates read 11/12 and 2026.05 (they read like decimals).
- Touch targets of the page links on tablets, the token name field, the log's columns (they started at three places),
  its filter and tools (they ran off the screen at 561-680 px), and Refresh on small phones.
- With less transparency asked for, the menu, dialogs, messages and the login card are solid too.
- The system's Back closes the open menu or dialog first, one at a time, instead of leaving the panel; the menu marks
  the page in use.
- The login page showed any text given in its address as an error; an unknown error says the login did not go
  through. Its name row is left-aligned on touch screens as elsewhere.
- On phones with a notch or rounded corners the bars and the page keep to the safe area.
- Korean wording throughout the panel (재생 위치, 다음에 재생, 총, 현재 곡, 실행 중, 덮어씀, 만료된 로그인 링크, and the
  refusals the panel and the bot share: 응답 코드, 스테이지 채널, "다시 시도하세요"), and an English refusal that begins
  with jukecord's name keeps its small letter.
- The watchdog ended jukecord when the whole process had been stopped for longer than half a minute and was let go
  again (`docker pause`, a laptop asleep), whenever its thread happened to look before the main one had moved its
  counter; every server then came back paused. A look that itself comes late now starts the count again.
- One client could hold every place under the cap of 4096 connections, health checks included, with ordinary
  keep-alive connections or with answers it never read (the headers of a long audio answer, then nothing). Besides
  the share per address, a connection on which nothing moves for two minutes is closed, as nginx does after one (a
  browser that paused its audio asks again when it plays on), and one turned away at the cap closes the idle ones to
  make room for the next, which the log says once a minute.
- A client that sent many requests in one go without reading the answers (HTTP pipelining, which no browser does)
  had every one answered and held in memory: a few connections filled the heap and stopped jukecord. And one member
  sending a burst of the heavier reads (a year of statistics) held the event loop until the watchdog ended jukecord.
  Both are refused cheaply now; the API's description (`/api/v1/openapi.json`, open to anyone) is made once.
- On a small machine with other servers fetching long tracks, a server whose fetch had to wait for its place gave its
  tracks up as too slow before any of them had started, and stopped after three. The time limit of a fetch now counts
  from when it starts.
- A track that failed on every pass of a looping queue was fetched again on every pass, for as long as the loop ran.
  It now gets one more pass, and leaves the loop when it fails again while other tracks play.
- The reasons a track could not be got: an age-restricted video was taken for YouTube's bot check (and kept in a
  looping queue), the bot check itself read as "it could not be downloaded", and a video for Premium members, one
  locked by DRM, a page withheld for legal reasons (451) and a file too large were kept in a looping queue to be
  fetched again. A premiere or a live stream still to come says that it has not started yet.
- Tabs whose browser was gone without a goodbye (the network lost, a laptop shut) held their login's places until the
  heartbeat found them, up to a minute, so the same browser coming back was told to close a tab or two. A connection
  turned away at a cap has the ones holding that cap's places pinged, and those that do not answer within five
  seconds are let go: the panel's next try gets in.
- A member's changes that the actions refused (no DJ role) used up the rate of the whole address, so a DJ behind the
  same address was told to wait. A refused change gives its address's share back; the member's own rate still holds.
- The live hub, the rate limits and the bot's "listening to" line timed their waits by the system clock: set back (by
  hand, or by NTP after a machine slept), it stopped queue changes reaching open panels, and a login waited out the
  difference on 429s. They time by a clock that only goes forward.
- A listener who switched servers was missing from the listeners in the state it got, until the next listeners
  message a second later.
- A stop waited for any audio answer still under way, which lasts as long as a browser takes to read it, and so ran
  into its ten seconds and ended without leaving voice or closing the database. What is still under way two seconds
  into the stop is cut.
- What Discord said about a person in a server is reused for a minute and then dropped; it was kept until the next
  start, one entry for every person who had opened the panel, in every server.
- `./jukecord restore` took a backup cut short (it has the right first bytes), swapped it in and left jukecord
  restarting in a loop on "database disk image is malformed". The file is read whole by the image's SQLite before
  anything is stopped, and refused with what is wrong with it. `./jukecord backup` prints the backup's whole path,
  which `restore` takes from any folder; `./jukecord restart` after `./jukecord down` says at once that jukecord is
  not running instead of waiting a minute; a value in `.env` with a comment after it is read as Compose reads it.
- The chart refused the `global` values a parent chart gives every chart it depends on, so jukecord could not be a
  dependency, and an upgrade with `--reuse-values` from 0.1.1 stopped on `podLabels`.
- The chart says where a value belongs when it refuses one: the bot's token or the OAuth secret in `env` or
  `extraEnv`, a name the chart sets itself, one name in both, and an OAuth secret without the application's ID (which
  rendered, and then stopped jukecord at start). Its schema refuses what Kubernetes would refuse at install (a size
  like `5K`, a host with a scheme, a label with a space, a range without its length, a variable with both a value and
  a source, a peer that names nothing) and takes what Kubernetes takes (`5k`, `1Pi`, IPv6 ranges). The notes after
  an install say when `JUKECORD_PUBLIC_URL` comes from `extraEnv`'s `valueFrom`, and that with the Ingress on and
  `networkPolicy.ingressFrom` empty any pod of the cluster may reach the port whose `X-Forwarded-For` jukecord
  believes.
- The guides said how many tracks are fetched at once wrongly: up to the fetch limit ahead of time, and twice that for
  tracks somebody is waiting for, beside them. docs/KUBERNETES.md says that a new token in an existing Secret takes
  effect when the pod starts again; the FAQ and the troubleshooting guide, that Docker's restart policy (not the
  systemd unit) starts a jukecord that ended itself.
- The image build stops when a relative `.ts` path is left in the source as JavaScript (a template string, a module's
  address made with `new URL`), which the image could not load, and when a `.js` and a `.ts` of one name sit side by
  side. The weekly FFmpeg check reads a line's first release (9.0) as that line, and the chart's test runs when the
  scripts or what goes into the image change.

### Security

- The workflows pin every outside action by commit, Docker's too, as the 0.2.0 notes said they did, and give the
  release's token to helm through the environment instead of writing it into the step's script.
- `/metrics` takes the standard `Forwarded` header as a sign of a proxy, as it does `X-Forwarded-For`.
- yt-dlp and ffmpeg run without jukecord's settings in their environment, which keeps the token out of what they
  print and pass on; the code now says that this is not a wall against a child program that turns hostile, as it runs
  as jukecord's user.

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

[Unreleased]: https://github.com/kanggu12/jukecord/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/kanggu12/jukecord/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/kanggu12/jukecord/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/kanggu12/jukecord/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/kanggu12/jukecord/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/kanggu12/jukecord/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/kanggu12/jukecord/releases/tag/v0.1.0
