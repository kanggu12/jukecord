# Decisions

Why jukecord is built the way it is, one decision at a time. Each says what was chosen, what else was looked at, and
why.

## TypeScript run as it is

Node 24 runs `.ts` files by stripping the types, so the server has no build step and the image runs the source. Only
syntax that can be stripped is used (no enums, namespaces or parameter properties), which `tsc` checks
(`erasableSyntaxOnly`). Type checking is TypeScript 7; linting and formatting are Biome (typescript-eslint did not yet
support TypeScript 7). The panel is bundled with esbuild, since browsers need JavaScript.

## Node's own SQLite

`node:sqlite` needs no native add-on, so nothing is compiled when the image is built for arm64 and nothing breaks when
Node is upgraded. It is still marked experimental in Node 24, so every query lives in one file (`src/store/store.ts`):
if its interface changes, that file changes.

## Ogg Opus through to Discord

Discord's voice carries Opus. Preparing every track as Ogg Opus once means voice sends the file as it is, with no
encoder in the process and no native Opus module (a common source of build failures on arm64). The same file is what
browsers play.

## yt-dlp's own build, run with the image's Node

yt-dlp needs a JavaScript runtime for YouTube. Its official single-folder build carries Python and everything else it
needs; jukecord passes it the Node it already runs on (`--js-runtimes node`), so the image has no Python and no Deno.
The version and its checksum are pinned in the Dockerfile; a newer release comes with a newer image, and
`jukecord doctor` says when one is out.

## A proxy in front of yt-dlp

Anyone who may add tracks chooses an address that the server then fetches. Checking that address is not enough:
yt-dlp follows redirects and fetches what a playlist lists, and a name can resolve to one address for the check and
another for the fetch. A proxy that yt-dlp must use sees every connection and connects only where it checked, which
covers all of them with one rule and no change to yt-dlp. For a media server on the local network,
`JUKECORD_ALLOW_PRIVATE_ADDRESSES` turns the rule off.

## Debian, not Alpine

The image is Node 26 on Debian 13, pinned by digest. Alpine would be smaller, but musl's resolver has failed name
lookups in Kubernetes clusters, which the Helm chart is for. Debian's ffmpeg (with libopus and libmp3lame) is smaller
than the static builds that would be needed elsewhere.

## One process, one replica

A bot token allows one gateway session, and the data is one SQLite file, so the chart runs exactly one pod with the
Recreate strategy. Scaling out would need a shared database and one bot process elected among many; a music bot for a
group of friends does not need it.

## Logins without passwords

There is no password to set or leak. The host proves itself by being able to read the host token in the data
directory (its command line does that) and hands browsers one-time links. Everyone else logs in with Discord, asking
only for their identity; membership and roles come through the bot. Every secret jukecord makes is 32 random bytes
stored as a SHA-256 hash.

## The queue is the server's, not the voice channel's

The player keeps going without a voice connection, so a server can listen in browsers only, the bot can leave an
empty channel without stopping the music, and jukecord runs without any bot at all (browser-only). Leaving voice only
stops sending sound nobody is there to hear.

## Four ways in, one list of actions

Features that appear in only one place are the usual way a bot's panel and its commands drift apart. Making every
feature an action, and checking at compile time and in tests that each way in offers every action, makes that drift a
failing build instead of a bug report.
