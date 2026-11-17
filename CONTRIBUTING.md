# Contributing

For people who change jukecord's code: the setup, the layout, the style, the tests, the pinned FFmpeg and yt-dlp, the
release's programs, and releases. For a larger change, open an issue first to agree on its shape.

## Set up

Node 24.11 or newer, ffmpeg with libopus (for the integration tests), and Docker (for the image, the panel walk and the
chart test).

```bash
npm ci
npm run build      # the panel, into panel/dist
npm run check      # lint, types, unit and integration tests
npm start          # browser-only, with its data in ./data
```

`node src/cli/main.ts link` makes a login link for the panel; every `jukecord` command runs the same way.

## How the code is laid out

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

[ARCHITECTURE.md](docs/ARCHITECTURE.md) has the parts and how they talk; [DECISIONS.md](docs/DECISIONS.md) says why.
The rule that shapes most changes: a feature is an action in `src/app/actions.ts`, offered by all four ways in (the
panel, a slash command, the API table in `src/web/api.ts`, a CLI command). The compiler and the parity tests point at
the place you forgot.

## Style

- TypeScript, strict, run by Node without a build: only syntax Node can strip (no enums, namespaces or parameter
  properties). Biome formats and lints (`npm run format`).
- Comments say why a line is there, nearly line by line; names say what it is.
- Commit messages, comments and documents in English, in short plain sentences.
- Tests come with the change. Example data stays made-up: example.com addresses, invented titles and names.

## Tests

[TESTING.md](docs/TESTING.md) lists the suites. A change to the panel runs `tests/ui/run.sh` before it is merged (it
needs `docker build -f deploy/docker/Dockerfile -t jukecord:dev .` once); a change to the chart runs
`deploy/kind/check.sh`.

## FFmpeg

The image builds FFmpeg for audio only, from its release source (the `ffmpeg` stage of `deploy/docker/Dockerfile`).
To move to a newer release:

1. Check the `.tar.xz` against its signature with FFmpeg's release key (https://ffmpeg.org/ffmpeg-devel.asc).
2. Set `FFMPEG_VERSION` and `FFMPEG_SHA256`, and build. The stage fails when the Opus or MP3 encoder or https is
   missing, and CI runs jukecord's three FFmpeg commands in the image. The release's programs build the same release
   ([below](#the-releases-programs)).

A weekly check (`ffmpeg-release.yml`) fails when a newer release of the pinned line (7.1) is out, as the reminder to
bump it, and when a newer OpenSSL of its line is out than the one in the Linux programs' FFmpeg. A newer FFmpeg line
(8.0 after 7.1) only adds a notice to that run: moving to it is a choice, with its own testing.

## yt-dlp

The image and the release's programs carry yt-dlp's official one-folder build of one release (the `ytdlp` stage of
`deploy/docker/Dockerfile`, and `deploy/bundle/pins.json`), checked against the release's `SHA2-256SUMS`. To move to a
newer release, `node scripts/pins.ts yt-dlp <version>` takes each file's sum from that list and writes both, then
build.

A weekly check (`ytdlp-release.yml`) fails when a newer release is out. Sites change often, and an old yt-dlp soon
stops finding tracks: bump it within the week.

## The release's programs

Each release has jukecord for Linux, macOS and Windows on x64 and arm64 (`scripts/bundle.ts`): one folder with the
server, the command and the panel as the image has them, beside Node.js, FFmpeg, yt-dlp and a launcher
(`deploy/bundle/jukecord`, `deploy/bundle/jukecord.cmd`). `bundles.yml` builds FFmpeg for each
(`deploy/bundle/build-ffmpeg.sh`: in Docker for Linux and Windows, on a Mac for macOS), puts the six together on
Linux, and runs each on its own system and processor (`scripts/bundle-smoke.ts`: started, a track played through
yt-dlp and FFmpeg, stopped). To make one here:

```bash
deploy/bundle/build-ffmpeg.sh linux-x64 out/ffmpeg/linux-x64
node scripts/bundle.ts --ffmpeg out/ffmpeg --out out linux-x64
node scripts/bundle-smoke.ts out/jukecord-<version>-linux-x64.tar.gz
```

- Node.js is pinned in `deploy/bundle/pins.json`, at the image's line (26); `node scripts/pins.ts node <version>`
  moves it, with each file's sum from the release's `SHASUMS256.txt`. A weekly check (`node-release.yml`) fails when a
  newer release of the line is out.
- FFmpeg is the image's release, with the image's configure line; the libraries in it (OpenSSL on Linux, zlib, Opus
  and LAME) are pinned by version and SHA-256 at the top of `deploy/bundle/ffmpeg.sh`, at the releases of the image's.
- libatomic, which Node.js loads on Linux, is Debian's package from its snapshot archive (`pins.json`). llvm-mingw,
  which builds the Windows FFmpeg, is pinned in `deploy/bundle/Dockerfile`. Both move by hand.

## Dependabot

Once a week Dependabot proposes newer versions of the workflows' actions, of the Node base image's digest (the `FROM`
lines of the Dockerfile), of the images the programs' FFmpeg is built in (`deploy/bundle/Dockerfile`) and of the npm
packages, each kind in one pull request.

- A new major version of an npm package comes on its own. The next major version of Node is not proposed: moving to
  the next LTS is a decision.
- The outside actions (Docker's, `softprops/action-gh-release` and `azure/setup-helm`) run where a job's token may
  write, so they are pinned by commit, with the release beside it in a comment; Dependabot moves both together.
- The tools the workflows run (helm, kind and kubeconform) are pinned by version, kubeconform and kind with their
  checksums, and moved by hand.

## Versions and releases

The version is set in `src/version.ts`; `package.json`, the chart's `version` and `appVersion` and the image named in
its Artifact Hub annotation follow it (`node scripts/check-version.ts` checks). Versions follow SemVer: a feature
raises the minor number, a fix the patch.

1. Move the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md) under the new version with today's date. That section
   is the release's notes.
2. Set the version in `src/version.ts`, `package.json` and `deploy/helm/jukecord/Chart.yaml` (its `version`,
   `appVersion` and the image's tag in `artifacthub.io/images`), run `sh .github/badges.sh` (it also brings the
   guides' install lines to the version) and `node scripts/api-doc.ts`, and commit.
3. Tag `vX.Y.Z` and push the tag. `release.yml` checks the versions and the notes, runs the tests (on Linux, macOS
   and Windows), the chart test and the programs on each system, publishes the image for amd64 and arm64 and the chart
   to ghcr.io with signed build provenance, and makes the GitHub release with the programs, the chart and their
   checksums attached (`jukecord-X.Y.Z-linux-x64.tar.gz` ... `jukecord-X.Y.Z-windows-arm64.zip`,
   `jukecord-X.Y.Z-helm-chart.tgz`, `jukecord-X.Y.Z-checksums.txt`). Then `downloads.yml` downloads each program from
   the release, checks it against the checksums and its signed record, and runs it on its own system.
4. On a machine not logged in to ghcr.io, check that the image and the chart answer, as `docker pull` and
   `helm install` need. A private package answers "unauthorized": make it public on its page under the repository's
   **Packages**.

   ```bash
   docker manifest inspect ghcr.io/kanggu12/jukecord:X.Y.Z
   helm show chart oci://ghcr.io/kanggu12/charts/jukecord --version X.Y.Z
   ```
