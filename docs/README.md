# Using jukecord

jukecord keeps one queue per Discord server and plays it in that server's voice channel and, for anyone who presses
**Listen here**, in their browser at the same place in the track. You can drive it from four places, which all do the
same things: the panel, slash commands in Discord, the `jukecord` command, and the [HTTP API](API.md).

## The panel

Open the panel's address (on the machine running jukecord, `./jukecord open` prints a login link and opens it).

- **Now playing**: the track on a disc that turns while it plays, who added it, a progress bar you can click or drag to
  seek, and the keys: play or pause, skip, stop, repeat (off, the queue, this track) and remove (drops the track
  without counting it as played). The heart beside the title likes the track.
- **Queue**: drag a track by its handle to move it, or use its keys: play now, play next, remove; its **⋯** key also
  likes it (on a phone or in a narrow window, the other keys and the moves wait there too). Above the list: autoplay
  (beside the title), search, shuffle, take turns now (see [the server's settings](#the-servers-settings)), remove
  duplicates, save as a playlist, load a playlist, clear; on a narrow window the queue's tools wait behind the key
  beside **Shuffle**. A long queue shows a hundred tracks at a time (**Show more** brings the next hundred); search
  covers all of it.
- **Add**: paste an address (a video, a playlist, a SoundCloud page, a Deezer, Spotify or Apple Music link ...) or type
  search words. **Add** puts it at the end of the queue, **Play next** right after the track playing, **Play now**
  plays it at once. Words show what YouTube found under the field a moment after you stop typing: press a result to add
  it, or its play now and play next marks; with the keyboard, the arrows choose one and Enter adds it (<kbd>Shift</kbd>
  <kbd>Enter</kbd> plays it next, <kbd>Ctrl</kbd> <kbd>Enter</kbd> now). A link pasted anywhere on the page, or
  dropped on it from another window, is added the same way.
- **Voice channel**: where the bot is, the channels it may join (with how many people are in each), the voice
  channel's volume and sound (see [the sound](#the-voice-channels-sound)), and who is listening in a browser.
- **Recently played** and **Liked** (two lists in one card): what played, and the tracks you liked, each with keys
  to play it now, next or at the end, and its heart; **Add all** puts every liked track in the queue. Likes are each
  login's own, in every server it opens (a track can be liked in a server that plays it, queued it, played it or keeps
  it in a playlist).
- **Statistics** (top bar): plays per day and per hour of the day, the most played tracks, who added most, and the
  time listened, over 7, 30 or 90 days or a year. Each chart has a table view.
- **Wrapped** (a key on the statistics): the server's year in music, or a month, or the last 12 months. The song of
  the year (the track played on the most days), the first track, the plays, hours, tracks and people, the most played
  tracks and who added most, the busiest day of the week and hour of the day, the longest day and the days with music.
  **Save as picture** draws it as a story (1080 by 1920) or a square (1080 by 1080) PNG in the panel's theme and
  language; on a phone, **Share** hands it to the phone. The address names the time: `/stats/wrapped?period=2026-03`.
- **Log** (the host only): jukecord's log, filtered by level and part.
- **The menu** (your name, top right): theme, language, motion, the server's DJ role, settings and alerts channel (for
  people who can manage the server), API tokens, keyboard shortcuts, logging out.
