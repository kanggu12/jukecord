# Questions and answers

For people deciding whether to run jukecord, and for their friends: what it takes to run, listening together, what
leaves your computer, and the project.

## Running it

**What do I need?**
A computer with Docker that is on while people listen: Linux, macOS, Windows with WSL, or a Raspberry Pi 4 or 5 with a
64-bit system. A Kubernetes cluster works too, with the Helm chart. [What it runs on](../README.md#what-it-runs-on)
has the details.

**Do I need a Discord bot?**
No. Without one, jukecord keeps a single queue that the host plays in the browser. With one it plays in your Discord
servers' voice channels, and friends log in to the panel with Discord ([making the bot](../README.md#the-discord-bot)).

**How big a computer does it need?**
At rest jukecord takes about 100 MB of memory and next to no processor time. Fetching a track and evening out its
loudness keeps one core busy for a few seconds, once per track: about four for a four-minute track on a desktop,
longer on a Raspberry Pi. Playing it sends the file to Discord as it is, at the default volume and sound. The image
is about 430 MB, the cache keeps up to 2 GiB of tracks (`JUKECORD_CACHE_MAX`), and Compose gives the container 1 GiB
of memory, which a thousand open panels do not use up ([measurements](TESTING.md#measurements)).

**Do I have to open a port on my router?**
Not for Discord: the bot connects out, so the voice channel hears it wherever jukecord runs. Friends who listen in a
browser on other machines need to reach the panel, on the same network or through a reverse proxy with HTTPS
([friends on other machines](INSTALL.md#friends-on-other-machines)).

**Which sites does it play from?**
The ones [yt-dlp](https://github.com/yt-dlp/yt-dlp) reads: YouTube, SoundCloud and many more. A playlist's address adds
its tracks, and search words search YouTube. YouTube sometimes asks servers to sign in;
[troubleshooting](TROUBLESHOOTING.md#sign-in-to-confirm-youre-not-a-bot) has the way round it.

**Can one jukecord play in several Discord servers?**
Yes. Each server has its own queue, player, history, playlists and DJ role, and sees only its own. Tracks fetched ahead
take turns across the servers, and a track somebody is waiting for always starts at once.

**How many people can use it at once?**
A thousand panels open at once still see each change within a tenth of a second on two processor cores. The limits
are there for accidents, and past one the panel says so and tries again by itself:

| Limit                                    | Default |
| :--------------------------------------- | ------: |
| open panels in all (`JUKECORD_LIVE_MAX`) |    1000 |
| open panels for one login                |      10 |
| open panels from one address             |      20 |
| changes a second for one login           |      10 |
| skips a second for one login             |       2 |

**Does the computer have to stay on?**
Only while people listen. jukecord keeps each queue and the place in the track, and after a restart every server comes
back paused there.

**What happens when it is overwhelmed, or hangs?**
Falling behind, it answers "busy" to new audio and changes until it has caught up, so the voice channel and the open
panels come first. Hanging, it ends itself after 30 seconds so that Docker (Compose) or Kubernetes starts it again;
the panels reconnect by themselves.

**How do I update it, or move it to another computer?**
`./jukecord backup && git pull && ./jukecord update`; the database moves to the new version by itself. To move, start
jukecord on the new computer and `./jukecord restore` a backup from the old one; tracks are fetched again as they are
played ([updating](INSTALL.md#updating)).

## Listening

**What do my friends have to do?**
In Discord: join the voice channel and use the slash commands (`/play`, `/add`, `/np`, `/queue`). In a browser: open
the panel's address, log in with Discord and press **Listen here**. Everyone sees the servers they share with the bot.

**Can someone without Discord listen?**
Yes, with a listening link: whoever opens it listens along to that server in a browser for 1, 7 or 30 days, and
changes nothing. People who may change the music make one (**Invite** in the panel, `/share create`,
`jukecord share`) and can revoke it. The host can also let a friend in, to view or to control, with a one-time login
link (`jukecord link --scope read` or `--scope control`).

**Are the voice channel and the browser in time?**
A browser plays the same file as the voice channel and follows the player's clock; one more than 0.3 s off jumps back
in line.

**How much data does listening use?**
About 1 MB a minute: browsers get Opus at 128 kbit/s, or MP3 at 192 kbit/s (about 1.4 MB a minute) on Safari versions
without Opus. A browser may keep a track for a day, so a track played again comes from its cache.

**Does it work on a phone?**
Yes, in the phone's browser, and the lock screen controls it. Installed from the browser, the panel opens as an app
([as an app](README.md#the-rest-of-the-page)).

## Privacy

**What leaves my computer?**
jukecord sends no telemetry. It talks to Discord and to the sites the tracks come from, and also:

- **LRCLIB**, for lyrics: the song's title, artist, album and length, once per track, only when someone opens the
  lyrics of the track playing. `JUKECORD_LYRICS=off` turns this off.
- **YouTube**, for searches: the words typed. Autoplay's "related" mode asks YouTube for the mix of the track
  playing; its "history" mode asks nobody.
- **Deezer, Spotify or Apple Music**, for their links: the link is read from that service, and its tracks searched on
  YouTube by artist and title. `JUKECORD_LINK_SERVICES` turns each service off.

Every request jukecord makes goes to public addresses only. Each track's picture is fetched once and served by
jukecord; search results show YouTube's pictures, and people's pictures come from Discord.
[Your data](../README.md#your-data) says what it keeps, and where.

**Can people see servers they are not in?**
No. A login sees only the servers it shares with the bot. Where a server has a DJ role, only its DJs and the people
who can manage the server change the music; everyone else looks, and while listening may vote to skip.

## The project

**Does it cost anything?**
No. jukecord is MIT licensed, and the image and the chart are built from this repository in the open.

**Something does not work.**
`./jukecord doctor` checks every part and says which one fails; [troubleshooting](TROUBLESHOOTING.md) has the common
cases. If that does not help, [open an issue](https://github.com/kanggu12/jukecord/issues/new/choose) with what
`doctor` printed (it shows secrets only as set or not set).

**Can I help?**
Yes. [CONTRIBUTING.md](../CONTRIBUTING.md) has the setup and a map of the code, and the tests need no Discord bot.
