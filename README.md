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
  <a href="https://github.com/kanggu12/jukecord/releases"><img alt="Release v0.3.2" src="docs/assets/badges/release.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="docs/assets/badges/license.svg"></a>
  <img alt="Runs on amd64 and arm64" src="docs/assets/badges/platforms.svg">
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> &nbsp;|&nbsp;
  <a href="#what-it-does">What it does</a> &nbsp;|&nbsp;
  <a href="#how-it-works">How it works</a> &nbsp;|&nbsp;
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

With Docker Compose on Linux, macOS or Windows (WSL):

```bash
git clone https://github.com/kanggu12/jukecord.git && cd jukecord
./jukecord up
./jukecord open
```

`./jukecord open` logs you in to the panel, and **Invite** there makes links for friends: they open one, press
**Listen here** and hear the queue in step, each at their own volume. To play in a voice channel too,
[make the Discord bot](#the-discord-bot) and give jukecord its token:

```bash
echo 'JUKECORD_DISCORD_TOKEN=YOUR_BOT_TOKEN' >> .env
./jukecord up
```

On a cluster, the Helm chart takes the token from a Secret of your own ([Kubernetes](docs/KUBERNETES.md#install)).
[Installing](docs/INSTALL.md) covers a Raspberry Pi, friends on other machines and running
[from source](docs/INSTALL.md#from-source).

### The Discord bot

1. On the [Discord Developer Portal](https://discord.com/developers/applications), make an application, open **Bot**
   and press **Reset Token**. That token is `JUKECORD_DISCORD_TOKEN`.
2. Open **OAuth2**, tick the scopes `bot` and `applications.commands` and the permissions **View Channels**, **Connect**
   and **Speak**, then open the link it makes to add the bot to your server.
3. For logging in with Discord, put the **Client ID** and **Client Secret** in `JUKECORD_DISCORD_CLIENT_ID` and
   `JUKECORD_DISCORD_CLIENT_SECRET`, and add `<your panel's address>/auth/callback` to **Redirects**.

## What it does

### In Discord

Slash commands in English and Korean, with tracks suggested as you type. The bot plays in your voice channel, says what
it added and keeps one card of the track playing up to date, with keys to pause, skip (a vote, where a DJ role is set)
and open the panel.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/discord-dark.webp">
    <img alt="jukecord in a made-up Discord server, Night Owls. On the left, the bot is in the voice channel Lounge with Mina, Joon, Sol and 하늘, its picture ringed in green as it plays. In the channel music, Joon used /add, and the bot answers that Morning Light was added as the third track. Below, the bot's card of the track playing: Paper Boats on the River, added by Mina, at 1:12 of 3:00, autoplay on from this server's plays and one of two votes to skip, with the keys Pause, Skip (1 of 2) and Open the panel. Over the message box, Discord suggests jukecord's commands: /play, /add, /listen, /lyrics and /share." src="docs/assets/discord-light.webp" width="100%">
  </picture>
</p>

### In any browser, in step

**Listen here** plays the queue in step with the voice channel, for a friend at work or on a phone. The lyrics follow
the line being sung, a search shows what YouTube found as you type, and a listening link with its QR code needs no
Discord account.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/phones-features-dark.webp">
    <img alt="The panel on a phone, three screens. The lyrics of the track playing, the line being sung lit. A search for paper boats, with what YouTube found under the add field, each to play now, next or later. The Invite dialog with a listening link for seven days and its QR code." src="docs/assets/phones-features-light.webp" width="100%">
  </picture>
</p>

### And the rest

- **One queue, four ways in:** the panel, slash commands, the `jukecord` command and an [HTTP API](docs/API.md), under
  the same rules; a DJ role decides who may change the music.
- **Fair in a crowd:** votes to skip, people taking turns and a limit per person.
- **Autoplay, likes and playlists** as files, and links from Deezer, Spotify and Apple Music.
- **Wrapped:** a server's year in music, saved as a picture for a story or a post.
- **Steady and small:** one process and one SQLite file, tracks fetched once with their loudness evened out.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wrapped-dark.webp">
    <img alt="Wrapped's picture for a made-up server, Night Owls: the last 12 months in music, with the song of the year on its cover and record, the plays, hours, tracks and days with music, the most played tracks and the people who added most." src="docs/assets/wrapped-light.webp" width="420">
  </picture>
</p>

## How it works

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/how-it-works-dark.webp">
    <img alt="How jukecord works. At the top, you and your friends use slash commands in Discord, the panel, the jukecord command or the HTTP API, and tracks come from YouTube, SoundCloud and the other sites yt-dlp reads, fetched once through jukecord's own proxy. In the middle, jukecord plays Paper Boats on the River at 1:12 of 3:00 on its turning disc, with Morning Light, Copper Skies and Neon Rain up next: one list of actions with one DJ role check, the player as the clock everyone follows, and tracks with their loudness evened out, kept as Opus. Rainbow lines carry the music down to the voice channel Lounge, where the bot plays live among four people, and to browsers on a laptop and a phone, which play the same file on the same clock, each at its own volume." src="docs/assets/how-it-works-light.webp" width="100%">
  </picture>
</p>

Each Discord server has one queue and one player, and the player is the clock that the voice channel and every browser
follow ([architecture](docs/ARCHITECTURE.md)). On two cores with a year of use in it, jukecord rests at about 85 MiB
of memory, and a thousand open panels see each change within about a tenth of a second
([measured](docs/TESTING.md#measurements)).

### Your data

Everything stays in jukecord's data folder: one SQLite file and the tracks it fetched. Logins and tokens are kept as
hashes, and nothing is sent as telemetry ([what leaves your computer](docs/FAQ.md#privacy)).

## What it runs on

Linux, macOS and Windows (WSL) with Docker Compose 2.24 or newer, on amd64 or arm64, a Raspberry Pi 4 or 5 with a
64-bit system included; a Kubernetes cluster, k3s too, through the Helm chart; or Node 24.11 or newer with ffmpeg and
yt-dlp. It takes 430 MB for the image and 2 GiB for its cache. Listening needs only a current browser, on a computer or
a phone.

## Guides

- [Using jukecord](docs/README.md): the panel, the slash commands, the `jukecord` command, who may do what, the settings
- [Installing](docs/INSTALL.md), [Kubernetes](docs/KUBERNETES.md) and [without internet](docs/OFFLINE.md), for hosts
- [Questions and answers](docs/FAQ.md) and [troubleshooting](docs/TROUBLESHOOTING.md)
- [The API](docs/API.md), [architecture](docs/ARCHITECTURE.md), [decisions](docs/DECISIONS.md) and
  [testing](docs/TESTING.md)

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) has the setup, the map of the code and the checks a change goes through. Bugs and
ideas go to [Issues](https://github.com/kanggu12/jukecord/issues).

## License

[MIT](LICENSE). The image carries FFmpeg, yt-dlp and other parts under their own licences
([third-party notices](docs/THIRD_PARTY_NOTICES.md)).
