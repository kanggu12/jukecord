# Testing

| Suite             | Command                                        | What it covers                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| :---------------- | :--------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| unit              | `npm run test:unit`                            | settings, units and times, the database and its migrations, the queue, the player's states, the cache, yt-dlp's output, the actions and their limits, who may do what, logins and tokens, the API through Fastify's inject, the parity of the four ways in, the statistics, the self-check                                                                                                                                                                                |
| integration       | `npm test` (with the unit tests)               | real ffmpeg with a fake yt-dlp: fetching, converting, seeking, retrying; the voice channel's sounds; live updates over a real WebSocket; the web server's own limits; the `jukecord` command against a real server                                                                                                                                                                                                                                                        |
| packaging         | `node --test "tests/packaging/**/*.test.ts"`   | one version everywhere, the changelog, the API document, the Dockerfile (pins, file modes, labels, what the panel's stage copies), the Compose file's limits, the front door's help, the chart (lint, template, the values it refuses, kubeconform when installed), the workflows (pins, the release's checks) the scripts, and the release's programs (their pins against the image's, the workflows building and running each, the launcher's settings and data folder) |
| the panel         | `tests/ui/run.sh <folder>`                     | every state at eight window sizes, both themes and both languages, measured; the browser playing along                                                                                                                                                                                                                                                                                                                                                                    |
| measurements      | `tests/perf/measure.sh [cores] [panels]`       | a server used every day for a year, on two processor cores: memory, the panel's reads, a track's encoding, a crowd of a thousand panels                                                                                                                                                                                                                                                                                                                                   |
| the chart         | `deploy/kind/check.sh <image>`                 | the chart on a throwaway kind cluster                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| the programs      | `node scripts/bundle-smoke.ts <archive>`       | one of the release's programs on its own system and processor: unpacked, its Node.js, FFmpeg, yt-dlp and voice encryption working, started with its launcher, a track played through yt-dlp and FFmpeg, stopped (`bundles.yml` runs it for every target, `downloads.yml` again from the published release)                                                                                                                                                                |
| macOS and Windows | `platforms.yml`                                | the unit tests on macOS and Windows, which the programs run on                                                                                                                                                                                                                                                                                                                                                                                                            |
| databases         | `JUKECORD_TEST_DATABASES=<addresses> npm test` | the store's tests (every repository, migrations, copies, backups, transactions racing) on SQLite and on each PostgreSQL, MySQL or MariaDB named ([databases](#databases))                                                                                                                                                                                                                                                                                                 |
| the bus           | `JUKECORD_TEST_BUS_URL=redis://... npm test`   | the bus, the shared cache and a core with two edges in one process, on Redis or Valkey as well as in memory ([a split](#a-split-into-services))                                                                                                                                                                                                                                                                                                                           |
| the split         | `tests/split/run.sh [postgres\|mysql] [image]` | the Compose split end to end: a core, two edges, the database, Valkey and Caddy                                                                                                                                                                                                                                                                                                                                                                                           |
| logins            | `tests/auth/run.sh`, `tests/auth/run-ad.sh`    | logging in for real through Keycloak, an OpenLDAP and a Samba domain controller ([logins](#logins))                                                                                                                                                                                                                                                                                                                                                                       |
| the chart, split  | `deploy/kind/check-split.sh <image>`           | the chart's split mode, with its logins, on a throwaway kind cluster                                                                                                                                                                                                                                                                                                                                                                                                      |
| everything quick  | `npm run check`                                | lint, types, unit and integration tests                                                                                                                                                                                                                                                                                                                                                                                                                                   |

The integration tests need ffmpeg with libopus; they are skipped (and say so) without it. Nothing in the tests talks
to Discord, YouTube or any other site: yt-dlp is replaced by `tests/support/fake-yt-dlp.mjs`, Discord's API by fakes,
and every example address is on example.com or media.example. What YouTube, Deezer, Spotify and Apple Music answer
(a search, a mix, Deezer's track, album and playlist, a Spotify and an Apple Music track's page) was read once from
the real services and is kept in `tests/fixtures` in its real shape, with every value made up.

## Databases

The store's tests run on SQLite always, and on every server named in `JUKECORD_TEST_DATABASES`, separated by spaces.
Each test gets an empty database at the latest schema: a PostgreSQL schema, or a MySQL database (`jkt_<pid>_<n>`), of
the test process's own, emptied after each test and dropped at the end. A PostgreSQL address names a database the
tests may make schemas in; a MySQL or MariaDB one, a user that may make databases (root, in a throwaway container):

```bash
docker run -d --rm --name jukecord-postgres -p 127.0.0.1:15432:5432 --tmpfs /var/lib/postgresql \
  -e POSTGRES_USER=jukecord -e POSTGRES_PASSWORD=jukecord -e POSTGRES_DB=jukecord postgres:18-alpine
docker run -d --rm --name jukecord-mysql -p 127.0.0.1:13306:3306 --tmpfs /var/lib/mysql \
  -e MYSQL_ROOT_PASSWORD=jukecord -e MYSQL_DATABASE=jukecord mysql:8.4
JUKECORD_TEST_DATABASES="postgres://jukecord:jukecord@127.0.0.1:15432/jukecord mysql://root:jukecord@127.0.0.1:13306/jukecord" npm test
```

CI runs them on the oldest and the newest of each: PostgreSQL 14 and 18, MySQL 8.0 and 8.4, MariaDB 10.11 and 11.8,
each pinned by version and digest. Among them: a source address of 3,000 characters kept unique by its hash, emoji and
names that differ only by case or accent kept apart, two transactions at a limit that both read first (one passes),
two jukecords opening a new database at once, a copy from SQLite through each server and back with every row compared,
a copy that fails halfway and changes nothing, and backups of each kind. `JUKECORD_TEST_STORE=<address>` puts every
store of the whole suite on one server, to look for paths the store's own tests miss; the tests driven by a fake clock
fail there by design, since they expect SQLite's answer within a turn of the event loop.

## A split into services

`tests/integration/split.test.ts` runs a core and two edges in one process, on the bus in memory, and on Redis or
Valkey too when `JUKECORD_TEST_BUS_URL` names a server: a change made through one edge reaches the other's live
connection, a login link made on one edge works on the other, a revoked listening link ends its guests on both, a
person's rates are counted once across edges, and each role answers its readiness and its figures. The bus's and the
shared cache's own tests take the same variable:

```bash
docker run -d --rm --name jukecord-valkey -p 127.0.0.1:6379:6379 valkey/valkey:8-alpine
JUKECORD_TEST_BUS_URL=redis://127.0.0.1:6379 npm test
```

`tests/split/run.sh` brings the Compose split up under a throwaway project, browser-only: every service ready by its
parts, a login link made in one edge used at the other, a track added through one edge playing as the other's live
connection is told, its audio through an edge with a Range request and whole through the front, then the core
restarted: the panels are closed with 1012, both edges are ready again, and the player is back on the same track,
paused. It removes what it started, and runs on PostgreSQL or MySQL. `deploy/kind/check-split.sh` installs the chart in
split mode on a throwaway kind cluster, with a PostgreSQL, a Valkey and the logins set up: `helm test`, the jukecord
command in an edge, a token made in one edge used through the Service, only the edges reaching the core's internal port,
and the edges ready again after the core's pod is replaced.

## Logins

`tests/auth/run.sh` starts a Keycloak (its realm imported from `tests/auth/keycloak-realm.json`) and an OpenLDAP (the
people of `tests/auth/openldap.ldif`, with a certificate made for the run), and runs `tests/auth/*.test.ts` against
jukecords it starts: logins through the provider by group and by realm role, its userinfo, logging out there, a wrong
secret, the directory over LDAPS and StartTLS, groups from `memberOf` and from a search, refusals of each kind.
`tests/auth/run-ad.sh` does the same against a Samba domain controller built from `tests/auth/samba`: a service account
by its user principal name and by its down-level name, people by `sAMAccountName`, nested groups, an expired password
and a turned-off account. The two use the same ports, so they run one after the other, and remove their containers at
the end. CI runs both (`logins.yml`).

The alert rules are checked by `promtool check rules` and `promtool test rules` when promtool is on the PATH (CI runs
them in Prometheus's pinned image), and the dashboard's and the rules' queries may name only families jukecord
declares, with their labels.

## The panel

`tests/ui/run.sh` seeds a throwaway jukecord with made-up tracks, people and a month of history
(`tests/ui/seed.ts`), starts it, and walks the panel in Playwright's Chromium (`tests/ui/walk.mjs`): idle, playing,
paused, loading, a failed track, a lost connection, the menu, the dialogs, the statistics with a tooltip open, the log,
the login page, an empty queue and a 200-track one, at 360 to 2560 pixels wide. On phones and the tablet it also plays
the longest title and raises a toast, where width is shortest; a long refusal is raised with the menu open, with a
dialog open and in the bar of wide windows. It also walks a tablet held sideways (touched, short), a phone with a notch
and a home bar (safe-area insets, upright and sideways), a contrast theme (forced colours, the menu and the
statistics), the shortcuts on a short window (a page zoomed to 200 %), and the longest names Discord allows in the bar.
The panel with a Discord bot is walked too: a made-up server, its voice channels and people listening in browsers are
put between the page and the server, which runs browser-only. In it, someone without the DJ role sees a vote to skip
under way at every width, and someone who manages the server opens the server's settings; the walk also takes turns from
the queue's tools, opens the voice channel's sounds, and plays along as sounds are put on while it plays. It also types
words in the add field (the search's answer is the walk's own, made from the seeded tracks), holds a link from another
window over the page, opens the liked list, autoplay's choices and a row autoplay queued (from the seeded plays: nothing
is fetched), a playlist's export and import, and the queue's tools on a phone with autoplay among them. The README's
pictures come from the same walk. The seed's history is a year long (the server new a year ago, with a few plays in its
first month), and its covers are PNG pictures in jukecord's cache, as jukecord keeps the ones it fetches: Wrapped is
walked over the year, over that first month and over a year with no plays, with its times to choose from, its "Save as
picture" dialog and a contrast theme, and the pictures themselves (both shapes, both themes and languages, the year and
the first month) are saved into the folder as `picture-*.png`, to be looked at whole.
`tests/ui/audit.js` measures each page: text that is clipped (unless marked so, with its whole text as the title) or
drawn over other text, a key whose words run out of its box, contrast below 4.5:1 (with translucent layers composited),
rows and columns to half a pixel (the controls of one row at one height and one centre with the labels and words in it,
an icon on the centre of the first line of its words, the words of a key, a pill, a badge or a face in the middle of
their frame (upright by their capitals, or by a Korean word's syllables), cards side by side at one top and one bottom,
the children stacked in one container at one left edge and the boxes ending them at one right edge, words side by side
on one baseline, every padding, margin and gap on the spacing scale), floating layers that cut across other boxes, a
sheet, a dialog or a toast that something else covers, a page wider than the screen, a badge whose word breaks out of
it, the playing card's keys leaving one key alone on a row, a list in a card with room for fewer than three rows, a
dialog that scrolls while the window has room under it, a box that scrolls with nothing in it the keyboard can stop on,
a state told by a fill alone drawn like its absence (as a contrast theme paints), keys and cards under a screen's notch
or home bar, touch targets under 44 pixels (keys, fields, the switch, the sliders and the seek bar, the logo), a listen
bar pushed off the foot of the window (a page that ran past the window and scrolled its bars with it), a scrolling box
whose end stays under a bar, a shade under which the page still reads (2.7:1 at most), a contrast theme's bar left
see-through, a word broken over two lines in a title, a word alone on a paragraph's last line, and the loading colour on
anything but loading. On the pages it photographs it also runs axe-core's accessibility rules (names, roles, landmarks,
headings). It also counts, for each page, the different font sizes, control heights, corner radii, paddings and gaps it
shows, into the report and a summary at the walk's end: the fewer, the more the panel reads as one system. It also
presses **Listen here** and waits for the browser to be in time with the server. `tests/ui/verdict.mjs` fails on any
finding; the pictures land in the folder given. The whole walk takes about 40 minutes on a GitHub runner, so the look
workflow walks it in four groups at once: `tests/ui/groups.ts` deals the walk's states out
(`ONLY="$(node tests/ui/groups.ts 0 4)" tests/ui/run.sh <folder>` is the first quarter), and the last group also
takes the README's pictures and the two playing-along checks.

The walk also checks what the panel says and how it behaves: Wrapped's figures against the plays it seeded, keys that
stay put when the music pauses or a track gets ready, one order of keys in every list, every choice made in the
brand's blue, each scrolling edge fading where more lies beyond, the page in the middle of a wide screen, and Copy on a
panel served over plain http.

The walk also looks at listening together: the lyrics beside the player and as a sheet (timed, plain, none found, and
in a contrast theme), the playing card's ⋯ list and a stop after the track, the sleep timer (its choices, and the
listening bar with a timer set while a track plays and while it waits), the Invite dialog (a listening link with its QR
code, a friend's login link), a guest's panel (the player and the queue, the lyrics, its menu), a friend's, guests among
the people listening, and the page of what another app shared, for the host and for a guest. Its lyrics come from the
walk itself, as the server's would: the walk reaches no site, and its server would ask LRCLIB.

The unit tests read LRCLIB's answers in their real shapes (`tests/fixtures/lrclib`, read once from LRCLIB, with
made-up songs and words in place of real ones), take requests through a real address guard to a site of the test's
own (HTTPS with a certificate made by openssl, skipped without it), try every way in a guest must not reach, and check
the panel's QR codes against one that a separate decoder read back.

## Measurements

`tests/perf/measure.sh` starts a throwaway jukecord with a server used every day for a year (a thousand different
tracks, all of them queued, 10,000 plays and three playlists: `tests/perf/seed.ts`), under the limits `compose.yaml`
sets (1 GiB of memory, read-only, no capabilities) and on two processor cores unless told otherwise. Nothing reaches
the internet or Discord. On two cores of a desktop processor, while other work kept the machine busy, jukecord 0.4.0
gave:

| What                                                                 | Measured                                                                               |
| :------------------------------------------------------------------- | :------------------------------------------------------------------------------------- |
| Memory at rest, and after the reads below                            | 90 MiB, 102 MiB                                                                        |
| The player, the playlists, the status, recently played (50)          | about 1 ms each (the median of 20)                                                     |
| The queue, a thousand tracks (328 KiB)                               | 7 ms                                                                                   |
| Statistics over 30 days, over a year                                 | 3 ms, 15 ms                                                                            |
| The live state a panel gets for that queue                           | 329 KiB of JSON, sent as 42 KiB (gzip)                                                 |
| A four-minute track, its loudness evened out and encoded             | 4.1 s                                                                                  |
| A thousand panels connected while the queue changes 3 times a second | all stay connected; a change reaches a panel in 74 ms (the median; the slowest 159 ms) |
| The server during that crowd                                         | up to 77 % of one core, 125 MiB                                                        |

Another run gave the same within 2 MiB and 15 ms (4.4 s for the encoding). 0.3.4, measured right before on the same
machine, rested at 88 MiB and took the same times, but for a year's statistics: 24 ms, where 0.4.0's SQL takes 15.
Measured while the machine was quieter, 0.2.1 rested at 78 MiB and its crowd saw a change in 29 ms (the median; the
slowest 105 ms): the crowd's times follow how busy the machine is.

The crowd is `tests/perf/crowd.ts` in a container of its own, so its thousand panels come from one address as they do
through a reverse proxy (the server is told it is behind one): each panel asks for gzip frames as a browser does, and
a change is timed from the request that makes it to the frame that carries it. The server runs this checkout's source
the way the image does, with the types already stripped. `tests/perf/measure.sh 2 0` leaves the
crowd out; a first number sets the cores. Before 0.2.0, which sends each change once for every panel, two hundred
panels at three changes a second used both cores up and the slowest were cut off.

`node tests/perf/sound.ts <folder>` measures what the voice channel's sound costs: a four-minute track streamed as
the voice output streams it, its ffmpeg timed by its own `-benchmark` and, for a minute read at the voice channel's
pace, from `/proc`. In the image on two cores of a desktop processor (`docker run --cpus 2`, this checkout mounted):

| The voice stream                                    | Processor per second of sound | One core at the voice channel's pace |
| :-------------------------------------------------- | :---------------------------- | :----------------------------------- |
| Plain, from the top (the cached file as it is)      | none                          | none                                 |
| From the middle (a seek: decoded and encoded again) | 14.6 ms                       | 1.7 %                                |
| More bass                                           | 16.1 ms                       | 1.9 %                                |
| Night mode, at 80 %                                 | 20.2 ms                       | 2.4 %                                |
| Clearer voices, at 150 % (with the limiter)         | 22.5 ms                       | 2.9 %                                |

A stream with a sound has its first sound ready 21 ms after it starts (the median of five), so a change of volume or
sound is heard at once.

### The database

Moving the store to promises kept SQLite's speed. On the data `tests/perf/seed.ts` makes (a thousand tracks queued,
10,000 plays), timed in one process against 0.3.4's store:

