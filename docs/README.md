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
  search, shuffle, remove duplicates, save as a playlist, load a playlist, clear. On a phone or in a narrow window, a
  track's keys and moves wait behind its **⋯** key, and the queue's tools behind the one beside **Shuffle**. A long
  queue shows a hundred tracks at a time (**Show more** brings the next hundred); search covers all of it.
- **Add**: paste an address (a video, a playlist, a SoundCloud page ...) or type search words. **Add** puts it at the end
  of the queue; **Play now** plays it at once.
- **Voice channel**: where the bot is, the channels it may join (with how many people are in each), and who is
  listening in a browser.
- **Recently played**: the history, with a key to add a track again.
- **Statistics** (top bar): plays per day and per hour of the day, the most played tracks, who added most, and the
  time listened, over 7, 30 or 90 days or a year. Each chart has a table view.
- **Log** (the host only): jukecord's log, filtered by level and part.
- **The menu** (your name, top right): theme, language, motion, the server's DJ role (for people who can manage the
  server), API tokens, keyboard shortcuts, logging out.
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
- **Guests** come in with a **listening link**: anyone with the link listens along to its one server in a browser,
  without a Discord account, for 1, 7 or 30 days. A guest sees the player, the queue and the lyrics and has **Listen
  here**; it changes nothing and sees no other server, statistics, history, settings or log. Up to 25 browsers come in
  with one link. People who may change the music make links (`Invite` in the panel, `/share create`,
  `jukecord share`); each person sees and revokes their own, and people who can manage the server all of the
  server's. Revoking a link ends its guests' connections at once. The link is shown once: jukecord keeps only its hash,
  and the code travels after a `#`, which never reaches a server's or a proxy's log.
- **Friends** come in with a **login link** the host makes (`Invite` in the panel, or `jukecord link --scope read` or
  `--scope control`): one browser, once, within ten minutes, as the host's friend in every server here, to look and
  listen (view) or also to change the music (control), never to change settings or tokens. What a friend adds counts
  as the host's.

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
| `/lyrics`                                    | the lyrics of the track playing, to you alone, a page at a time     |
| `/stop after-track:`                         | True: stop when this track ends; False: play on after it            |
| `/share create, list, revoke`                | listening links for guests, to you alone                            |

Commands and answers are in Korean for people whose Discord is in Korean, and in English for everyone else. When you
play something from Discord and the bot is in no voice channel, it joins yours. It leaves a channel nobody is in after
five minutes (`JUKECORD_VOICE_IDLE`); the music goes on in the browsers.

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
./jukecord lyrics --synced
./jukecord stop --after-track
./jukecord share --days 30
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
| `JUKECORD_LYRICS`                                                    | `on`               | `off`: no lyrics, and nothing asked of LRCLIB                                                  |

jukecord checks every setting when it starts and lists every problem at once. `jukecord doctor` shows the settings in
effect (secrets only as set or not set) and checks the parts jukecord needs.
