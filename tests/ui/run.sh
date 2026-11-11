#!/usr/bin/env bash
# Looks at the panel: seeds a throwaway jukecord with example data, starts it, and walks the panel with Playwright
# (tests/ui/walk.mjs), all in containers on a private network. Screenshots and report.json land in the folder given.
#
#   tests/ui/run.sh <output folder>
#
# Needs the jukecord image (docker build -f deploy/docker/Dockerfile -t jukecord:dev .) and a built panel
# (npm run build). The source is mounted over the image's, so a change needs no image rebuild.
set -euo pipefail
cd "$(dirname "$0")/../.."
out=$(realpath -m "${1:?say where the screenshots go}")
image=${JUKECORD_IMAGE:-jukecord:dev}
playwright=${PLAYWRIGHT_IMAGE:-mcr.microsoft.com/playwright:v1.60.0-noble}
work=$(mktemp -d)
network=jukecord-ui-$$
server=jukecord-ui-$$
# Everything this run made goes away at the end, whatever happened.
cleanup() {
  docker rm -f "$server" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  # The data folder belongs to the image's user; a container removes it.
  docker run --rm -v "$work:/work" --entrypoint sh "$image" -c 'rm -rf /work/data' >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
mkdir -p "$out" "$work/data"
chmod 0777 "$work/data"
docker network create "$network" >/dev/null
docker run --rm --user 10001:10001 -v "$PWD:/app:ro" -v "$work/data:/data" "$image" \
  node --disable-warning=ExperimentalWarning /app/tests/ui/seed.ts /data
docker run -d --name "$server" --network "$network" --user 10001:10001 -v "$PWD:/app:ro" -v "$work/data:/data" \
  -e JUKECORD_PUBLIC_URL="http://$server:8795" "$image" >/dev/null
# Ready when the API answers.
for _ in $(seq 1 30); do
  docker exec "$server" node -e "fetch('http://127.0.0.1:8795/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" && break
  sleep 1
done
docker run --rm --network "$network" --ipc=host -v "$PWD/tests/ui:/ui:ro" -v "$work/data:/data:ro" -v "$out:/out" \
  -e BASE="http://$server:8795" -e TOKEN_FILE=/data/host-token -e OUT=/out -w /tmp "$playwright" \
  sh -c 'npm init -y >/dev/null 2>&1 && npm i --no-audit --no-fund --silent playwright@1.60.0 >/dev/null 2>&1 && cp /ui/walk.mjs /ui/audit.js . && node walk.mjs'
