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

jukecord runs FFmpeg and yt-dlp as separate programs; it does not link to them.

## npm packages the server runs

| Package                                                             | Licence                                                                  |
| :------------------------------------------------------------------ | :----------------------------------------------------------------------- |
| discord.js, @discordjs/voice and their @discordjs packages          | Apache-2.0                                                               |
| @snazzah/davey (Discord's end-to-end voice encryption)              | MIT                                                                      |
| fastify, @fastify/websocket, @fastify/static and their dependencies | MIT                                                                      |
| typebox                                                             | MIT                                                                      |
| ws                                                                  | MIT                                                                      |
| the remaining dependencies                                          | MIT, ISC, Apache-2.0, BSD-2-Clause, BSD-3-Clause, 0BSD and BlueOak-1.0.0 |

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