| Call                         |    0.3.4 | with promises |
| :--------------------------- | -------: | ------------: |
| The queue, a thousand tracks |   3.9 ms |        3.5 ms |
| Saving a player's state      | 0.025 ms |      0.008 ms |
| Statistics                   |  2.46 ms |       2.46 ms |
| Wrapped                      |  17.8 ms |       15.7 ms |
| A thousand tracks reordered  |   2.6 ms |        3.2 ms |

The SQL the three databases share, and writing a queue's rows a hundred at a time, followed: on SQLite a 500-track
insert and its removal went from 4.7 to 2.1 ms, and a thousand tracks reordered from 1.8 to 2.3 ms. The same 88 API
requests, and the live updates during them, gave the same answers from 0.3.4 and from the asynchronous store on copies
of one database, and again from 0.4's one process and from a core with an edge.

`jukecord db copy` took the same data, 12,571 rows, from SQLite to PostgreSQL 18 in 0.6 s, from there to MySQL 8.4 in
0.5 s, and back to SQLite in 0.1 s, every column of every table the same at the end.

## On arm64 without an arm64 machine

CI builds and runs the image on an arm64 runner. On an amd64 machine the arm64 image runs under QEMU
(`docker run --privileged --rm tonistiigi/binfmt --install arm64`, removed again with `--uninstall qemu-aarch64`)
with one setting, `-e NODE_OPTIONS=--disable-wasm-trap-handler`. Without it Node can stop in its WebAssembly code
(`ERR_INTERNAL_ASSERTION: memory access out of bounds`; it was seen in the code that strips the types of a `.ts` file,
which the tests and the walk's scripts still run, while the image carries JavaScript). The setting makes Node check
WebAssembly memory bounds in code instead of through memory faults, and under QEMU only the first works. A real arm64
machine needs nothing.

## By hand

Before a release, on a test server: play a track to the end in a voice channel, listen to the same track in Chrome and
Safari at the same time, and seek, skip and pause from Discord, the panel and the command line.
