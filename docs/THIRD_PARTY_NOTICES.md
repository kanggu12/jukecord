# Third-party notices

jukecord itself is MIT-licensed ([LICENSE](../LICENSE)). It uses the following, each under its own licence.

## In the container image

| Part                                                                                                                                                                                                                                         | Licence                                                                                                                                  | Where its source is                             |
| :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------- |
| [Node.js](https://nodejs.org) 26 (the official `node:26-trixie-slim` image)                                                                                                                                                                  | MIT, with the licences of its bundled parts                                                                                              | https://github.com/nodejs/node                  |
| [FFmpeg](https://ffmpeg.org) 7.1.5, built in the image for audio (its configure line is in `deploy/docker/Dockerfile`, its licence and where its source is in `/usr/local/share/doc/ffmpeg`)                                                 | LGPL-3.0-or-later, with no GPL parts                                                                                                     | https://ffmpeg.org/releases/ffmpeg-7.1.5.tar.xz |
| Opus, LAME, OpenSSL and zlib, the libraries FFmpeg is built with (Debian's packages)                                                                                                                                                         | BSD-3-Clause, LGPL-2.0-or-later, Apache-2.0 and Zlib                                                                                     | https://sources.debian.org                      |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp), its official Linux build, which bundles Python and the libraries it uses; each one's licence text, and where its source is, are in `/opt/yt-dlp/_internal/THIRD_PARTY_LICENSES.txt` in the image | Unlicense; the bundled parts under their own licences, GNU Readline under GPL-3.0-or-later and mutagen under GPL-2.0-or-later among them | https://github.com/yt-dlp/yt-dlp                |
| Debian 13 base packages (tini, ca-certificates, libopus0, libmp3lame0 and their dependencies)                                                                                                                                                | their own licences, listed in `/usr/share/doc/*/copyright` in the image                                                                  | https://sources.debian.org                      |

jukecord runs FFmpeg and yt-dlp as separate programs; it does not link to them. A database server, Redis or Valkey,
Prometheus and Grafana, which the Compose files in `deploy/split` and `deploy/monitoring` run beside jukecord, are images
of their own, under their own licences, and are not part of jukecord's image.

## In the release's programs

Each program (`jukecord-<version>-<system>-<processor>`, [without Docker](INSTALL.md#without-docker)) carries
jukecord's server, command and panel as in the image, and beside them:

| Part                                                                                                                                                                                                                                     | Licence                                                         | Where its source is                                   |
| :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------- | :---------------------------------------------------- |
| [Node.js](https://nodejs.org) 26, the official build for each system and processor (`lib/node`, with its `LICENSE`)                                                                                                                      | MIT, with the licences of its bundled parts                     | https://github.com/nodejs/node                        |
| [FFmpeg](https://ffmpeg.org) 7.1.5, built for audio with the image's configure line by `deploy/bundle/ffmpeg.sh` (`lib/ffmpeg`: its licence, and `SOURCE`, which says where each part's source is)                                       | LGPL-3.0-or-later, with no GPL parts                            | https://ffmpeg.org/releases/ffmpeg-7.1.5.tar.xz       |
| Opus, LAME and zlib, and on Linux OpenSSL, the libraries in that FFmpeg, built from their releases (their licences in `lib/ffmpeg/licenses`)                                                                                             | BSD-3-Clause, LGPL-2.0-or-later, Zlib and Apache-2.0            | the addresses in `lib/ffmpeg/SOURCE`                  |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp), its official build for each system, which bundles Python and the libraries it uses; each one's licence text, and where its source is, are in `lib/yt-dlp/_internal/THIRD_PARTY_LICENSES.txt` | Unlicense; the bundled parts under their own licences, some GPL | https://github.com/yt-dlp/yt-dlp                      |
| libatomic, which Node.js loads on Linux: Debian's libatomic1 14.2.0-19 (`lib/node/lib`, with its licence, the exception and `libatomic-SOURCE`)                                                                                          | GPL-3.0-or-later with the GCC Runtime Library Exception 3.1     | https://snapshot.debian.org/package/gcc-14/14.2.0-19/ |
| The npm packages below, installed for the system (the build of @snazzah/davey for it)                                                                                                                                                    | as below                                                        | their folders under `lib/app/node_modules`            |

Each program carries this file as its `THIRD_PARTY_NOTICES.md`. It runs FFmpeg and yt-dlp as separate programs too.

## npm packages the server runs

| Package                                                                                         | Licence                                                    |
| :---------------------------------------------------------------------------------------------- | :--------------------------------------------------------- |
| discord.js, @discordjs/voice and their @discordjs packages                                      | Apache-2.0                                                 |
| @snazzah/davey (Discord's end-to-end voice encryption)                                          | MIT                                                        |
| fastify, @fastify/websocket and @fastify/static                                                 | MIT                                                        |
| typebox                                                                                         | MIT                                                        |
| ws                                                                                              | MIT                                                        |
| pg, with pg-pool and pg-protocol (PostgreSQL; loaded only for a `postgres://` database address) | MIT                                                        |
| mysql2 (MySQL and MariaDB; loaded only for a `mysql://` or `mariadb://` address)                | MIT                                                        |
| @redis/client (the bus and the shared cache on Redis or Valkey; loaded only for their address)  | MIT                                                        |
| openid-client, with oauth4webapi and jose (logging in through an identity provider)             | MIT                                                        |
| ldapts (logging in with a directory account)                                                    | MIT                                                        |
| the remaining dependencies                                                                      | MIT, ISC, Apache-2.0, BSD-3-Clause, 0BSD and BlueOak-1.0.0 |

`npm ls --omit=dev --all` lists every package with its version; each one's licence is in its folder under
`node_modules`.

## In the panel

| Part                                                                                                       | Licence                                                      |
| :--------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------- |
| [Pretendard](https://github.com/orioncactus/pretendard) 1.3.9, the font's dynamic subset files (unchanged) | SIL Open Font License 1.1, served with the font as `OFL.txt` |
| [Lucide](https://lucide.dev) 1.60.0 icons (the shapes of the icons the panel uses)                         | ISC                                                          |

## For development only

TypeScript (Apache-2.0), Biome (MIT or Apache-2.0), esbuild (MIT) and Playwright (Apache-2.0, in the panel's tests) are
used to build and check jukecord and are not part of what it ships.
