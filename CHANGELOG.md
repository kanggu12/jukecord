# Changelog

All notable changes to jukecord are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each release's section here is its release notes.

## [Unreleased]

### Added

- One queue per Discord server, kept in a SQLite database: add at the end, next or at a position, remove, move,
  reorder, shuffle (Fisher-Yates), remove duplicates, clear.
- A player per server that is the clock every listener follows: loading, playing, paused and idle, seeking with the
  first seek at once and the rest of a drag merged into the last, a time limit on getting a track ready, and a failed
  track skipped with the reason shown.
- History of played tracks (a skip in the first second is not a listen) and saved playlists.
- After a restart each server comes back with the same track, paused where it was.
- Settings from `JUKECORD_*` environment variables, all problems reported at once, secrets never printed.
- Logs as readable lines on the console and JSON lines in a file that is rotated at a size limit, with secrets masked.
- Adding by address or by search words: YouTube, SoundCloud and every other site yt-dlp supports; a playlist page
  adds its tracks (private, deleted and live entries left out); a video address with a playlist in it adds that video.
  Every spelling of one YouTube video is one track, and an address seen before is added without asking the site.
- A media cache with a size limit: each track is downloaded and encoded once (Opus, loudness evened out to -14 LUFS),
  its real length read from the file, the least recently used tracks removed first, the playing and next tracks never.
- The next tracks are fetched while the current one plays, one at a time, and a fetch the queue no longer needs stops.
  The player and the prefetcher share one download of the same track.
- An MP3 copy of a track is made for browsers that cannot play Opus (Safari), the first time one asks.
- A container image for linux/amd64 and linux/arm64 on Node 26 LTS and Debian 13 (ffmpeg 7.1), pinned by digest,
  with the official yt-dlp build checked against its published checksum. yt-dlp runs YouTube's scripts with the
  image's Node; no Python or Deno in the image.
- The Discord bot: slash commands for every action, with Korean names and descriptions (Discord shows each person
  their own language), answers as short cards with pause and skip buttons, and playlist names suggested as you type.
  It asks Discord only for the Guilds and GuildVoiceStates intents. Without a token jukecord runs browser-only.
- Voice: the cached Opus file is sent as it is (no encoder needed), a seek or a late join starts through ffmpeg from
  that place, voice is end-to-end encrypted (DAVE), and a dropped connection that recovers within 5 s is kept.
- Every action (add, play now, skip, pause, seek, queue edits, playlists, join, leave, status) lives in one place that
  the bot, the panel, the API and the CLI all call; a server's DJ role, when set, decides who may change the music.
- Repeat: off, this track (played again without fetching it again) or the queue (a finished track goes back to the
  end). The mode is kept across restarts.
- Download progress while a track loads, reported at most four times a second.
- Limits: tracks longer than `JUKECORD_TRACK_MAX` (3 hours) are left out and a server's queue holds at most
  `JUKECORD_QUEUE_MAX` (1000) tracks; the answer says how many were left out and why.
- A download that fails in a way that looks passing (a 5xx answer, a timeout, a reset connection) is tried once more
  after 2 s.
- When YouTube asks the server to sign in to prove it is not a bot, the error says so and how to give jukecord a
  cookies file (`JUKECORD_YTDLP_COOKIES`); yt-dlp works on a private copy, so the file can be mounted read-only.
- Secrets can come from files (`JUKECORD_DISCORD_TOKEN_FILE`, `JUKECORD_DISCORD_CLIENT_SECRET_FILE`), the way Docker
  and Kubernetes mount them.
- The bot joins your voice channel when you play something from Discord and it is not in one, and leaves a channel
  nobody is in after `JUKECORD_VOICE_IDLE` (5 minutes); the music goes on for the browsers.
- Slash commands are registered only when they change (Discord allows 200 registrations per server a day), and the
  "listening to" line under the bot's name changes at most every 15 s.
- The history keeps the newest 10,000 plays of each server.
- An error nothing handled is logged with its stack, and stopping gets 10 s before the process exits anyway.

[Unreleased]: https://github.com/kanggu12/jukecord/commits/main
