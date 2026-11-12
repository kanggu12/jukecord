# Troubleshooting

Start with `./jukecord doctor` (or `jukecord doctor` inside the pod): it checks the data directory, the database,
ffmpeg, yt-dlp, the cache, Discord and the login, and says which part fails.

## "Sign in to confirm you're not a bot"

YouTube asks machines it distrusts (often servers and VPNs) to sign in. Give yt-dlp the cookies of a browser that is
signed in to YouTube:

1. In that browser, export the cookies for youtube.com in Netscape format (a "cookies.txt" export extension does it).
2. Put the file where jukecord can read it. With Compose, copy it into the volume (Docker gives the copy the source's
   permissions, so make it readable first): `chmod 644 cookies.txt && docker compose cp cookies.txt jukecord:/data/cookies.txt`.
3. Set `JUKECORD_YTDLP_COOKIES=/data/cookies.txt` in `.env` and `./jukecord up`.

jukecord gives yt-dlp a private copy, so the file itself is never changed. Cookies expire; export them again when the
message comes back.

## A track does not play

The error under the title says why (the site's own message, from yt-dlp). Common ones: the video is private or
deleted, it is only available in other countries, or it is longer than `JUKECORD_TRACK_MAX`. A failure that looks
passing (a 5xx answer, a timeout) is tried once more by itself.

## The bot does not join or is silent

- It needs the **View Channels**, **Connect** and **Speak** permissions in that channel; jukecord says so when one is
  missing.
- Voice uses UDP to Discord's voice servers. A firewall or a NetworkPolicy that allows only TCP 443 out lets the bot
  log in and join, but no sound arrives. The chart's policy allows the internet on every port.
- `JUKECORD_LOG_LEVEL=debug` logs how much sound went out at the end of each track (`voice stream ended ... sentMs`).

## "Listen here" stays silent

Browsers play sound only after a click on the page; press **Listen here** again if the bar says the browser held the
sound back. Safari versions without Ogg Opus get the MP3 copy automatically.

## "Too many live connections"

The panel says why jukecord turned its live connection away, and tries again by itself a little later.

- "from this address": every browser seems to come from one address, which is what a reverse proxy looks like when
  jukecord is not told about it. Set `JUKECORD_TRUST_PROXY` (`1` for one proxy in front) so each browser counts as
  itself; twenty connections per address are allowed.
- "for this login": one browser (or one API token) has ten live connections open already; close a few of its tabs.
- "jukecord has as many live connections as it allows": `JUKECORD_LIVE_MAX` (1000 by default) are open. A machine
  that can take more can be given a higher one.

## Logging in with Discord fails

- `redirect_uri` errors: the address in **Redirects** must be exactly `<JUKECORD_PUBLIC_URL>/auth/callback` (or
  `http://localhost:<JUKECORD_PORT>/auth/callback` without a public address).
- "You are not in a server that jukecord is in": the bot must be in a server you are a member of.
- Behind a reverse proxy, set `JUKECORD_PUBLIC_URL` to the proxy's address and `JUKECORD_TRUST_PROXY=1`.

## jukecord does not start

It prints every settings problem at once and exits with code 2. Another message to look for: "the database is at schema
N, newer than this jukecord knows": a newer jukecord wrote it; run the newer version or restore a backup.

## jukecord started again by itself

`the main thread has not answered for 30 s; ending the process so that it is started again` in `./jukecord logs`
means jukecord was stuck and ended itself, so that Docker (or Kubernetes, or the systemd unit) would start it again:
Docker restarts a container that exits, not one that hangs. Every server comes back paused where it was. The lines
before it say what it was doing; please put them in an issue.

## The port is taken

Set another one: `JUKECORD_PORT=8796` in `.env`, then `./jukecord up`.
