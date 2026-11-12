# Using jukecord

jukecord keeps one queue per Discord server and plays it in that server's voice channel and, for anyone who presses
**Listen here**, in their browser at the same place in the track. You can drive it from four places, which all do the
same things: the panel, slash commands in Discord, the `jukecord` command, and the [HTTP API](API.md).

## The panel

Open the panel's address (on the machine running jukecord, `./jukecord open` prints a login link and opens it).

- **Now playing**: the track on a disc that turns while it plays, who added it, a progress bar you can click or drag to
  seek, and the keys: play or pause, skip, stop, repeat (off, the queue, this track) and remove (drops the track
  without counting it as played).
- **Queue**: drag a track by its handle to move it, or use its keys: play now, play next, remove. Above the list:
  search, shuffle, take turns now (see [the server's settings](#the-servers-settings)), remove duplicates, save as a
  playlist, load a playlist, clear. On a phone or in a narrow window, a track's keys and moves wait behind its **⋯**
  key, and the queue's tools behind the one beside **Shuffle**. A long queue shows a hundred tracks at a time
  (**Show more** brings the next hundred); search covers all of it.
- **Add**: paste an address (a video, a playlist, a SoundCloud page ...) or type search words. **Add** puts it at the end
  of the queue; **Play now** plays it at once.
- **Voice channel**: where the bot is, the channels it may join (with how many people are in each), the voice
  channel's volume and sound (see [the sound](#the-voice-channels-sound)), and who is listening in a browser.
- **Recently played**: the history, with a key to add a track again.
- **Statistics** (top bar): plays per day and per hour of the day, the most played tracks, who added most, and the
  time listened, over 7, 30 or 90 days or a year. Each chart has a table view.
- **Log** (the host only): jukecord's log, filtered by level and part.
- **The menu** (your name, top right): theme, language, motion, the server's DJ role and settings (for people who can
  manage the server), API tokens, keyboard shortcuts, logging out.

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
  browser, each once. Only they may vote, a vote counts while its person listens, and the votes end with the track.
  The panel's Skip key and the Skip button of the bot's card say how the vote stands ("1 of 2"). A server can turn
  votes off (the menu's **Vote to skip**, `/voteskip`, `jukecord voteskip off`); Skip then needs the role too.

## The server's settings

People who can manage the server (and the host) choose these in the panel's menu, with slash commands or with the
`jukecord` command; anyone may look (`/dj show`, `jukecord settings`).

| Setting           | Default  | What it does                                                                                                                                                                                                              | Change it with                      |
| :---------------- | :------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :---------------------------------- |
| Vote to skip      | on       | with a DJ role set, Skip from anyone else is a vote (see above)                                                                                                                                                           | `/voteskip`, `jukecord voteskip on` |
| Take turns        | off      | a track added at the end goes after the last track of the first round in which its person has none yet: people take turns instead of waiting behind one person's long run (the track playing counts as its person's turn) | `/turns set`, `jukecord turns on`   |
| Tracks per person | no limit | the most tracks one person may have in the queue; what an add brings over it is left out, and the answer says how many (the host has no limit)                                                                            | `/limit`, `jukecord limit 5`        |
| Stay in voice     | off      | the bot stays in its voice channel when everyone has left                                                                                                                                                                 | `/stay`, `jukecord stay on`         |

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
| `/stay`                                      | stay in voice when everyone has left, or not (needs Manage Server)  |
| `/voteskip`                                  | Skip without the DJ role is a vote, or not (needs Manage Server)    |
| `/turns set` `/turns now`                    | take turns, or not (Manage Server); the queue in turns now          |
| `/limit`                                     | the most tracks one person may have queued (needs Manage Server)    |
| `/volume` `/sound`                           | the voice channel's volume and sound (browsers apply the sound too) |

Commands and answers are in Korean for people whose Discord is in Korean, and in English for everyone else. When you
play something from Discord and the bot is in no voice channel, it joins yours. It leaves a channel nobody is in after
five minutes (`JUKECORD_VOICE_IDLE`), unless the server asked it to stay (`/stay`, **Stay in voice** in the panel's
menu, `jukecord stay on`); the music goes on in the browsers.

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
| `JUKECORD_LOG_MAX`, `JUKECORD_LOG_FILES`                             | `5MiB`, `5`        | the log file's size and how many are kept                                                      |

jukecord checks every setting when it starts and lists every problem at once. `jukecord doctor` shows the settings in
effect (secrets only as set or not set) and checks the parts jukecord needs.
