<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img alt="jukecord" src="docs/assets/logo-light.svg" width="300">
  </picture>
</p>

<p align="center">
  <b>A self-hosted Discord music bot whose queue you also hear in the browser.</b><br>
  Friends in the voice channel and friends with only a browser tab hear the same song at the same second.
</p>

<p align="center">
  <a href="https://github.com/kanggu12/jukecord/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/kanggu12/jukecord/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/kanggu12/jukecord/releases"><img alt="Release v0.3.0" src="docs/assets/badges/release.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="docs/assets/badges/license.svg"></a>
  <img alt="Runs on amd64 and arm64" src="docs/assets/badges/platforms.svg">
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> &nbsp;|&nbsp;
  <a href="#what-it-does">What it does</a> &nbsp;|&nbsp;
  <a href="#how-it-works">How it works</a> &nbsp;|&nbsp;
  <a href="#for-contributors">For contributors</a> &nbsp;|&nbsp;
  <a href="#guides">Guides</a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/panel-dark.webp">
    <img alt="The jukecord panel for a made-up Discord server, Night Owls. The track playing turns on a disc beside its progress bar and keys; the queue below lists each track with its cover, its length and who added it. On the right, the bot is in the voice channel Lounge with four people, three people listen in their browsers, and the recently played tracks follow. The bar at the bottom offers to play the music in this browser too." src="docs/assets/panel-light.webp" width="100%">
  </picture>
</p>

