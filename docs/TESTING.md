# Testing

| Suite            | Command                                      | What it covers                                                                                                                                                                                                                                                                             |
| :--------------- | :------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit             | `npm run test:unit`                          | settings, units and times, the database and its migrations, the queue, the player's states, the cache, yt-dlp's output, the actions and their limits, who may do what, logins and tokens, the API through Fastify's inject, the parity of the four ways in, the statistics, the self-check |
| integration      | `npm test` (with the unit tests)             | real ffmpeg with a fake yt-dlp: fetching, converting, seeking, retrying; live updates over a real WebSocket; the `jukecord` command against a real server                                                                                                                                  |
| packaging        | `node --test "tests/packaging/**/*.test.ts"` | one version everywhere, the changelog, the API document, the Dockerfile's pins, the chart (lint, template, kubeconform when installed), the workflows and the scripts                                                                                                                      |
| the panel        | `tests/ui/run.sh <folder>`                   | every state at eight window sizes, both themes and both languages, measured; the browser playing along                                                                                                                                                                                     |
| the chart        | `deploy/kind/check.sh <image>`               | the chart on a throwaway kind cluster                                                                                                                                                                                                                                                      |
| everything quick | `npm run check`                              | lint, types, unit and integration tests                                                                                                                                                                                                                                                    |

The integration tests need ffmpeg with libopus; they are skipped (and say so) without it. Nothing in the tests talks
to Discord, YouTube or any other site: yt-dlp is replaced by `tests/support/fake-yt-dlp.mjs`, Discord's API by fakes,
and every example address is on example.com or media.example.

## The panel

`tests/ui/run.sh` seeds a throwaway jukecord with made-up tracks, people and a month of history
(`tests/ui/seed.ts`), starts it, and walks the panel in Playwright's Chromium (`tests/ui/walk.mjs`): idle, playing,
paused, loading, a failed track, a lost connection, the menu, the dialogs, the statistics with a tooltip open, the log,
the login page, an empty queue and a 200-track one, at 360 to 2560 pixels wide. On phones and the tablet it also plays
the longest title and raises a toast, where width is shortest. The panel with a Discord bot is walked
too: a made-up server, its voice channels and people listening in browsers are put between the page and the server,
which runs browser-only. The README's pictures come from the same walk. `tests/ui/audit.js` measures each page:
text that is clipped or drawn over other text, a key whose words run out of its box, contrast below 4.5:1 (with
translucent layers composited), controls on one row that differ in height or centre, floating layers that cut across
other boxes, a sheet or dialog that something else covers, a page wider than the screen, a badge whose word breaks
out of it, and touch targets under 44 pixels (keys, fields, the switch, the sliders and the seek bar, the logo). On the pages it photographs it also runs axe-core's accessibility
rules (names, roles, landmarks, headings). It also presses **Listen here** and waits for the browser to be in time
with the server. `tests/ui/verdict.mjs` fails on any finding; the pictures land in the folder given.

## On arm64 without an arm64 machine

CI builds and runs the image on an arm64 runner. On an amd64 machine the arm64 image runs under QEMU
(`docker run --privileged --rm tonistiigi/binfmt --install arm64`, removed again with `--uninstall qemu-aarch64`)
with one setting, `-e NODE_OPTIONS=--disable-wasm-trap-handler`. Without it Node stops while reading jukecord's
source (`ERR_INTERNAL_ASSERTION: memory access out of bounds`, in the WebAssembly code that strips the types). The
setting makes Node check WebAssembly memory bounds in code instead of through memory faults, and under QEMU only the
first works. A real arm64 machine needs nothing.

## By hand

Before a release, on a test server: play a track to the end in a voice channel, listen to the same track in Chrome and
Safari at the same time, and seek, skip and pause from Discord, the panel and the command line.
