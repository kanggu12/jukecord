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

## Covers through jukecord

A track's picture is fetched by jukecord, once, and the panel shows it from jukecord's own address. Before, every
browser fetched each picture from the site it is on: every listener's address went to the image hosts, the content
security policy had to allow pictures from anywhere, and a picture from another origin cannot be drawn into a canvas
that is then read back, which Wrapped's "Save as picture" does. Fetching through jukecord costs one request per track,
under the same rule as every other fetch (the name resolved by jukecord, public addresses only, the connection made to
the address checked, a redirect checked again) and with limits of its own (2 MiB, ten seconds, a few at once, picture
formats told by their own bytes, never SVG, which can carry script). The pictures live in the media cache beside the
audio and count towards its limit, each by its own last use: the history and Wrapped show covers of tracks whose audio
went long ago. Discord's cards keep the site's address: Discord fetches pictures itself, through its own proxy, and
cannot reach jukecord.

## The song of the year

Wrapped's song of the year is the track played on the most days, then the most times. The most played track already
leads the top five; a track played fifty times in one night would lead by plays, while the one that came back week
after week is the one people mean. Wrapped is counted from the history, which keeps a server's newest 10,000 plays, so
for a busier server a year may start later than its first day; the page, the card and the command say from when.

## Reads per person, changes per login and address