jukecord plays music from YouTube, SoundCloud and the other sites [yt-dlp](https://github.com/yt-dlp/yt-dlp) reads in
a Discord voice channel. Its web panel shows the same queue, and **Listen here** plays it in any browser at the same
place in the track. It runs on your own computer, a Raspberry Pi or a Kubernetes cluster.

## Quick start

<table>
<tr>
<th width="50%" align="left">Listen</th>
<th width="50%" align="left">Host</th>
</tr>
<tr>
<td valign="top">

On a jukecord someone runs for your server:

1. Open the address the host gives you and log in with Discord, or open a listening link: it needs no account.
2. Press **Listen here**. The queue plays in your browser, in step with the voice channel, at your own volume.
3. Add music in the panel or with `/play` in Discord.

**[Using jukecord](docs/README.md)**

</td>
<td valign="top">

On a computer that stays on while people listen:

1. Start it with the commands below for your system.
2. [Make the Discord bot](#the-discord-bot) and give jukecord its token, or skip it to play in browsers only.
3. `./jukecord open` logs you in; **Invite** in the panel makes links for friends.

**[Installing](docs/INSTALL.md)**

</td>
</tr>
</table>

**Docker Compose** on Linux, macOS or Windows (WSL):

```bash
git clone https://github.com/kanggu12/jukecord.git && cd jukecord
./jukecord up
./jukecord open
```

With the bot's token:

```bash
echo 'JUKECORD_DISCORD_TOKEN=YOUR_BOT_TOKEN' >> .env
./jukecord up
```

**Kubernetes:** the Helm chart from `oci://ghcr.io/kanggu12/charts/jukecord`, the token in a Secret of your own:
[install on a cluster](docs/KUBERNETES.md#install).

**From source**, with Node 24.11 or newer, ffmpeg and yt-dlp installed (`node src/cli/main.ts link` then prints a
login link):

```bash
git clone https://github.com/kanggu12/jukecord.git && cd jukecord
npm ci && npm run build
JUKECORD_DISCORD_TOKEN=YOUR_BOT_TOKEN npm start
```

### The Discord bot

1. On the [Discord Developer Portal](https://discord.com/developers/applications), make an application, open **Bot**
   and press **Reset Token**. That token is `JUKECORD_DISCORD_TOKEN`.
2. Open **OAuth2**, tick the scopes `bot` and `applications.commands` and the permissions **View Channels**, **Connect**
   and **Speak**, then open the link it makes to add the bot to your server.
3. For logging in with Discord, put the **Client ID** and **Client Secret** in `JUKECORD_DISCORD_CLIENT_ID` and
   `JUKECORD_DISCORD_CLIENT_SECRET`, and add `<your panel's address>/auth/callback` to **Redirects**.

## What it does

- **Listen along.** **Listen here** plays the queue in a browser in step with the voice channel; the media keys and
  the lock screen control it.
- **One queue, four ways in.** The panel, slash commands in English and Korean, the `jukecord` command and an
  [HTTP API](docs/API.md), under the same rules.
- **Guests without Discord.** A listening link for 1, 7 or 30 days, with a QR code; revoking it ends its guests at once.
- **Logins and roles.** People log in with Discord; a DJ role decides who may change the music.
- **Steady and small.** One process and one SQLite file; each track is fetched once, its loudness evened out.

### Listen together

The lyrics follow the line being sung, for everyone. The light behind the glass moves with the music. On a phone the
panel installs like an app, with a sleep timer.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/phones-dark.webp">
    <img alt="The panel on a phone, three screens. The player listening along, in time with the others, with the keys under the track and the bar at the bottom. The queue, where each track's keys wait behind its menu key. The statistics: plays, time listened, tracks and people, then plays per day." src="docs/assets/phones-light.webp" width="100%">
  </picture>
</p>

### Find music, keep it

Search as you type, autoplay from the server's own plays when the queue runs out, likes, playlists as files, and links
from Deezer, Spotify and Apple Music.

### Fair in a crowd

With a DJ role, a skip from anyone else is a vote. People can take turns and be held to a number of tracks. The voice
channel has a volume and sounds to choose, which browsers listening along hear too.

### Wrapped

A server's year in music, or a month, saved as a picture for a story or a post.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wrapped-dark.webp">
    <img alt="Wrapped's picture for a made-up server, Night Owls: the last 12 months in music, with the song of the year on its cover and record, the plays, hours, tracks and days with music, the most played tracks and the people who added most." src="docs/assets/wrapped-light.webp" width="420">
  </picture>
</p>

## How it works

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/how-it-works-dark.svg">
    <img alt="How jukecord works. You and your friends use slash commands in Discord, the panel, the jukecord command or the HTTP API, and every one of them goes through one list of actions and one permission check, the DJ role. jukecord fetches tracks from YouTube, SoundCloud and the other sites yt-dlp reads, through its own proxy that reaches only public addresses, evens out their loudness once and keeps them as Opus. Each Discord server has one queue and one player, and the player is the clock: here it plays Glass Garden (Live at the Old Hall), at 1:09 of 3:00. Rainbow lines carry the music people hear: the bot plays it live in the voice channel from the clock's place, at the volume the server set, and a browser that presses Listen here plays the same file within 0.3 seconds of the clock, at its own volume." src="docs/assets/how-it-works-light.svg" width="100%">
  </picture>
</p>

Each Discord server has one queue and one player, and the player is the clock that the voice channel and every browser
follow ([architecture](docs/ARCHITECTURE.md)). On two cores with a year of use in it, jukecord rests at about 85 MiB
of memory, and a thousand open panels see each change within about a tenth of a second
([measured](docs/TESTING.md#measurements)).

### Your data

Everything stays in jukecord's data folder: one SQLite file and the tracks it fetched. Logins and tokens are kept as
hashes, and nothing is sent as telemetry. jukecord talks to Discord, to the sites the tracks come from and, for lyrics,
to LRCLIB ([what leaves your computer](docs/FAQ.md#privacy)).

## For contributors

jukecord is MIT licensed and built in the open. The tests need no Discord bot and reach no site: yt-dlp and Discord
have stand-ins, and the panel is checked in a browser against a seeded server. [CONTRIBUTING.md](CONTRIBUTING.md) has
the setup and the checks.

| Path                     | What it is                                                                               |
| :----------------------- | :--------------------------------------------------------------------------------------- |
| `src/app/`               | The actions, one function per thing a person can do, and who may do it                   |
| `src/core/`              | Each server's queue and player, the clock, the words the bot and the panel share         |
| `src/media/`             | yt-dlp and ffmpeg, the cache, covers, lyrics, links of other services, the address guard |
| `src/web/`               | The HTTP API, the logins and the live updates                                            |
| `src/discord/`           | The bot: slash commands, cards and the voice channel                                     |
| `src/cli/`, `src/store/` | The `jukecord` command; SQLite and its migrations                                        |
| `panel/`                 | The web panel: TypeScript and one stylesheet                                             |
| `deploy/`, `tests/`      | The image, the Helm chart and its kind check; the tests and the panel's walk             |

Report a bug or ask for a feature in [Issues](https://github.com/kanggu12/jukecord/issues/new/choose); see what changed
in [CHANGELOG.md](CHANGELOG.md), and report a security problem through [SECURITY.md](.github/SECURITY.md).

## What it runs on

|                    | Needs                                                                                                                                   |
| :----------------- | :-------------------------------------------------------------------------------------------------------------------------------------- |
| **Docker Compose** | Linux, macOS or Windows (WSL), amd64 or arm64, Docker with Compose 2.24 or newer; 430 MB for the image, 2 GiB for the cache             |
| **Raspberry Pi**   | A Pi 4 or 5 with a 64-bit system, through Docker Compose with a [released image](docs/INSTALL.md#raspberry-pi-and-other-arm64-machines) |
| **Kubernetes**     | The Helm chart on amd64 or arm64 nodes, k3s included, with a 5 GiB volume                                                               |
| **From source**    | Node 24.11 or newer, ffmpeg with libopus, and yt-dlp                                                                                    |
| **Listening**      | A current browser on a computer or a phone                                                                                              |

## Guides

### For listeners

| Guide                                | What it covers                                                                       |
| :----------------------------------- | :----------------------------------------------------------------------------------- |
| [Using jukecord](docs/README.md)     | The panel, the slash commands, the `jukecord` command, who may do what, the settings |
| [Questions and answers](docs/FAQ.md) | Listening with friends, what it takes to run, what leaves your computer              |

### For hosts

| Guide                                      | What it covers                                                                            |
| :----------------------------------------- | :---------------------------------------------------------------------------------------- |
| [Installing](docs/INSTALL.md)              | Docker Compose, friends on other machines, logging in with Discord, everyday use, updates |
| [Kubernetes](docs/KUBERNETES.md)           | The Helm chart: its values, the Ingress, the NetworkPolicy, k3s                           |
| [Without internet](docs/OFFLINE.md)        | Moving the image and the data to a machine without internet access                        |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | YouTube's bot check, a silent bot or browser, logins, a port in use                       |

### For contributors

| Guide                                                                                              | What it covers                                                                        |
| :------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------ |
| [The API](docs/API.md)                                                                             | Every operation over HTTP, beside its command and slash command, and the live updates |
| [Architecture](docs/ARCHITECTURE.md) · [Decisions](docs/DECISIONS.md) · [Testing](docs/TESTING.md) | How it is built, why, and how it is checked                                           |

## License

[MIT](LICENSE). The image carries FFmpeg, yt-dlp and other parts under their own licences
([third-party notices](docs/THIRD_PARTY_NOTICES.md)).