- **Lyrics** (in the playing card's head): the words of the track playing, from LRCLIB, in the right column of a wide
  window and as a sheet on a phone. The line being sung is lit and kept in sight; if you may change the music, choose a
  line to play from there. Words without timings show as they are, and a track LRCLIB does not know says so.
- **⋯** (in the playing card's head): **Stop after this track** stops the player, for everyone, when the track ends;
  the queue stays. Pressed again, the player plays on after it.
- **Invite** (beside the people listening in the voice card, in the ⋯ list and in the menu): a listening link for
  guests and, for the host, a login link for a friend, each with a QR code and a copy key (see
  [who may do what](#who-may-do-what)).
- **The sleep timer** (beside **Listen here** while this browser listens): this browser stops listening after 15, 30 or
  60 minutes, or when the track playing ends; the last seconds fade out. It is this browser's alone.
- **As an app**: in a browser that offers it (Chrome or Edge's install button, Safari's **Add to Home Screen**), the
  panel installs and opens in its own window, and opens when jukecord cannot be reached, saying so. On Android, an
  installed panel is among the apps a video can be shared to: the shared address opens a page that adds it to the
  queue on a press of **Add**, **Play next** or **Play now**.
- **Autoplay** (the **∞** key beside the queue's title, among the tools behind the key beside **Shuffle** on a narrow
  window): what plays when the queue runs out. Off; **this server's plays**, a track played here before (the more it
  was played and the more people liked it, the more often; none of the last 30); or **related to the last track**, from
  YouTube's mix of it (this server's plays when there is none). Autoplay queues one track when the last one starts; its
  row says "added by Autoplay", a track you add at the end goes before it, **Stop** ends it until a track starts again,
  and it waits while a repeat is on.
- **Saved playlists** (**Load**): load, rename, delete, export (a text file of addresses, an M3U, or jukecord's own
  file, which keeps titles, lengths and pictures), and **Import**: a file of any of those, or a list pasted in (a line
  that is not an address is searched on YouTube; at most a hundred lines are looked up).
- **Links from other services**: a Deezer track, album or playlist, a Spotify track (albums and playlists too with the
  host's Spotify app, below) or an Apple Music track is read for its tracks' titles, artists and lengths, and each
  track is found on YouTube (the recording within a few seconds of its length, an official audio upload first). At
  most 100 tracks of a link; the first plays while the rest are found, three at a time.

At the bottom, **Listen here** plays the music in this browser, in time with the voice channel; the volume is this
browser's own. The page title shows what is playing, and the media keys and the lock screen of your computer or phone
control jukecord.

Keyboard shortcuts: <kbd>Space</kbd> play or pause, <kbd>←</kbd> <kbd>→</kbd> 10 seconds back or forward, <kbd>N</kbd>
next track, <kbd>Alt</kbd> <kbd>↑</kbd> <kbd>↓</kbd> move the queue row in focus, <kbd>/</kbd> add a track,
<kbd>?</kbd> the list.

## Who may do what

- The **host** (the machine jukecord runs on: its `jukecord` command and the login links it makes) may do everything.
- Anyone who logs in with Discord can open the servers they share with the bot.
- When a server has a **DJ role**, only members with that role (and people who can manage the server) change the music;
  everyone else can look and listen. Set it in the panel's menu, with `/dj set`, or with `jukecord dj <role ID>`. A DJ
  role deleted in Discord counts as none: everyone may change the music again until another is set.
- Where a server has a DJ role, **Skip** from anyone else is a vote. The track goes when half of the people listening
  have voted (rounded up, at least one): the people in the bot's voice channel and the people listening along in a
  browser, each once (the host as one, each friend's browser as one; guests of a listening link are not counted). Only
  they may vote, a vote counts while its person listens, and the votes end with the track. The panel's Skip key and the
  Skip button of the bot's card say how the vote stands ("1 of 2"). A server can turn votes off (the menu's **Vote to
  skip**, `/voteskip`, `jukecord voteskip off`); Skip then needs the role too.
- **Guests** come in with a **listening link**: anyone with the link listens along to its one server in a browser,
  without a Discord account, for 1, 7 or 30 days. A guest sees the player, the queue and the lyrics and has **Listen
  here**; it changes nothing and sees no other server, statistics, history, settings or log. Up to 25 browsers come in
  with one link. People who may change the music make links (`Invite` in the panel, `/share create`,
  `jukecord share`); each person sees and revokes their own, and people who can manage the server all of the
  server's. Revoking a link ends its guests' connections at once. The link is shown once: jukecord keeps only its hash,
  and the code travels after a `#`, which never reaches a server's or a proxy's log.
- **Friends** come in with a **login link** the host makes (`Invite` in the panel, or `jukecord link --scope read` or
  `--scope control`): one browser, once, within ten minutes, as the host's friend in every server here, to look and
  listen (view) or also to change the music (control), never to change settings or tokens. What a friend adds, and
  likes, counts as the host's.

- A server can choose an **alerts channel**, where jukecord says when something goes wrong: YouTube refusing it (its
  check for bots) and when that is over, jukecord restarting itself, its data's disk with less than 1 GiB free, a track
  taken out of the server's looping queue, connections turned away at one of its caps, and a scheduled backup that
  failed. Each kind at most once an hour; the same lines go to jukecord's log. People who can manage the server choose
  it in the panel's menu, with `/alerts set`, or with `jukecord alerts <channel ID>`.

## The server's settings

People who can manage the server (and the host) choose these in the panel's menu, with slash commands or with the
`jukecord` command; anyone may look (`/dj show`, `jukecord settings`).

| Setting           | Default  | What it does                                                                                                                                                                                                                                                                            | Change it with                      |
| :---------------- | :------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------- |
| Vote to skip      | on       | with a DJ role set, Skip from anyone else is a vote (see above)                                                                                                                                                                                                                         | `/voteskip`, `jukecord voteskip on` |
| Take turns        | off      | a track added at the end goes after the last track of the first round in which its person has none yet: people take turns instead of waiting behind one person's long run (the track playing counts as its person's turn); autoplay's tracks are nobody's turn, and stay after people's | `/turns set`, `jukecord turns on`   |
| Tracks per person | no limit | the most tracks one person may have in the queue; what an add brings over it is left out, and the answer says how many (the host has no limit, and autoplay's tracks are nobody's)                                                                                                      | `/limit`, `jukecord limit 5`        |
| Stay in voice     | off      | the bot stays in its voice channel when everyone has left                                                                                                                                                                                                                               | `/stay`, `jukecord stay on`         |

**Take turns now** (the queue's tools, `/turns now`, `jukecord turns now`) puts the queue as it is in turns once, with
the setting on or off; it changes the music, so it needs what any change needs (the DJ role where one is set).

## The voice channel's sound

The voice card sets how the voice channel sounds, for whoever may change the music: its **volume**, 0 to 200 % (100 %
is the track as it is), and a **sound**: more bass, clearer voices, brighter, or softer at night (less low end, gentler
highs, 4 dB quieter). A browser listening along applies the same sound, so the voice channel and every browser hear
the same; each browser keeps its own volume. `/volume`, `/sound`, `jukecord volume 80`, `jukecord sound night`, or the
API. A change is heard within a moment, from the same place in the track. At 100 % with the sound off, the voice
channel gets each cached track as it is; otherwise jukecord decodes, filters and encodes the stream it sends again
([why, and what it costs](DECISIONS.md#the-voice-channels-sound-ffmpeg-only-while-it-is-not-plain)).

## Slash commands

| Command                                      | Does                                                                 |
| :------------------------------------------- | :------------------------------------------------------------------- |
| `/play`                                      | play now (an address or search words); the current track is skipped  |
| `/add`                                       | add to the queue (at the end, or next)                               |
| `/skip` `/pause` `/resume` `/stop`           | the player (`/resume` also starts the queue after a stop)            |
| `/seek`                                      | go to a place: `83`, `1:23` or `1m23s`                               |
| `/repeat`                                    | repeat off, this track, or the queue                                 |
| `/np`                                        | what is playing, with pause and skip buttons                         |
| `/queue`                                     | the queue, ten to a page                                             |
| `/jump` `/remove` `/move`                    | a queued track by its number: play it now, remove it, move it        |
| `/shuffle` `/dedupe` `/clear`                | the whole queue                                                      |
| `/history`                                   | recently played                                                      |
| `/playlist save, load, list, rename, delete` | saved playlists                                                      |
| `/join` `/leave`                             | the voice channel (yours, or the one you name)                       |
| `/listen`                                    | the panel's link, to listen in a browser                             |
| `/stats`                                     | listening figures                                                    |
| `/dj show, set, clear`                       | the DJ role (needs Manage Server)                                    |
| `/version`                                   | the version                                                          |
| `/alerts show, set, clear`                   | where jukecord tells this server about trouble (needs Manage Server) |
| `/wrapped`                                   | the server's year in music, or a month, or the last 12 months        |
| `/lyrics`                                    | the lyrics of the track playing, to you alone, a page at a time      |
| `/stop after-track:`                         | True: stop when this track ends; False: play on after it             |
| `/share create, list, revoke`                | listening links for guests, to you alone                             |
| `/stay`                                      | stay in voice when everyone has left, or not (needs Manage Server)   |
| `/voteskip`                                  | Skip without the DJ role is a vote, or not (needs Manage Server)     |
| `/turns set` `/turns now`                    | take turns, or not (Manage Server); the queue in turns now           |
| `/limit`                                     | the most tracks one person may have queued (needs Manage Server)     |
| `/volume` `/sound`                           | the voice channel's volume and sound (browsers apply the sound too)  |
| `/playlist export, import`                   | a saved playlist as a file, and a playlist from an attached file     |
| `/like`                                      | like the track playing (answered to you alone)                       |
| `/likes show, add, remove`                   | your liked tracks: the list, all of them into the queue, one off     |
| `/autoplay`                                  | when the queue runs out: off, this server's plays, related tracks    |

Commands and answers are in Korean for people whose Discord is in Korean, and in English for everyone else. When you
play something from Discord and the bot is in no voice channel, it joins yours. It leaves a channel nobody is in after
five minutes (`JUKECORD_VOICE_IDLE`), unless the server asked it to stay (`/stay`, **Stay in voice** in the panel's
menu, `jukecord stay on`); the music goes on in the browsers. When nobody hears a server anywhere (the bot in no voice
channel, no browser playing along) for two minutes (`JUKECORD_REST_AFTER`), its player pauses and says so, instead of
fetching tracks and counting plays for nobody; playing on is a press of play. After a restart (an update, a crash) the
bot goes back to the voice channel it was in when people are there (or, where the server asked it to stay, in any
case), and says so in that channel's chat with the now-playing card, paused. The newest now-playing card in a server
(from `/np`, `/pause` and the like, or a press of its keys) is kept current as the music changes, from anywhere, and
its Skip button with the votes to skip, at most once every five seconds.

While you type in `/play` or `/add`, Discord suggests what YouTube finds for the words; a suggestion adds exactly
that track.

## The jukecord command

On the machine running jukecord, `./jukecord <command>` runs it inside the container. Anywhere else, run it from a
checkout with `JUKECORD_URL` and an API token:

```bash
npm ci --omit=dev
export JUKECORD_URL=https://music.example.com JUKECORD_TOKEN=jkc_...
node src/cli/main.ts np
```

`jukecord --help` lists every command, and `jukecord help <command>` (or `<command> --help`) shows one; through the
front door, `./jukecord help <command>` asks the running jukecord. A few:

```bash
./jukecord add never gonna give you up --next
./jukecord queue
./jukecord jump 3
./jukecord stats --days 7
./jukecord token create phone --scope control
./jukecord wrapped --month 2026-03
./jukecord lyrics --synced
./jukecord stop --after-track
./jukecord share --days 30
./jukecord search never gonna give you up
./jukecord autoplay history
./jukecord playlist export "Friday night" --format m3u > friday.m3u
```

With more than one server, say which: `--guild <server ID>` or `JUKECORD_GUILD`. `--json` prints the API's answer as it
is, for scripts, and a failure as `{"error":{"code","message"}}` on stderr. Exit codes: 0 done, 1 refused (the message
says why), 2 a typing mistake, 3 jukecord did not answer, 4 jukecord said to try again later (a rate, a busy moment).

## Settings

Settings are environment variables; with Docker Compose they go in `.env`. Every one is optional.

| Variable                                                             | Default            | What it sets                                                                                   |
| :------------------------------------------------------------------- | :----------------- | :--------------------------------------------------------------------------------------------- |
| `JUKECORD_DISCORD_TOKEN`                                             |                    | the bot's token; without it jukecord runs browser-only                                         |
| `JUKECORD_DISCORD_CLIENT_ID`                                         |                    | the application's ID, for logging in with Discord                                              |
| `JUKECORD_DISCORD_CLIENT_SECRET`                                     |                    | the application's OAuth2 secret, for Discord login                                             |
| `JUKECORD_DISCORD_TOKEN_FILE`, `JUKECORD_DISCORD_CLIENT_SECRET_FILE` |                    | the same secrets read from files (Docker and Kubernetes secrets)                               |
| `JUKECORD_PUBLIC_URL`                                                |                    | the panel's address when it is not this machine (login and links are built on it)              |
| `JUKECORD_PORT`                                                      | `8795`             | the panel's port                                                                               |
| `JUKECORD_PUBLISHED_PORT`                                            | the port           | the port this machine reaches it on, for links without a public address (compose.yaml sets it) |
| `JUKECORD_HOST`                                                      | `127.0.0.1`        | the address it listens on (the image sets `0.0.0.0`)                                           |
| `JUKECORD_DATA_DIR`                                                  | `./data`           | the database, the media cache and the logs (`/data` in the image)                              |
| `JUKECORD_TRUST_PROXY`                                               | `false`            | behind a reverse proxy: how many proxies are in front (`1` for one), or their addresses        |
| `JUKECORD_ALLOW_PRIVATE_ADDRESSES`                                   | `false`            | also fetch from addresses on private networks (a media server on the local network)            |
| `JUKECORD_CACHE_MAX`                                                 | `2GiB`             | the most the media cache holds; the least recently played tracks go first                      |
| `JUKECORD_FETCH_TIMEOUT`                                             | `60s`              | how long getting one track may take                                                            |
| `JUKECORD_PREFETCH`                                                  | `2`                | how many of the next tracks are fetched ahead                                                  |
| `JUKECORD_TRACK_MAX`                                                 | `3h`               | the longest track that may be added                                                            |
| `JUKECORD_QUEUE_MAX`                                                 | `1000`             | the most tracks a server's queue holds                                                         |
| `JUKECORD_LIVE_MAX`                                                  | `1000`             | the most open panels at once (live connections); also ten per login and twenty per address     |
| `JUKECORD_VOICE_IDLE`                                                | `5m`               | how long the bot stays alone in a voice channel (`0`: it stays)                                |
| `JUKECORD_YTDLP_COOKIES`                                             |                    | a cookies file for YouTube's sign-in check ([Troubleshooting](TROUBLESHOOTING.md))             |
| `JUKECORD_YTDLP`, `JUKECORD_FFMPEG`                                  | `yt-dlp`, `ffmpeg` | the programs jukecord runs                                                                     |
| `JUKECORD_LOG_LEVEL`                                                 | `info`             | `debug`, `info`, `warn` or `error`                                                             |
| `JUKECORD_LINK_SERVICES`                                             | all three          | the services whose links are read: `deezer`, `spotify`, `apple-music` (`none`: none)           |
| `JUKECORD_SPOTIFY_CLIENT_ID`, `JUKECORD_SPOTIFY_CLIENT_SECRET`       |                    | your own Spotify app (developer.spotify.com), for Spotify albums and playlists                 |
| `JUKECORD_SPOTIFY_CLIENT_SECRET_FILE`                                |                    | the Spotify app's secret read from a file                                                      |
| `JUKECORD_LOG_MAX`, `JUKECORD_LOG_FILES`                             | `5MiB`, `5`        | the log file's size and how many are kept                                                      |
| `JUKECORD_REST_AFTER`                                                | `2m`               | how long a server nobody hears plays on before it pauses (`0`: it plays on)                    |
| `JUKECORD_BACKUP_AT`                                                 | `off`              | a backup of the database every day at this time (`04:30`, in jukecord's time zone)             |
| `JUKECORD_BACKUP_KEEP`                                               | `7`                | how many backups stay in the backups folder                                                    |
| `JUKECORD_LYRICS`                                                    | `on`               | `off`: no lyrics, and nothing asked of LRCLIB                                                  |

jukecord checks every setting when it starts and lists every problem at once. `jukecord doctor` shows the settings in
effect (secrets only as set or not set) and checks the parts jukecord needs.
