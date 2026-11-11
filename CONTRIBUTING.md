# Contributing

Thank you for helping. Bug reports, fixes and new features are all welcome; for a larger change, open an issue first
so we can agree on the shape before you spend the time.

## Set up

Node 24 or newer, ffmpeg with libopus (for the integration tests), and Docker (for the image, the panel walk and the
chart test).

```bash
npm ci
npm run build      # the panel, into panel/dist
npm run check      # lint, types, unit and integration tests
npm start          # browser-only on http://localhost:8795 (data in ./data)
```

`node src/cli/main.ts link` makes a login link for the panel; any `jukecord` command works the same way.

## How the code is laid out

[ARCHITECTURE.md](docs/ARCHITECTURE.md) has the parts and how they talk; [DECISIONS.md](docs/DECISIONS.md) says why.
The one rule that shapes most changes: a feature is an action in `src/app/actions.ts`, offered by all four ways in (the
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

## Versions and releases

The version is set in one place, `src/version.ts`; `package.json` and the chart's `version` and `appVersion` follow it
(`node scripts/check-version.ts` checks). Versions follow SemVer: a feature raises the minor number, a fix the patch.

To release:

1. Move the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md) under the new version with today's date. That section
   is the release's notes.
2. Set the version in `src/version.ts`, `package.json` and `deploy/helm/jukecord/Chart.yaml`, run
   `sh .github/badges.sh` and `node scripts/api-doc.ts`, and commit.
3. Tag `vX.Y.Z` and push the tag. `release.yml` checks the versions and the notes, runs the tests and the chart test,
   publishes the image for amd64 and arm64 and the chart to ghcr.io with signed build provenance, and makes the GitHub
   release.
