# Decisions

Why jukecord is built the way it is, one decision at a time. Each says what was chosen, what else was looked at, and
why.

## TypeScript run as it is

Node 24 runs `.ts` files by stripping the types, so the server has no build step: a checkout runs as it is. Only
syntax that can be stripped is used (no enums, namespaces or parameter properties), which `tsc` checks
(`erasableSyntaxOnly`). The image carries the same source with the types already stripped, as `.js` files
(`scripts/strip-types.ts`, with Node's own `stripTypeScriptTypes`). Stripping on every start loads Node's TypeScript
parser into each process: in the image on two cores the server rested at 96 MiB that way and rests at 78 MiB now,
and a `jukecord` command took 150 ms and takes 100 ms. The stripping leaves spaces where the types were, so every
line and column of a `.js` file is the same place in its `.ts` file, and a stack trace from the image points into
the source. A bundle, as the panel has, would have put the server into one file with other line numbers. Type checking is TypeScript 7; linting and formatting are Biome (typescript-eslint did not yet
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
lookups in Kubernetes clusters, which the Helm chart is for.

## FFmpeg built for audio

Debian's ffmpeg package brings the libraries of every codec and device FFmpeg supports: 451 MB of an 843 MB image,
for a program that jukecord asks to read audio and write Opus and MP3. The image builds FFmpeg 7.1.5 from its signed
release instead: every demuxer, decoder, parser, protocol and audio filter of FFmpeg's own (whatever yt-dlp hands
over, from a pipe or over https), the Opus, MP3 and PCM encoders, and four libraries (Opus, LAME, OpenSSL, zlib). It is one
21 MB program, LGPL with no GPL parts, and the image is 423 MB. The two were compared on sixteen kinds of file (audio
alone, and the audio of video files) through jukecord's own commands: the same results, lengths and loudness. CI
runs the three commands on each architecture's image and fails an image over 500 MB. Debian's security updates no
longer reach FFmpeg by themselves: a weekly check (`.github/workflows/ffmpeg-release.yml`) fails when a newer release of
the pinned line is out, and a patch release of jukecord brings it.

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

## Glass, lit by the music

The panel is frosted glass over a field of light, and the light is the music's own: the cover of the track playing,
blurred far out of shape behind the cards and again as a glow behind the turning disc. Nothing playing, the field
rests near grey. So the panel has colour without a colour scheme of its own to wear out, and what plays now is the
first thing seen. The rainbow of the mark means one thing, "playing now": it travels round the disc's rim and runs
along the progress bar, and rests white when paused. Other colour is kept for meaning: the state of the player and the
connection, and removing.

The cards carry no backdrop blur. The only thing behind a card is the field, which is blurred already; blurring it
again under every card would cost a phone its smooth scrolling for nothing seen. The bars and the sheets, which content
passes under, do blur. The field's picture is drawn at a tenth of the window and scaled up, since blurring a small
picture costs far less than a large one, and it changes only when the track does. Everything that moves all the time
(the disc, its rim, the glow's slow breathing) changes only position, size and opacity, which a browser animates
without drawing anything again; the menu's motion switch and the system's own setting stop all of it, and the system's
setting for less transparency turns the glass solid.

## Live messages made once, not compressed per connection

The panel replaces its whole queue with every queue message, which keeps it simple and always right, but a
thousand-track queue is about 350 KB of JSON. With the WebSocket's per-message compression, every change was
compressed again for every panel (about 3 ms of a processor each) and every connection kept a compressor (about a
quarter of a MiB): on two cores, 200 panels at three changes a second used the machine up and the slowest panels were
cut off. Sending only what changed would be smaller still, but every panel would then have to apply changes in order
and ask again after a gap. Instead the queue's messages are combined (at most four a second, each with the latest
queue) and each message is compressed once, as gzip that the browser unpacks itself (`DecompressionStream`), and sent
as the same bytes to every panel; a client that cannot unpack gzip gets the JSON as text.

## Rates per login and address, and shedding by the event loop's delay

One script, or a crowd pressing skip, could make jukecord do more than one process can: each skip starts yt-dlp and
ffmpeg, and each change goes out to every panel. Changes are held to a rate per login and per address, so one source
cannot crowd out the others, and the host (its own command line) is not held to it. When jukecord is behind anyway,
the measure is the event loop's delay rather than the processor's use: a busy processor is fine while the loop keeps
up, and the loop's delay is what the voice of every server and every panel feel. Work that can be asked for again in
a moment (audio, changes) is then turned away at once with 503, which costs almost nothing, instead of being queued
behind work nobody can see.

## The voice channel's sound: ffmpeg only while it is not plain

The cached file goes to Discord as it is: that costs no processor and loses nothing (see Ogg Opus through to
Discord). A volume other than 100 % or a sound (more bass, clearer voices, brighter, softer at night) changes the sound
itself, which has to be decoded, filtered and encoded again. ffmpeg does that, for that server's voice stream only and
only while its sound is not plain, from the place the track is: the process a seek already starts, with the sound's
filters added. @discordjs/voice can change a volume itself, but only of sound it decodes and encodes again in the
process, with an Opus encoder there (a native module, or a slower WebAssembly one), which the image does without.

In the image on two processor cores, a stream with a sound took 16 to 23 ms of processor per second of sound when
encoded as fast as it goes, and 1.9 to 2.9 % of one core read at the voice channel's pace (the most with the limiter
above 100 %); a stream from the middle of a track, which a seek has always started, 14.6 ms and 1.7 %; a plain one,
none (`node tests/perf/sound.ts <folder>`). Opus encoded a second time at 128 kbit/s is not heard.

A change starts the voice stream again where the player's clock is, with the seek's short fade in: the new stream's
first sound is ready about 20 ms after it starts in the image (0.2 s with an older FFmpeg on a busy machine). Changes
closer together than 0.4 s (a volume moved step by step) are one, the last. Changing the filters of the ffmpeg
already running would be heard only after the seconds of sound already encoded and waiting in the pipe.

The sounds are a gain and the Audio EQ Cookbook's shelves and peak, which ffmpeg's `lowshelf`, `highshelf` and
`equalizer` and the browsers' `BiquadFilterNode` compute with the same formulas, so a browser listening along hears
the curve the voice channel hears (ffmpeg's is checked against the formulas, within 0.15 dB at seven frequencies, in
`tests/integration/sound.test.ts`). A compressor for the night sound was left out: ffmpeg's and the browsers'
compressors work differently, so the two would not sound the same, and the cached tracks' loudness range is held to
11 LU already. A sound that lifts a band lowers everything first, by the lift less 1 dB, so what it plays stays under
0 dB (the cached peaks are under -1 dB); above 100 % the voice channel's volume passes a limiter at -1 dB. A browser
hands its audio to WebAudio only once a sound is on, and keeps it there (an element can be handed over once); its own
volume then comes after the sound, as the voice channel's volume does.
