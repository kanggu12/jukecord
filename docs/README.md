# Using jukecord

For people who use a running jukecord: the panel, logging in and who may do what, each server's settings, the slash
commands, the `jukecord` command and every setting. [Installing](INSTALL.md) gets it running.

jukecord keeps one queue per Discord server and plays it in that server's voice channel. Anyone who presses **Listen
here** hears it in their browser too, at the same place in the track. The panel, the slash commands, the `jukecord`
command and the [HTTP API](API.md) all do the same things.

## The panel

On the machine running jukecord, `./jukecord open` makes a login link and opens it. Everyone else opens the panel's
address, whose login page offers the ways the host set up: Discord, the host's own sign-in (SSO), a directory account
with a name and a password, or a login link from the host ([who may do what](#who-may-do-what)).

### Playing

- **⋯** in the player's head lists what else there is for the track playing. **Stop after this track**: the player
  stops for everyone when the track ends, and the queue stays; the player says so under the track, with **Keep
  playing** beside it. **Remove this track** skips it without counting it as played.
- **Lyrics** in the player's head shows the track's words from LRCLIB. If you may change the music, choose a line to
  play from there. When LRCLIB has none, a short message says so.
- **Listen here**, at the bottom, plays the music in this browser in step with the voice channel, at this browser's
  own volume. The media keys and the lock screen control it.
- **The sleep timer**, beside **Listen here**, stops this browser alone after 15, 30 or 60 minutes or at the end of the
  track, fading out.

### The queue

- Drag a track by its handle to move it. In a narrow window, each track's keys and moves are under its **⋯**, and the
  queue's tools are behind the key beside **Shuffle**.
- The list shows a hundred tracks at a time; its search covers the whole queue.
- **Autoplay** (**∞**, beside the queue's title) chooses what plays when the queue runs out:

| Mode                      | Plays                                                                                    |
| :------------------------ | :--------------------------------------------------------------------------------------- |
| Off                       | nothing                                                                                  |
| Past plays                | a track played here before, none of the last 30 played; more plays and likes, more often |
| Related to the last track | a track from YouTube's mix of it, or from past plays when there is no mix                |

Autoplay queues one track when the last one starts ("added by Autoplay"). A track you add at the end goes before it,
**Stop** ends autoplay until a track starts again, and autoplay waits while a repeat is on. A server whose every track
is among its last 30 plays gets one of the tracks it heard longest ago.

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
- **Saved playlists** (**Playlists**) export as a text file of addresses, an M3U, or jukecord's own file, which keeps
  titles, lengths and pictures. **Import** takes any of those, or a pasted list: a line that is not an address is
  searched on YouTube, up to a hundred lines.
- **Statistics** (top bar) cover 7, 30 or 90 days or a year, and each chart has a table view.
- **Wrapped**, a key on the statistics, is the server's year in music, a month, or the last 12 months; its song of
  the year is the track played on the most days. **Save as picture** makes a story (1080 by 1920) or square (1080 by
  1080) PNG, which **Share** hands on from a phone. The address names the time: `/stats/wrapped?period=2026-03`.

### The rest of the page

- **Invite** (in the voice card and the menu) makes a listening link for guests and, for the host, a login link for
  a friend, each with a QR code ([friends and guests](#friends-and-guests)).
- **The menu** (your name, top right) has the theme, language, motion, API tokens and keyboard shortcuts, and for
  people who can manage the server, its settings. The host's menu has **Settings** too: every setting of jukecord
  itself ([settings](#settings)). A member's name says how they logged in: **SSO login** or
  **Directory account**.
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
- **Members** log in through the host's identity provider (SSO) or directory, at the level their groups give
  ([below](#members)).
- **A DJ role**, when a server sets one, lets only its members and the people who can manage the server change the
  music; everyone else looks and listens. A DJ role deleted in Discord counts as none.
- **Friends and guests** come in with links, without Discord ([below](#friends-and-guests)).

### Members

A host can let people log in through the host's own identity provider (OpenID Connect: Keycloak, Authentik, Entra ID,
Okta, Google) or with an account of the host's directory (LDAP, Active Directory)
([setting it up](INSTALL.md#logging-in-through-your-own-accounts)). Their groups give them a level at each login:

| Level   | May                                                                                |
| :------ | :--------------------------------------------------------------------------------- |
| admin   | what the host may: every server and its settings, the log, login links and backups |
| control | change the music in every server, never settings or tokens                         |
| read    | look and listen                                                                    |

- Someone in none of the host's groups is refused, and the login page says to ask the host.
- What a member adds, likes and saves shows their name.
- Members make no API tokens. A level changes at the person's next login.
- A login through SSO that names the person's Discord account is that Discord user, with their roles in each server,
  and the level where it gives more.
- Logging out of jukecord logs out of the host's sign-in too, when it offers that.

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
bass, clearer voices, brighter, or night mode (less low end, gentler highs, 4 dB quieter). So do `/volume`,
`/sound`, `jukecord volume 80` and `jukecord sound night`, for whoever may change the music. A change is heard within a
moment, from the same place in the track. Browsers listening along apply the same sound, each at its own volume.

At 100 % with the original sound, the voice channel gets each cached track as it is. Otherwise jukecord decodes, filters
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
| `/autoplay`                                  | when the queue runs out: off, past plays, related tracks                  |
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

`jukecord db` works on the database itself, from where it runs, so it also works while jukecord is stopped
([the database](INSTALL.md#the-database)); `jukecord auth` says how people may log in here, and checks the settings of
the host's own sign-in and directory without logging anyone in
([your own accounts](INSTALL.md#logging-in-through-your-own-accounts)):

```bash
./jukecord db status                          # the database jukecord uses: kind, version, schema, size, rows
./jukecord db copy sqlite:/data/jukecord.db   # every row of that file into the database jukecord uses
./jukecord auth methods
./jukecord auth test-discord                  # the Discord login's application: its ID and secret, nobody logged in
./jukecord auth test-oidc
./jukecord auth test-ldap mina                # also looks a person up: their groups and level, no password
```

## Health and metrics

For a monitoring system, without a login: `/healthz` answers while jukecord runs, `/readyz` says part by part
whether it can serve (the database, the bus and cache, Discord, ffmpeg and yt-dlp), and `/metrics` has its figures
for Prometheus, for a scraper on jukecord's own network or one that shows the metrics token
([monitoring](INSTALL.md#monitoring), [the answers](API.md#health-and-metrics)).

## Settings

Every setting has a default, so each one is optional. The host sees and changes them on the panel's **Settings** page
(the menu's **Settings**), with `jukecord settings` (`list`, `get`, `set`, `reset`; `test-database`, `test-cache` and
`test-bus` try an address without saving it, `--ca <file>` trusting more authorities for the test; `move-database`
copies everything into another database and switches to it; `ca`, `ca import <file>` and `ca remove` show and change
the certificate authorities every TLS connection trusts) and `jukecord restart`, or through the API; a value set as an environment variable wins over a saved one and shows
as set by the environment. With Docker Compose the variables go in `.env`. jukecord checks every setting when it
starts and when one is saved, and lists every problem at once. `jukecord doctor` shows the settings in effect, secrets
only as set or not set. A setting marked "at once" takes effect when it is saved; the others when jukecord restarts.

Installing explains the groups that take more than a line: [the database](INSTALL.md#the-database),
[logins through your own accounts](INSTALL.md#logging-in-through-your-own-accounts),
[a split into services](INSTALL.md#split-into-services) and [monitoring](INSTALL.md#monitoring).

<!-- settings:start -->

| Variable                                                                |            Default             | Applies | What it sets                                                                                                                                                       |
| :---------------------------------------------------------------------- | :----------------------------: | :------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Server and network**                                                  |                                |         |                                                                                                                                                                    |
| `JUKECORD_HOST`                                                         |          `127.0.0.1`           | restart | The address the panel and the API listen on; 0.0.0.0 is every network                                                                                              |
| `JUKECORD_PORT`                                                         |             `8795`             | restart | The port the panel and the API listen on                                                                                                                           |
| `JUKECORD_PUBLISHED_PORT`                                               |            the port            | restart | The port this machine reaches jukecord on, for links without a public address (Compose sets it)                                                                    |
| `JUKECORD_PUBLIC_URL`                                                   |                                | restart | The address people open the panel at, when it is not this machine; logins and links use it                                                                         |
| `JUKECORD_TRUST_PROXY`                                                  |            `false`             | restart | Behind a reverse proxy: how many stand in front of jukecord, or their addresses, whose word on a browser’s address is taken                                        |
| `JUKECORD_LIVE_MAX`                                                     |             `1000`             | at once | The most live connections at once (each open panel is one); also ten per login and twenty per address                                                              |
| `JUKECORD_DATA_DIR`                                                     |            `./data`            | restart | Where the database, the media cache, the logs, the backups and settings.json are                                                                                   |
| `JUKECORD_SUPERVISOR`                                                   |     found out at the start     | restart | What starts jukecord again when it restarts itself: docker, kubernetes, systemd, launcher or none                                                                  |
| **Discord**                                                             |                                |         |                                                                                                                                                                    |
| `JUKECORD_DISCORD_TOKEN`, `JUKECORD_DISCORD_TOKEN_FILE`                 |                                | restart | The Discord bot's token; without it jukecord plays in browsers only                                                                                                |
| `JUKECORD_VOICE_IDLE`                                                   |              `5m`              | at once | How long the bot stays alone in a voice channel before it leaves; turned off, it stays                                                                             |
| **Logins: Discord login**                                               |                                |         |                                                                                                                                                                    |
| `JUKECORD_DISCORD_CLIENT_ID`                                            |                                | restart | The Discord application's ID, for logging in with Discord                                                                                                          |
| `JUKECORD_DISCORD_CLIENT_SECRET`, `JUKECORD_DISCORD_CLIENT_SECRET_FILE` |                                | restart | The application's OAuth2 client secret, for logging in with Discord                                                                                                |
| **Logins: SSO (OIDC)**                                                  |                                |         |                                                                                                                                                                    |
| `JUKECORD_OIDC_ISSUER`                                                  |                                | restart | The identity provider's issuer address; SSO is on once it is set                                                                                                   |
| `JUKECORD_OIDC_CLIENT_ID`                                               |                                | restart | The client jukecord is at the provider                                                                                                                             |
| `JUKECORD_OIDC_CLIENT_SECRET`, `JUKECORD_OIDC_CLIENT_SECRET_FILE`       |                                | restart | The client's secret; none for a public client, which proves itself with PKCE                                                                                       |
| `JUKECORD_OIDC_SCOPES`                                                  |        `openid profile`        | restart | The scopes asked for; openid always, and first                                                                                                                     |
| `JUKECORD_OIDC_GROUPS_CLAIM`                                            |            `groups`            | restart | Where the groups or roles are among the claims: a name, or a path like realm_access.roles                                                                          |
| `JUKECORD_OIDC_ADMIN_GROUPS`                                            |                                | restart | Groups whose people may do what the host may; * is everyone the provider lets in                                                                                   |
| `JUKECORD_OIDC_CONTROL_GROUPS`                                          |                                | restart | Groups whose people change the music in every server                                                                                                               |
| `JUKECORD_OIDC_READ_GROUPS`                                             |                                | restart | Groups whose people look and listen                                                                                                                                |
| `JUKECORD_OIDC_LABEL`                                                   |        Log in with SSO         | restart | The words on the login page’s key for SSO                                                                                                                          |
| `JUKECORD_OIDC_DISCORD_CLAIM`                                           |                                | restart | A claim with a Discord user ID: a login that has one is that Discord user                                                                                          |
| **Logins: Directory (LDAP, Active Directory)**                          |                                |         |                                                                                                                                                                    |
| `JUKECORD_LDAP_URL`                                                     |                                | restart | The directory's ldap:// or ldaps:// address; directory accounts are on once it is set                                                                              |
| `JUKECORD_LDAP_STARTTLS`                                                |              `no`              | restart | Encrypts an ldap:// connection before anything is sent                                                                                                             |
| `JUKECORD_LDAP_CA_FILE`                                                 |  built-in and the host’s own   | restart | A file of the certificates (PEM) the directory's own is checked against, in place of every connection's                                                            |
| `JUKECORD_LDAP_BIND_DN`                                                 |      an anonymous search       | restart | The account that finds people: a DN, or name@domain for Active Directory                                                                                           |
| `JUKECORD_LDAP_BIND_PASSWORD`, `JUKECORD_LDAP_BIND_PASSWORD_FILE`       |                                | restart | The service account's password                                                                                                                                     |
| `JUKECORD_LDAP_BASE_DN`                                                 |                                | restart | Where people are looked for                                                                                                                                        |
| `JUKECORD_LDAP_USER_FILTER`                                             |       `(uid={username})`       | restart | The filter that finds one person, {username} where the name typed goes (Active Directory's: (sAMAccountName={username}))                                           |
| `JUKECORD_LDAP_GROUP_FILTER`                                            |            memberOf            | restart | A filter that finds a person's groups, with {dn} or {username}, in place of their memberOf                                                                         |
| `JUKECORD_LDAP_GROUP_BASE_DN`                                           |          the base DN           | restart | Where groups are looked for                                                                                                                                        |
| `JUKECORD_LDAP_NESTED_GROUPS`                                           |              `no`              | restart | Groups through Active Directory's rule for groups in groups                                                                                                        |
| `JUKECORD_LDAP_ADMIN_GROUPS`                                            |                                | restart | Groups (DNs or names) whose people may do what the host may; * is everyone the directory knows                                                                     |
| `JUKECORD_LDAP_CONTROL_GROUPS`                                          |                                | restart | Groups (DNs or names) whose people change the music in every server                                                                                                |
| `JUKECORD_LDAP_READ_GROUPS`                                             |                                | restart | Groups (DNs or names) whose people look and listen                                                                                                                 |
| `JUKECORD_LDAP_TIMEOUT`                                                 |             `10s`              | restart | How long connecting, and each request after, may take                                                                                                              |
| `JUKECORD_LDAP_LABEL`                                                   |        the panel’s own         | restart | The words on the login page’s key for directory accounts                                                                                                           |
| **Database**                                                            |                                |         |                                                                                                                                                                    |
| `JUKECORD_DATABASE_URL`, `JUKECORD_DATABASE_URL_FILE`                   |           `sqlite:`            | restart | Where the data is: sqlite: (the data folder’s file), sqlite:/a/file.db, postgres://… or mysql://…                                                                  |
| `JUKECORD_DATABASE_POOL`                                                |              `10`              | restart | The most connections jukecord opens to a database server (SQLite has its one)                                                                                      |
| **Cache and bus**                                                       |                                |         |                                                                                                                                                                    |
| `JUKECORD_BUS_URL`, `JUKECORD_BUS_URL_FILE`                             |                                | restart | The Redis or Valkey server the services of a split jukecord talk through (redis://, rediss:// for TLS)                                                             |
| `JUKECORD_CACHE_URL`, `JUKECORD_CACHE_URL_FILE`                         |            `memory`            | restart | Where the rates, logins and searches are kept between requests: in memory, or on a Redis or Valkey server                                                          |
| `JUKECORD_KEY_PREFIX`                                                   |           `jukecord`           | restart | What every key and channel on that server goes under, so several jukecords can share one                                                                           |
| **Certificate authorities**                                             |                                |         |                                                                                                                                                                    |
| `JUKECORD_CA_FILE`                                                      |         built-in only          | restart | A PEM file of certificate authorities every TLS connection trusts besides the built-in ones: the database, the bus and cache, the identity provider, the directory |
| **Media and limits**                                                    |                                |         |                                                                                                                                                                    |
| `JUKECORD_QUEUE_MAX`                                                    |             `1000`             | at once | The most tracks a server's queue holds                                                                                                                             |
| `JUKECORD_TRACK_MAX`                                                    |              `3h`              | at once | The longest track that may be added                                                                                                                                |
| `JUKECORD_REST_AFTER`                                                   |              `2m`              | at once | How long a server nobody hears plays on before it pauses; turned off, it plays on                                                                                  |
| `JUKECORD_CACHE_MAX`                                                    |             `2GiB`             | at once | The most the media cache holds; the tracks played longest ago go first                                                                                             |
| `JUKECORD_FETCH_TIMEOUT`                                                |             `60s`              | restart | How long getting one track may take                                                                                                                                |
| `JUKECORD_PREFETCH`                                                     |              `2`               | at once | How many of the next tracks are fetched ahead of time                                                                                                              |
| `JUKECORD_ALLOW_PRIVATE_ADDRESSES`                                      |            `false`             | restart | Also fetches from addresses on private networks (a media server on the local network)                                                                              |
| `JUKECORD_YTDLP_COOKIES`                                                |                                | restart | A cookies file for YouTube's sign-in check; yt-dlp gets a copy of it                                                                                               |
| `JUKECORD_YTDLP`                                                        |            `yt-dlp`            | restart | The yt-dlp program jukecord runs                                                                                                                                   |
| `JUKECORD_FFMPEG`                                                       |            `ffmpeg`            | restart | The ffmpeg program jukecord runs                                                                                                                                   |
| `JUKECORD_LYRICS`                                                       |              `on`              | at once | Lyrics of the track playing, from LRCLIB; turned off, LRCLIB is asked nothing                                                                                      |
| `JUKECORD_LINK_SERVICES`                                                | `deezer, spotify, apple-music` | at once | The music services whose links jukecord reads and finds on YouTube                                                                                                 |
| `JUKECORD_SPOTIFY_CLIENT_ID`                                            |                                | at once | Your own Spotify app’s client ID, for Spotify albums and playlists                                                                                                 |
| `JUKECORD_SPOTIFY_CLIENT_SECRET`, `JUKECORD_SPOTIFY_CLIENT_SECRET_FILE` |                                | at once | The Spotify app's client secret                                                                                                                                    |
| **Backups**                                                             |                                |         |                                                                                                                                                                    |
| `JUKECORD_BACKUP_AT`                                                    |             `off`              | at once | A backup of the database every day at this time, in jukecord’s time zone; turned off, none is made                                                                 |
| `JUKECORD_BACKUP_KEEP`                                                  |              `7`               | at once | How many backups the backups folder keeps                                                                                                                          |
| **Logging and monitoring**                                              |                                |         |                                                                                                                                                                    |
| `JUKECORD_LOG_LEVEL`                                                    |             `info`             | at once | How much the log keeps: every detail, the usual, or warnings and errors only                                                                                       |
| `JUKECORD_LOG_FORMAT`                                                   |             `text`             | at once | The console's lines as text, or as JSON for a log shipper; the log files are JSON either way                                                                       |
| `JUKECORD_LOG_MAX`                                                      |             `5MiB`             | at once | The size at which a log file is put aside for a new one                                                                                                            |
| `JUKECORD_LOG_FILES`                                                    |              `5`               | at once | How many log files are kept, the current one included                                                                                                              |
| `JUKECORD_METRICS_TOKEN`, `JUKECORD_METRICS_TOKEN_FILE`                 |                                | at once | A token that lets a scraper read /metrics from anywhere (Authorization: Bearer)                                                                                    |
| **Services**                                                            |                                |         |                                                                                                                                                                    |
| `JUKECORD_ROLE`                                                         |             `all`              | restart | One process does everything; or a core (Discord, the players and the media) and edges (the panel and the API)                                                      |
| `JUKECORD_INTERNAL_PORT`                                                |             `8796`             | restart | The core's port for its edges: the audio and the covers, for edges only                                                                                            |
| `JUKECORD_INTERNAL_SECRET`, `JUKECORD_INTERNAL_SECRET_FILE`             |                                | restart | The secret the core and its edges share, 32 characters or more                                                                                                     |
| `JUKECORD_CORE_URL`                                                     |                                | restart | Where an edge reaches the core's internal port (http://core:8796)                                                                                                  |

<!-- settings:end -->

Docker Compose also reads `JUKECORD_BIND` and `JUKECORD_IMAGE` ([installing](INSTALL.md#docker-compose)).
