#!/usr/bin/env bash
# jukecord split into services, end to end with Docker Compose (deploy/split/compose.yaml): a core, two edges, the
# database, Valkey and Caddy, under a throwaway project name, browser-only (no Discord). It opens a login link made in
# one edge at the other, adds a track through one edge and sees the change arrive on a live connection of the other,
# plays the track's audio through an edge (a Range request too, and through the front), restarts the core and sees
# the edges and their panels recover, then removes everything it started: the containers, their network and volumes,
# the throwaway files, and the image it built.
#
#   tests/split/run.sh [postgres|mysql] [image]
#
# With an image named (jukecord:ci, say) it uses that one and leaves it; otherwise it builds jukecord-test-split:e2e
# from this checkout. Publishes 127.0.0.1:18795-18798 while it runs (the front, both edges, the core's own port).
# Needs docker with Compose 2.24 or newer and Node.js. Used by .github/workflows/ci.yml and by hand.
set -euo pipefail
cd "$(dirname "$0")/../.."

database=${1:-postgres}
case "$database" in
  postgres | mysql) ;;
  *)
    echo "usage: tests/split/run.sh [postgres|mysql] [image]" >&2
    exit 2
    ;;
esac
image=${2:-}
built=0
project=jukecord-test-split-e2e-$$
work=$(mktemp -d)

say() { printf '\n== %s\n' "$*"; }

# The split's settings for this run only: throwaway secrets, the image, the ports.
cat > "$work/split.env" <<EOF
JUKECORD_DB_PASSWORD=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
JUKECORD_INTERNAL_SECRET=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
JUKECORD_IMAGE=${image:-jukecord-test-split:e2e}
JUKECORD_E2E_MEDIA=$work/media
EOF
files=(-f deploy/split/compose.yaml)
if [ "$database" = mysql ]; then files+=(-f deploy/split/compose.mysql.yaml); fi
files+=(-f tests/split/compose.e2e.yaml)
compose=(docker compose -p "$project" --env-file "$work/split.env" "${files[@]}")

cleanup() {
  status=$?
  if [ "$status" != 0 ]; then
    say "what the services said (the run failed)"
    "${compose[@]}" logs --no-color --tail 80 core edge1 edge2 2>&1 || true
  fi
  "${compose[@]}" down --volumes --remove-orphans --timeout 20 >/dev/null 2>&1 || true
  if [ "$built" = 1 ]; then docker image rm jukecord-test-split:e2e >/dev/null 2>&1 || true; fi
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

if [ -z "$image" ]; then
  say "the image, from this checkout"
  docker build -q -f deploy/docker/Dockerfile -t jukecord-test-split:e2e . >/dev/null
  built=1
fi

say "a track for the file server (eight seconds of noise, as Ogg Opus, made by the image's FFmpeg)"
mkdir -p "$work/media"
chmod 0755 "$work" "$work/media"
docker run --rm --user "$(id -u):$(id -g)" -v "$work/media:/out" --entrypoint ffmpeg "${image:-jukecord-test-split:e2e}" \
  -hide_banner -loglevel error -filter_complex "anoisesrc=d=8:c=pink:a=0.2" -ac 2 -c:a libopus -b:a 96k /out/tone.ogg
chmod 0644 "$work/media/tone.ogg"

say "the split ($database), project $project"
"${compose[@]}" up -d --wait --wait-timeout 240

say "a token for the checks, made inside an edge as the host does (a row every edge reads)"
token=$("${compose[@]}" exec -T edge1 jukecord token create e2e --scope admin | head -n 1)
test "${token#jkc_}" != "$token"

say "a login link, made inside an edge as \`jukecord link\` does (kept on the shared cache, opened at the other)"
link=$("${compose[@]}" exec -T edge1 jukecord link | head -n 1)

say "the checks"
JUKECORD_E2E_TOKEN=$token \
  JUKECORD_E2E_LINK=$link \
  JUKECORD_E2E_DATABASE=$database \
  JUKECORD_E2E_FRONT=http://127.0.0.1:18795 \
  JUKECORD_E2E_EDGE1=http://127.0.0.1:18796 \
  JUKECORD_E2E_EDGE2=http://127.0.0.1:18797 \
  JUKECORD_E2E_CORE=http://127.0.0.1:18798 \
  JUKECORD_E2E_RESTART="${compose[*]} restart core" \
  node --disable-warning=ExperimentalWarning tests/split/check.ts

say "all good ($database)"
