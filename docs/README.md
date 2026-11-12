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
  (beside the title), search, shuffle, remove duplicates, save as a playlist, load a playlist, clear; on a narrow
  window the queue's tools wait behind the key beside **Shuffle**. A long queue shows a hundred tracks at a time
  (**Show more** brings the next hundred); search covers all of it.
- **Add**: paste an address (a video, a playlist, a SoundCloud page, a Deezer, Spotify or Apple Music link ...) or type
  search words. **Add** puts it at the end of the queue, **Play next** right after the track playing, **Play now**
  plays it at once. Words show what YouTube found under the field a moment after you stop typing: press a result to
  add it, or its play now and play next marks; with the keyboard, the arrows choose one and Enter adds it
  (<kbd>Shift</kbd> <kbd>Enter</kbd> plays it next, <kbd>Ctrl</kbd> <kbd>Enter</kbd> now). A link pasted anywhere on
  the page, or dropped on it from another window, is added the same way.
- **Voice channel**: where the bot is, the channels it may join (with how many people are in each), and who is
  listening in a browser.
- **Recently played** and **Liked** (two lists in one card): what played, and the tracks you liked, each with keys
  to play it now, next or at the end, and its heart; **Add all** puts every liked track in the queue. Likes are each
  login's own, in every server it opens (a track can be liked in a server that plays it, queued it, played it or keeps
  it in a playlist).
- **Statistics** (top bar): plays per day and per hour of the day, the most played tracks, who added most, and the
  time listened, over 7, 30 or 90 days or a year. Each chart has a table view.
- **Log** (the host only): jukecord's log, filtered by level and part.
- **The menu** (your name, top right): theme, language, motion, the server's DJ role (for people who can manage the
  server), API tokens, keyboard shortcuts, logging out.
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

## Slash commands

| Command                                      | Does                                                                |
| :------------------------------------------- | :------------------------------------------------------------------ |
| `/play`                                      | play now (an address or search words); the current track is skipped |
| `/add`                                       | add to the queue (at the end, or next)                              |
| `/skip` `/pause` `/resume` `/stop`           | the player (`/resume` also starts the queue after a stop)           |
| `/seek`                                      | go to a place: `83`, `1:23` or `1m23s`                              |
| `/repeat`                                    | repeat off, this track, or the queue                                |
| `/np`                                        | what is playing, with pause and skip buttons                        |
| `/queue`                                     | the queue, ten to a page                                            |
| `/jump` `/remove` `/move`                    | a queued track by its number: play it now, remove it, move it       |
| `/shuffle` `/dedupe` `/clear`                | the whole queue                                                     |
| `/history`                                   | recently played                                                     |
| `/playlist save, load, list, rename, delete` | saved playlists                                                     |
| `/join` `/leave`                             | the voice channel (yours, or the one you name)                      |
| `/listen`                                    | the panel's link, to listen in a browser                            |
| `/stats`                                     | listening figures                                                   |
| `/dj show, set, clear`                       | the DJ role (needs Manage Server)                                   |
| `/version`                                   | the version                                                         |
| `/playlist export, import`                   | a saved playlist as a file, and a playlist from an attached file    |
| `/like`                                      | like the track playing (answered to you alone)                      |
| `/likes show, add, remove`                   | your liked tracks: the list, all of them into the queue, one off    |
| `/autoplay`                                  | when the queue runs out: off, this server's plays, related tracks   |

Commands and answers are in Korean for people whose Discord is in Korean, and in English for everyone else. When you
play something from Discord and the bot is in no voice channel, it joins yours. It leaves a channel nobody is in after
five minutes (`JUKECORD_VOICE_IDLE`); the music goes on in the browsers.

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

`jukecord --help` lists every command. A few:

```bash
./jukecord add never gonna give you up --next
./jukecord queue
./jukecord jump 3
./jukecord stats --days 7
./jukecord token create phone --scope control
./jukecord search never gonna give you up
./jukecord autoplay history
./jukecord playlist export "Friday night" --format m3u > friday.m3u
```

With more than one server, say which: `--guild <server ID>` or `JUKECORD_GUILD`. `--json` prints the API's answer as it
is, for scripts. Exit codes: 0 done, 1 refused (the message says why), 2 a typing mistake, 3 jukecord did not answer.

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

jukecord checks every setting when it starts and lists every problem at once. `jukecord doctor` shows the settings in
effect (secrets only as set or not set) and checks the parts jukecord needs.
