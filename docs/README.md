# Using jukecord

For people who use a running jukecord: the panel, who may do what, each server's settings, the slash commands, the
`jukecord` command and every setting. [Installing](INSTALL.md) gets it running.

jukecord keeps one queue per Discord server and plays it in that server's voice channel. Anyone who presses **Listen
here** hears it in their browser too, at the same place in the track. The panel, the slash commands, the `jukecord`
command and the [HTTP API](API.md) all do the same things.

## The panel

On the machine running jukecord, `./jukecord open` makes a login link and opens it. Everyone else opens the panel's
address ([who may do what](#who-may-do-what)).

### Playing

- **Remove**, among the player's keys, drops the track without counting it as played.
- **⋯** in the player's head has **Stop after this track**: the player stops for everyone when the track ends, and the
  queue stays. Pressed again, it plays on.
- **Lyrics** in the player's head shows the track's words from LRCLIB. If you may change the music, choose a line to
  play from there.
- **Listen here**, at the bottom, plays the music in this browser in step with the voice channel, at this browser's
  own volume. The media keys and the lock screen control it.
- **The sleep timer**, beside **Listen here**, stops this browser alone after 15, 30 or 60 minutes or at the end of the
  track, fading out.

### The queue

- Drag a track by its handle to move it. In a narrow window, each track's keys and moves are under its **⋯**, and the
  queue's tools are behind the key beside **Shuffle**.
- The list shows a hundred tracks at a time; its search covers the whole queue.
- **Autoplay** (**∞**, beside the queue's title) chooses what plays when the queue runs out:

| Mode                      | Plays                                                                             |
| :------------------------ | :-------------------------------------------------------------------------------- |
| Off                       | nothing                                                                           |
| This server's plays       | a track played here before, none of the last 30; more plays and likes, more often |
| Related to the last track | a track from YouTube's mix of it, or this server's plays when there is none       |

Autoplay queues one track when the last one starts ("added by Autoplay"). A track you add at the end goes before it,
**Stop** ends autoplay until a track starts again, and autoplay waits while a repeat is on.

### Adding tracks

Paste an address into **Add** (a video, a playlist, a SoundCloud page, a Deezer, Spotify or Apple Music link) or type
search words. A link pasted anywhere on the page, or dropped on it, is added too.

- **Add** puts it at the end, **Play next** after the track playing, **Play now** plays it at once. In the search
  results, the arrows choose and <kbd>Enter</kbd> adds; with <kbd>Shift</kbd> it plays next, with <kbd>Ctrl</kbd> now.
- A Deezer track, album or playlist, a Spotify track or an Apple Music track is read for its titles, artists and
  lengths, and each track is found on YouTube: a recording within a few seconds of its length, an official audio
  upload first. A link brings at most 100 tracks; the first plays while the rest are found. Spotify albums and
  playlists need the host's Spotify app ([settings](#settings)).

### Likes, playlists and statistics

- **Liked**, beside **Recently played**: likes are each login's own, in every server it opens. **Add all** queues them.
- **Saved playlists** (**Load**) export as a text file of addresses, an M3U, or jukecord's own file, which keeps
  titles, lengths and pictures. **Import** takes any of those, or a pasted list: a line that is not an address is
  searched on YouTube, up to a hundred lines.
- **Statistics** (top bar) cover 7, 30 or 90 days or a year, and each chart has a table view.
- **Wrapped**, a key on the statistics, is the server's year in music, a month, or the last 12 months; its song of
  the year is the track played on the most days. **Save as picture** makes a story (1080 by 1920) or square (1080 by
  1080) PNG, which **Share** hands on from a phone. The address names the time: `/stats/wrapped?period=2026-03`.

### The rest of the page

- **Invite** (in the voice card, the player's **⋯** and the menu) makes a listening link for guests and, for the host,
  a login link for a friend, each with a QR code ([friends and guests](#friends-and-guests)).
- **The menu** (your name, top right) has the theme, language, motion, API tokens and keyboard shortcuts, and for
  people who can manage the server, its settings.
- **Log** (the host only) is jukecord's log, filtered by level and part.
- **As an app**: where the browser offers it (Chrome's or Edge's install button, Safari's **Add to Home Screen**), the
  panel installs and opens in its own window, also when jukecord cannot be reached, saying so. On Android it is then
  among the apps a video can be shared to, and the shared address opens a page that queues it.

Keyboard: <kbd>Space</kbd> play or pause, <kbd>←</kbd> <kbd>→</kbd> 10 seconds back or forward, <kbd>N</kbd> next
track, <kbd>Alt</kbd> <kbd>↑</kbd> <kbd>↓</kbd> move the queue row in focus, <kbd>/</kbd> add a track, <kbd>?</kbd>
the list of shortcuts.

## Who may do what

- **The host** may do everything: the machine jukecord runs on, its `jukecord` command and the login links it makes.
- **Anyone who logs in with Discord** opens the servers they share with the bot.
- **A DJ role**, when a server sets one, lets only its members and the people who can manage the server change the
  music; everyone else looks and listens. A DJ role deleted in Discord counts as none.
- **Friends and guests** come in with links, without Discord ([below](#friends-and-guests)).

### Voting to skip

Where a server has a DJ role and **Vote to skip** on, **Skip** from anyone else is a vote:

- The track goes when half of the listeners have voted, rounded up, at least one.
- The listeners are the people in the bot's voice channel and the browsers listening along: the host counts once,
  each friend's browser once, and guests not at all.
- Only listeners vote. A vote counts while its person listens, and the votes end with the track.
- With **Vote to skip** off, Skip needs the role.

### Friends and guests

A **friend** gets a login link from the host: **Invite**, or `jukecord link --scope read` or `--scope control`. It
works once, in one browser, within ten minutes. The friend may then look and listen (**View**) or also change the
music (**Control**) in every server here, never settings or tokens. What a friend adds and likes counts as the host's.

A **guest** gets a listening link from anyone who may change the music: **Invite**, `/share create` or
`jukecord share`.

- The link lets up to 25 browsers listen along to its one server for 1, 7 or 30 days. A guest sees the player, the
  queue and the lyrics, and changes nothing.
- It is shown once: jukecord keeps only its hash, and the code after the `#` never reaches a server's or a proxy's log.
- Each person sees and revokes their own links, and people who can manage the server all of the server's. Revoking a
  link ends its guests' connections at once.

## The server's settings

People who can manage the server, and the host, change these in the panel's menu, with a slash command or with the
`jukecord` command. Anyone may look with `jukecord settings`.

| Setting           | Default  | What it does                                                  | Change it with                                |
| :---------------- | :------: | :------------------------------------------------------------ | :-------------------------------------------- |
| DJ role           |   none   | who may change the music ([above](#who-may-do-what))          | `/dj set`, `jukecord dj <role ID>`            |
| Vote to skip      |    on    | with a DJ role, Skip from others is a [vote](#voting-to-skip) | `/voteskip`, `jukecord voteskip on`           |
| Take turns        |   off    | people's tracks go in turns                                   | `/turns set`, `jukecord turns on`             |
| Tracks per person | no limit | the most tracks one person may have in the queue              | `/limit`, `jukecord limit 5`                  |
| Stay in voice     |   off    | the bot stays in its voice channel when everyone has left     | `/stay`, `jukecord stay on`                   |
| Alerts channel    |   none   | where jukecord says something went wrong                      | `/alerts set`, `jukecord alerts <channel ID>` |

- **Take turns** puts a track added at the end after the last track of the first round in which its person has none
  yet; the track playing counts as its person's turn. **Take turns now** (the queue's tools, `/turns now`,
  `jukecord turns now`) does it once, with the setting on or off, and needs the DJ role where one is set.
- **Tracks per person**: what an add brings over the limit is left out, and the answer says how many. The host has no
  limit.
- Autoplay's tracks are nobody's: they count toward no limit and stay after people's turns.
- **The alerts channel** hears, at most once an hour for each kind and in the log too: YouTube refusing jukecord (its
  check for bots) and that ending, jukecord restarting itself, less than 1 GiB free for its data, a track leaving a
  looping queue, connections turned away at a cap, and a scheduled backup failing.

## The voice channel's sound

The voice card sets the voice channel's **volume**, 0 to 200 % (100 % is the track as it is), and its **sound**: more
bass, clearer voices, brighter, or softer at night (less low end, gentler highs, 4 dB quieter). So do `/volume`,
`/sound`, `jukecord volume 80` and `jukecord sound night`, for whoever may change the music. A change is heard within a
moment, from the same place in the track. Browsers listening along apply the same sound, each at its own volume.

At 100 % with the sound off, the voice channel gets each cached track as it is. Otherwise jukecord decodes, filters
and encodes it again
([why, and what it costs](DECISIONS.md#the-voice-channels-sound-ffmpeg-only-while-it-is-not-plain)).

## Slash commands

| Command                                      | Does                                                                      |
| :------------------------------------------- | :------------------------------------------------------------------------ |
| `/play`                                      | play an address or search words now, skipping the current track           |
| `/add`                                       | add to the queue, at the end or next                                      |
| `/skip` `/pause` `/resume` `/stop`           | the player (`/resume` also starts the queue after a stop)                 |
| `/stop after-track:`                         | True: stop when this track ends; False: play on after it                  |
| `/drop`                                      | remove the track playing without adding it to the history                 |
| `/seek`                                      | go to a place: `83`, `1:23` or `1m23s`                                    |
| `/repeat`                                    | repeat off, this track, or the queue                                      |
| `/np`                                        | what is playing, with pause and skip buttons                              |
| `/queue`                                     | the queue, ten to a page                                                  |
| `/jump` `/remove` `/move`                    | a queued track by its number: play it now, remove it, move it             |
| `/shuffle` `/dedupe` `/clear`                | the whole queue                                                           |
| `/autoplay`                                  | when the queue runs out: off, this server's plays, related tracks         |
| `/history`                                   | recently played                                                           |
| `/playlist save, load, list, rename, delete` | saved playlists                                                           |
| `/playlist export, import`                   | a saved playlist as a file, and a playlist from an attached file          |
| `/like`, `/likes show, add, remove`          | like the track playing; your likes: the list, all into the queue, one off |
| `/lyrics`                                    | the lyrics of the track playing, a page at a time                         |
| `/join` `/leave`                             | the voice channel: yours, or the one you name                             |
| `/volume` `/sound`                           | the voice channel's [volume and sound](#the-voice-channels-sound)         |
| `/listen`                                    | the panel's link, to listen in a browser                                  |
| `/share create, list, revoke`                | listening links for guests                                                |
| `/stats` `/wrapped`                          | listening figures; the year in music, a month or the last 12 months       |
| `/turns now`                                 | put the queue in turns, once                                              |
| `/dj` `/alerts` (show, set, clear)           | [the server's settings](#the-servers-settings), with Manage Server        |
| `/stay` `/voteskip` `/turns set` `/limit`    | the same                                                                  |
| `/version`                                   | the version                                                               |

In Discord:

- Commands and answers are in Korean for people whose Discord is in Korean, in English for everyone else.
- Lookups (`/queue`, `/history`, `/stats`, `/lyrics`, `/likes show`, `/version` and the like), `/share` and `/like`
  answer you alone.
- While you type in `/play` or `/add`, Discord suggests what YouTube finds; a suggestion adds exactly that track.
- Playing something while the bot is in no voice channel makes it join yours.
- The bot leaves a channel nobody is in after five minutes (`JUKECORD_VOICE_IDLE`) unless **Stay in voice** is on;
  browsers play on.
- A server nobody hears for two minutes (`JUKECORD_REST_AFTER`), with the bot in no voice channel and no browser
  along, pauses and says so, instead of fetching tracks and counting plays for nobody.
- After a restart (an update, a crash), the bot goes back to its voice channel when people are there, or in any case
  with **Stay in voice** on, and posts the now-playing card there, paused.
- The newest now-playing card in a server (from `/np`, `/pause` and the like, or its keys) is kept current, with the
  votes to skip, at most once every five seconds.

## The jukecord command

On the machine running jukecord, `./jukecord <command>` runs it inside the container. Anywhere else, run it from a
checkout with the panel's address and an API token (**API tokens** in the panel's menu, or `jukecord token create`):

```bash
export JUKECORD_URL=https://music.example.com JUKECORD_TOKEN=jkc_...
npm ci --omit=dev
node src/cli/main.ts np
```

`jukecord --help` lists every command, and `jukecord help <command>` (or `<command> --help`) shows one. Through the
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
./jukecord playlist import "Friday again" friday.m3u
```

With more than one server, `--guild <server ID>` or `JUKECORD_GUILD` says which. `--json` prints the API's answer as
it is, and a failure as `{"error":{"code","message"}}` on stderr.

| Exit code | Means                                                          |
| --------: | :------------------------------------------------------------- |
|         0 | done                                                           |
|         1 | refused; the message says why                                  |
|         2 | a typing mistake                                               |
|         3 | jukecord did not answer                                        |
|         4 | jukecord said to try again later (a rate limit, a busy moment) |

## Settings

Settings are environment variables; with Docker Compose they go in `.env`. Every one is optional. jukecord checks them
all when it starts and lists every problem at once. `jukecord doctor` shows the settings in effect, secrets only as
set or not set.

| Variable                                                             |      Default       | What it sets                                                                                        |
| :------------------------------------------------------------------- | :----------------: | :-------------------------------------------------------------------------------------------------- |
| **Discord**                                                          |                    |                                                                                                     |
| `JUKECORD_DISCORD_TOKEN`                                             |                    | the bot's token; without it jukecord runs browser-only                                              |
| `JUKECORD_DISCORD_CLIENT_ID`                                         |                    | the application's ID, for logging in with Discord                                                   |
| `JUKECORD_DISCORD_CLIENT_SECRET`                                     |                    | the application's OAuth2 secret, for logging in with Discord                                        |
| `JUKECORD_DISCORD_TOKEN_FILE`, `JUKECORD_DISCORD_CLIENT_SECRET_FILE` |                    | those two secrets, read from files (Docker and Kubernetes secrets)                                  |
| **The panel**                                                        |                    |                                                                                                     |
| `JUKECORD_PUBLIC_URL`                                                |                    | the panel's address when it is not this machine; logins and links use it                            |
| `JUKECORD_PORT`                                                      |       `8795`       | the panel's port                                                                                    |
| `JUKECORD_PUBLISHED_PORT`                                            |      the port      | the port this machine reaches it on, for links without a public address (Compose sets it)           |
| `JUKECORD_HOST`                                                      |    `127.0.0.1`     | the address it listens on (the image sets `0.0.0.0`)                                                |
| `JUKECORD_TRUST_PROXY`                                               |      `false`       | behind a reverse proxy: how many proxies are in front (`1` for one), or their addresses             |
| `JUKECORD_LIVE_MAX`                                                  |       `1000`       | the most open panels at once; also ten per login and twenty per address                             |
| **Playing**                                                          |                    |                                                                                                     |
| `JUKECORD_TRACK_MAX`                                                 |        `3h`        | the longest track that may be added                                                                 |
| `JUKECORD_QUEUE_MAX`                                                 |       `1000`       | the most tracks a server's queue holds                                                              |
| `JUKECORD_VOICE_IDLE`                                                |        `5m`        | how long the bot stays alone in a voice channel (`0`: it stays)                                     |
| `JUKECORD_REST_AFTER`                                                |        `2m`        | how long a server nobody hears plays on before it pauses (`0`: it plays on)                         |
| **Fetching tracks**                                                  |                    |                                                                                                     |
| `JUKECORD_CACHE_MAX`                                                 |       `2GiB`       | the media cache's size; the least recently played tracks go first                                   |
| `JUKECORD_FETCH_TIMEOUT`                                             |       `60s`        | how long getting one track may take                                                                 |
| `JUKECORD_PREFETCH`                                                  |        `2`         | how many of the next tracks are fetched ahead                                                       |
| `JUKECORD_ALLOW_PRIVATE_ADDRESSES`                                   |      `false`       | also fetch from private network addresses (a media server on the local network)                     |
| `JUKECORD_YTDLP_COOKIES`                                             |                    | a cookies file for YouTube's [sign-in check](TROUBLESHOOTING.md#sign-in-to-confirm-youre-not-a-bot) |
| `JUKECORD_YTDLP`, `JUKECORD_FFMPEG`                                  | `yt-dlp`, `ffmpeg` | the programs jukecord runs                                                                          |
| **Other services**                                                   |                    |                                                                                                     |
| `JUKECORD_LYRICS`                                                    |        `on`        | `off`: no lyrics, and nothing asked of LRCLIB                                                       |
| `JUKECORD_LINK_SERVICES`                                             |     all three      | the services whose links are read: `deezer`, `spotify`, `apple-music` (`none`: none)                |
| `JUKECORD_SPOTIFY_CLIENT_ID`, `JUKECORD_SPOTIFY_CLIENT_SECRET`       |                    | your own Spotify app (developer.spotify.com), for Spotify albums and playlists                      |
| `JUKECORD_SPOTIFY_CLIENT_SECRET_FILE`                                |                    | the Spotify app's secret, read from a file                                                          |
| **Data, logs and backups**                                           |                    |                                                                                                     |
| `JUKECORD_DATA_DIR`                                                  |      `./data`      | the database, the media cache and the logs (`/data` in the image)                                   |
| `JUKECORD_LOG_LEVEL`                                                 |       `info`       | `debug`, `info`, `warn` or `error`                                                                  |
| `JUKECORD_LOG_MAX`, `JUKECORD_LOG_FILES`                             |    `5MiB`, `5`     | the log file's size, and how many are kept                                                          |
| `JUKECORD_BACKUP_AT`                                                 |       `off`        | a database backup every day at this time (`04:30`, in jukecord's time zone)                         |
| `JUKECORD_BACKUP_KEEP`                                               |        `7`         | how many backups the backups folder keeps                                                           |

Docker Compose also reads `JUKECORD_BIND` and `JUKECORD_IMAGE` ([installing](INSTALL.md#docker-compose)).
