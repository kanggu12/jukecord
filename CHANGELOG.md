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

[Unreleased]: https://github.com/kanggu12/jukecord/commits/main