Many people often share one address (a household, an office, Docker's bridge, a proxy not told about): counted by it,
fifteen panels opening at once there had a third of their reads refused. So a logged-in read counts against the
person behind it alone, all their logins and tokens together, and a read without a login against its address.
Changes keep both, the login's and the address's: they cost more, and a refusal after a lookup (a search that found
nothing) keeps its share of the address spent, so several tokens behind one address do not take the address's brake
away.

## Resting pauses, and only people play on

A server nobody hears anywhere (the bot out of voice, no browser playing along) went on fetching tracks and counting
plays for nobody. After two minutes of that its player pauses with a notice saying why. It does not play on by itself
when someone comes back (the bot joining voice, a browser pressing Listen here): sound starting by itself surprises
people, the reason a restart comes back paused too, and pressing play is one step. A bot that stays in voice sounds in
the channel, which counts as heard.

## Coming back to voice where people are

After a restart the bot goes back to the voice channel it was in only when people are in it at that moment. Going
back later, when someone happens to enter the channel hours after a reboot, would be the bot turning up by surprise;
so a kept channel with nobody in it is forgotten. A server that asked the bot to stay in voice (its stay setting) is
the exception: there the bot goes back with nobody in the channel, since it would have stayed had jukecord not
restarted.

## Alerts once an hour, in a channel the server chooses

Trouble used to be in the log alone, which the people of a Discord server do not read. Each server chooses a channel
(or none, the default), and jukecord says there what happened, with the figures and nothing more: each kind at most
once an hour per server, and a state that lasts (YouTube's check for bots) once as it starts and once as it ends, so a
bad day is a few lines, not one per failed fetch. A webhook was the other choice; a channel the bot posts in needs no
secret to keep, and the bot is there already.

## Lyrics from LRCLIB

LRCLIB is free, needs no key, keeps timed lyrics (LRC) beside the plain ones, and asks only that a client says what it
is and goes gently. The other sources either need an account and a key per installation, or answer with plain words
only, or scrape pages. jukecord asks for the track playing only when someone opens its lyrics (never ahead, never for a
track nobody plays), once per track: what LRCLIB found is kept in the database for good, and that it found nothing for
a week, after which it is asked again (LRCLIB fills in songs it lacked). It sends the song's title, artist, album and
length: what YouTube says the recording is when it says (yt-dlp's `track`, `artist` and `album`), else what the title
and the channel give with the usual decorations taken off. LRCLIB matches the length within two seconds, which keeps a
guess from finding another song's words. Requests go one at a time, a third of a second apart, and a 429 or 503 holds
them all for as long as it says; they leave through the same address guard as yt-dlp's (a CONNECT tunnel, TLS inside
it to LRCLIB itself), so jukecord reaches only public addresses whoever asks. `JUKECORD_LYRICS=off` turns all of it
off. The panel and the API are given the lines with their times; a person who may change the music can seek to one.

## Listening links for guests

Listening along without Discord was what a host link gave, with every right. A listening link gives the least that
listening needs: one server, the player, the queue and the lyrics, the audio of what plays or is queued there, for 1, 7
or 30 days. A guest is a login of its own kind, with its own table of sessions (in the sessions table a login without
a user is the host's, so a guest there would have been one row's mistake from every right), and the server answers a
guest's request for any other operation with a refusal before anything else looks at it: an allow-list, not a list of
what is forbidden, so a new operation is closed to guests until it is opened. The code is 32 random bytes kept as a
hash; it travels after a `#` in the link, which browsers never send to a server, so it never lands in a server's or a
reverse proxy's log, and the panel's page sends it to jukecord in a request of its own (from the panel's own pages
only). A link takes 25 browsers at most, a server keeps 50 links at most, and failed codes count against an address as
failed logins do. Revoking deletes the link and its guests' sessions, and their live connections end at once.

## Friends let in by the host

In browser-only mode every friend needed the host's own link. A login link can now be made for a friend who may only
look and listen, or also change the music: a session of kind `friend` with that scope, never Manage Server, never
tokens, and held to the rates and the caps on live connections as anyone but the host is. It is the host's way in, so
it reaches every server the host has, and what a friend adds counts as the host's.

## A light that follows the music, read without touching the sound

The light needs the music's low end, which only WebAudio can measure. Routing the panel's audio element through an
AudioContext (createMediaElementSource) would make the sound itself depend on WebAudio: on a phone that suspends audio
contexts in the background, listening on a locked screen would stop. So the analyser reads a copy of the element's
stream (captureStream), and the sound plays as it always did. Browsers without it (Safari, and Firefox, whose
mozCaptureStream silences the element it copies) keep the glow's slow breathing. Only opacity changes, 20 times a second
at most, on a timer, and only when the change shows: the glow seems to swell because a wider layer of it fades in on the
loudest beats. Measured in Chromium on a GPU (ten seconds of listening, a bass line playing), a first version that
changed opacity and scale at every animation frame took the main thread 1.5 to 1.9 s, against 0.2 s for the panel
without it: asking for every frame made the browser run its style and layer passes 60 times a second whether or not
anything had changed, and each change of scale made it sort its layers anew. This one took 0.54 s in the same
conditions, with about 18 style passes a second (8 without it, 64 for the first version) and the same frames, paints and
layouts as without it; on a busy machine its time stays within the spread of the panel's own. Nothing runs, the audio
context suspended, while the tab is hidden, the music is paused or not heard here, or motion is off: at rest the panel
does exactly what it did before (paused: no frames, style passes, layouts or paints, as without it).

A sound for the voice channel (see below) has a browser hand its audio element to WebAudio, and an element can be handed
over only once. From then on the light reads the music there, in the page's one AudioContext, with the sound on it and
before the browser's own volume (as the copy of the stream was); the copy is stopped, and the context stays awake for
the music while the light rests. One context for both, not one each: every running context is a stream of its own to the
sound hardware, and a phone's battery pays for each. A browser without captureStream gets the light this way too, once a
sound is on.

## The panel as an app

A web app manifest with icons drawn from the mark, and a service worker that keeps only the panel's own files: never
the API, the audio or the logins. It asks jukecord first for each file and uses its copy only when jukecord cannot be
reached, so a new version shows at once as it did without a worker (the panel's "updated: reload" message stays the way
to take it), and an installed panel opened while jukecord is away says so instead of showing the browser's error. The
manifest's share target sends what another app shares to a page of the panel, which adds it on a press of a key: a
page any site can send a browser to must not change the queue by itself.

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

## Search shows what it found, in the add card

Adding the first result of a search blindly was the usual way a wrong song started. Words now show YouTube's results
under the field a moment after typing stops, and Discord's suggestions under `/play` and `/add` show the same. A search
is one flat listing by yt-dlp (titles, channels, lengths and pictures in one request, about a second and a half), in the
resolver's lookup slots and at a rate of its own; it is kept for half an hour by its words and shared while it runs, and
one nobody waits for any more (the next key was typed) is stopped, so typing does not use up the slots. A result picked
is added from what the search learned, with nothing fetched until it plays. The list is part of the add card rather
than a layer over the page, as the panel's other parts are: over the field where the card stands at the foot of a
window that does not scroll (the field stays where the eyes are), under it everywhere else. While it shows there, the
queue keeps three rows in sight on a window taller than 880 px; on a shorter one it keeps its head and gives the
results the room of its rows (a line saying nothing was found takes only what it needs). It is an ARIA combobox and
listbox, so the keyboard and screen readers move through it from the field.

## Autoplay from the server's own plays

When the queue runs out, a recommender service would know what plays and when; jukecord already knows what each server
played and liked. "This server's plays" draws a track from its history, more often the ones played more and liked by
more people, none of the last thirty plays, so it sounds like that server and asks nobody. "Related to the last track"
asks YouTube (through yt-dlp, which the tracks come through anyway) for its mix of the track playing, for a server that
wants something new, and falls back to the history. One track is queued when the last one starts, so it is fetched in
time; its row says Autoplay, people's tracks added at the end go before it, and statistics and Wrapped leave it out of
who added most. It is nobody's turn when people take turns (its tracks stay after people's), and the limit of tracks per
person does not count it. A Stop ends it until a track starts again: the music does not start by itself after someone
stopped it, and a stop asked for after this track is a Stop too. It picks only while the music goes on: a player paused
by a person, or resting with nobody listening, gets its pick when it plays again.

## Likes belong to a login, and show only what a server shows

A like is a person's, so it needs no DJ role, and the list is theirs in every server they open, as a library is. A track
may be liked only where it plays, waits, played or is saved in a playlist of the server: likes are listed with their
titles, and a like by track number alone would let anyone read what other servers played. A login keeps up to a
thousand. A friend the host let in likes as the host, as what it adds counts as the host's; a guest of a listening link
has no likes.

## Links of other services are found on YouTube

Deezer, Spotify and Apple Music do not let a self-hosted program play their audio, and yt-dlp cannot either; their
links still say exactly which songs are meant. jukecord reads the link (Deezer's public API, Spotify's Web API with the
host's own app or a track's public page, an Apple Music track's public page) for each track's title, artists and
length, and searches YouTube for it, keeping the recording within a few seconds of the length (a different length is
usually a live take or a video with a long intro), an official audio upload first, and nothing that names another
version (live, cover, remix) the track does not. A link gives at most a hundred tracks, searched three at a time in
turns shared with imported playlists, apart from the lookups people wait for; the first one plays while the rest are
found.

## jukecord's own requests follow yt-dlp's address rule

Reading a Deezer answer, a Spotify or Apple Music page, or a file attached to `/playlist import` is jukecord fetching
an address someone gave. Those requests resolve the name themselves, refuse it when any of its addresses is on a
private network, connect to the very address checked, and check each redirect again, as the proxy in front of yt-dlp
does; each has a time and a size limit. `JUKECORD_ALLOW_PRIVATE_ADDRESSES` turns the rule off for them as for yt-dlp.
