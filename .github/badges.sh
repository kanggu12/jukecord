#!/bin/sh
# Writes the README's badges into docs/assets/badges/. GitHub shows images from other sites through a proxy that gives
# up after a few seconds; a badge that is a file in the repository is served without that proxy. Run it after the
# version is set in src/version.ts:
#
#   sh .github/badges.sh
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
dir=docs/assets/badges
mkdir -p "$dir"

version=$(sed -n "s/^export const VERSION = '\([0-9][0-9.]*\)';.*/\1/p" src/version.ts)
[ -n "$version" ] || { echo "src/version.ts names no version" >&2; exit 1; }

# badge NAME SPEC writes shields.io's static badge SPEC (label-message-color, spaces as %20, "|" as %7C) to NAME.svg,
# whole or not at all
badge() {
  tmp="$dir/$1.svg.tmp"
  curl -fsS --retry 3 --max-time 30 -o "$tmp" "https://img.shields.io/badge/$2.svg"
  # an error page in place of a badge must not replace the one there is
  grep -q '<svg' "$tmp" || { echo "shields.io sent no SVG for $1" >&2; rm -f "$tmp"; exit 1; }
  mv "$tmp" "$dir/$1.svg"
}

badge release "release-v$version-2a78d6"
badge license "license-MIT-2a78d6"
badge platforms "runs%20on-amd64%20%7C%20arm64-555"

# the README's alt text says the same, for a reader without images
sed -i -e "s/alt=\"Release v[0-9][0-9.]*\"/alt=\"Release v$version\"/" README.md
echo "wrote $dir: release v$version"
