# Third-party notices

jukecord itself is MIT-licensed ([LICENSE](../LICENSE)). It uses the following, each under its own licence.

## In the container image

| Part                                                                        | Licence                                                                      | Where its source is                                                             |
| :-------------------------------------------------------------------------- | :--------------------------------------------------------------------------- | :------------------------------------------------------------------------------ |
| [Node.js](https://nodejs.org) 26 (the official `node:26-trixie-slim` image) | MIT, with the licences of its bundled parts                                  | https://github.com/nodejs/node                                                  |
| [FFmpeg](https://ffmpeg.org) 7.1, Debian's package                          | LGPL-2.1-or-later, with GPL-2.0-or-later parts as Debian builds it           | `apt-get source ffmpeg` on Debian 13, or https://sources.debian.org/src/ffmpeg/ |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp), its official Linux build        | Unlicense; the build bundles Python and other parts under their own licences | https://github.com/yt-dlp/yt-dlp                                                |
| Debian 13 base packages (tini, ca-certificates and their dependencies)      | their own licences, listed in `/usr/share/doc/*/copyright` in the image      | https://sources.debian.org                                                      |

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

| Part                                                                                | Licence                                                        |
| :---------------------------------------------------------------------------------- | :------------------------------------------------------------- |
| [Pretendard](https://github.com/orioncactus/pretendard) 1.3.9, the font (unchanged) | SIL Open Font License 1.1, served beside the font as `OFL.txt` |
| [Lucide](https://lucide.dev) 1.60.0 icons (the shapes of the icons the panel uses)  | ISC                                                            |

## For development only

TypeScript (Apache-2.0), Biome (MIT or Apache-2.0), esbuild (MIT) and Playwright (Apache-2.0, in the panel's tests) are
used to build and check jukecord and are not part of what it ships.
