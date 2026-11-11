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
- A container image for linux/amd64 and linux/arm64 with ffmpeg and the official yt-dlp build, checked against its
  published checksum. yt-dlp runs YouTube's scripts with the image's Node; no Python or Deno in the image.

[Unreleased]: https://github.com/kanggu12/jukecord/commits/main
