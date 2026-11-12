# Contributing

For people who change jukecord's code: the setup, the layout, the style, the tests, the pinned FFmpeg and yt-dlp, and
releases. For a larger change, open an issue first to agree on its shape.

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
   missing, and CI runs jukecord's three FFmpeg commands in the image.

A weekly check (`ffmpeg-release.yml`) fails when a newer release of the pinned line (7.1) is out, as the reminder to
bump it. A newer line (8.0 after 7.1) only adds a notice to that run: moving to it is a choice, with its own testing.

## yt-dlp

The image carries yt-dlp's official one-folder build of one release (the `ytdlp` stage of `deploy/docker/Dockerfile`),
checked against the release's `SHA2-256SUMS`. To move to a newer release, set `YTDLP_VERSION` and the two sums (the
lines for `yt-dlp_linux.zip` and `yt-dlp_linux_aarch64.zip` in that release's `SHA2-256SUMS`), and build.

A weekly check (`ytdlp-release.yml`) fails when a newer release is out, and prints those two lines. Sites change often,
and an old yt-dlp soon stops finding tracks: bump it within the week.

## Dependabot

Once a week Dependabot proposes newer versions of the workflows' actions, of the Node base image's digest (the `FROM`
lines of the Dockerfile) and of the npm packages, each kind in one pull request.

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
   `appVersion` and the image's tag in `artifacthub.io/images`), run `sh .github/badges.sh` and
   `node scripts/api-doc.ts`, and commit.
3. Tag `vX.Y.Z` and push the tag. `release.yml` checks the versions and the notes, runs the tests and the chart test,
   publishes the image for amd64 and arm64 and the chart to ghcr.io with signed build provenance, and makes the GitHub
   release.
4. On a machine not logged in to ghcr.io, check that the image and the chart answer, as `docker pull` and
   `helm install` need. A private package answers "unauthorized": make it public on its page under the repository's
   **Packages**.

   ```bash
   docker manifest inspect ghcr.io/kanggu12/jukecord:X.Y.Z
   helm show chart oci://ghcr.io/kanggu12/charts/jukecord --version X.Y.Z
   ```
