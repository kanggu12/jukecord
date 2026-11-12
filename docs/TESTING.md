# Testing

| Suite            | Command                                      | What it covers                                                                                                                                                                                                                                                                                                                 |
| :--------------- | :------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit             | `npm run test:unit`                          | settings, units and times, the database and its migrations, the queue, the player's states, the cache, yt-dlp's output, the actions and their limits, who may do what, logins and tokens, the API through Fastify's inject, the parity of the four ways in, the statistics, the self-check                                     |
| integration      | `npm test` (with the unit tests)             | real ffmpeg with a fake yt-dlp: fetching, converting, seeking, retrying; the voice channel's sounds; live updates over a real WebSocket; the web server's own limits; the `jukecord` command against a real server                                                                                                             |
| packaging        | `node --test "tests/packaging/**/*.test.ts"` | one version everywhere, the changelog, the API document, the Dockerfile (pins, file modes, labels, what the panel's stage copies), the Compose file's limits, the front door's help, the chart (lint, template, the values it refuses, kubeconform when installed), the workflows (pins, the release's checks) and the scripts |
| the panel        | `tests/ui/run.sh <folder>`                   | every state at eight window sizes, both themes and both languages, measured; the browser playing along                                                                                                                                                                                                                         |
| measurements     | `tests/perf/measure.sh [cores] [panels]`     | a server used every day for a year, on two processor cores: memory, the panel's reads, a track's encoding, a crowd of a thousand panels                                                                                                                                                                                        |
| the chart        | `deploy/kind/check.sh <image>`               | the chart on a throwaway kind cluster                                                                                                                                                                                                                                                                                          |
| everything quick | `npm run check`                              | lint, types, unit and integration tests                                                                                                                                                                                                                                                                                        |

The integration tests need ffmpeg with libopus; they are skipped (and say so) without it. Nothing in the tests talks
to Discord, YouTube or any other site: yt-dlp is replaced by `tests/support/fake-yt-dlp.mjs`, Discord's API by fakes,
and every example address is on example.com or media.example. What YouTube, Deezer, Spotify and Apple Music answer
(a search, a mix, Deezer's track, album and playlist, a Spotify and an Apple Music track's page) was read once from
the real services and is kept in `tests/fixtures` in its real shape, with every value made up.

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
drawn over other text, a key whose words run out of its box, contrast below 4.5:1 (with translucent layers
composited), rows and columns to half a pixel (the controls of one row at one height and one centre with the labels
and words in it, an icon on the centre of the first line of its words, cards side by side at one top and one bottom,
the children stacked in one container at one left edge and the boxes ending them at one right edge, words side by side
on one baseline, every padding, margin and gap on the spacing scale), floating layers that cut across other boxes, a
sheet, a dialog or a toast that something else covers, a page wider than the screen, a badge whose word breaks out of
it, the playing card's keys leaving one key alone on a row, a list in a card with room for fewer than three rows, a
box that scrolls with nothing in it the keyboard can stop on, a state told by a fill alone drawn like its absence (as
a contrast theme paints), keys and cards under a screen's notch or home bar, touch targets under 44 pixels (keys,
fields, the switch, the sliders and the seek bar, the logo), and a listen bar pushed off the foot of the window (a
page that ran past the window and scrolled its bars with it). On the pages it photographs it also runs axe-core's
accessibility rules (names, roles, landmarks, headings). It also counts, for each page, the different font sizes,
control heights, corner radii, paddings and gaps it shows, into the report and a summary at the walk's end: the fewer,
the more the panel reads as one system. It also presses **Listen here** and waits for the browser to be in time with
the server. `tests/ui/verdict.mjs` fails on any finding; the pictures land in the folder given.

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
the internet or Discord. On two cores of a desktop processor, jukecord 0.2.1 gave:

| What                                                                 | Measured                                                                               |
| :------------------------------------------------------------------- | :------------------------------------------------------------------------------------- |
| Memory at rest, and after the reads below                            | 78 MiB, 93 MiB                                                                         |
| The player, the playlists, the status, recently played (50)          | about 1 ms each (the median of 20)                                                     |
| The queue, a thousand tracks (328 KiB)                               | 5 ms                                                                                   |
| Statistics over 30 days, over a year                                 | 2 ms, 19 ms                                                                            |
| The live state a panel gets for that queue                           | 329 KiB of JSON, sent as 42 KiB (gzip)                                                 |
| A four-minute track, its loudness evened out and encoded             | 3.4 s                                                                                  |
| A thousand panels connected while the queue changes 3 times a second | all stay connected; a change reaches a panel in 29 ms (the median; the slowest 105 ms) |
| The server during that crowd                                         | up to 71 % of one core, 112 MiB                                                        |

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
| Softer at night, at 80 %                            | 20.2 ms                       | 2.4 %                                |
| Clearer voices, at 150 % (with the limiter)         | 22.5 ms                       | 2.9 %                                |

A stream with a sound has its first sound ready 21 ms after it starts (the median of five), so a change of volume or
sound is heard at once.

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
