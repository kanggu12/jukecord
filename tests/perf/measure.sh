#!/usr/bin/env bash
# How jukecord does with a lot in it, measured the same way each time. A throwaway jukecord gets a server used every
# day for a year (a thousand different tracks, all of them queued, and 10,000 plays: tests/perf/seed.ts), on as many
# processor cores as you give it (two by default, a small machine's worth). Then it prints:
#   - the server's memory at rest and after the reads,
#   - each read the panel makes, timed (the median and the slowest of 20) with the size of its answer,
#   - the live state a panel gets for the full queue, as JSON and over the network, plain and compressed,
#   - how long a four-minute track takes to have its loudness evened out and be encoded.
# Nothing reaches the internet or Discord, and everything it made is removed at the end.
#
#   tests/perf/measure.sh [cores]
#
# Needs the jukecord image (docker build -f deploy/docker/Dockerfile -t jukecord:dev .); JUKECORD_IMAGE picks
# another. The source is mounted over the image's, as tests/ui/run.sh does, so it measures this checkout.
set -euo pipefail
cd "$(dirname "$0")/../.."
cores=${1:-2}
image=${JUKECORD_IMAGE:-jukecord:dev}
work=$(mktemp -d)
server=jukecord-perf-$$
# Everything this run made goes away at the end, whatever happened.
cleanup() {
  docker rm -f "$server" >/dev/null 2>&1 || true
  # The data folder belongs to the image's user; a container removes it.
  docker run --rm -v "$work:/work" --entrypoint sh "$image" -c 'rm -rf /work/data' >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
mkdir -p "$work/data"
chmod 0777 "$work/data"
# The same container settings as compose.yaml, with the cores given and no published port.
run=(--user 10001:10001 --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true
  --cpus "$cores" -v "$PWD:/app:ro" -v "$work/data:/data")
node=(node --disable-warning=ExperimentalWarning)

echo "jukecord $(sed -n 's/^  "version": "\(.*\)",$/\1/p' package.json) in $image, on $cores processor cores"
# A server used every day for a year (tests/perf/seed.ts).
docker run --rm "${run[@]}" "$image" "${node[@]}" /app/tests/perf/seed.ts /data
docker run -d --name "$server" "${run[@]}" "$image" >/dev/null
# Ready when the API answers.
for _ in $(seq 1 30); do
  docker exec "$server" node -e "fetch('http://127.0.0.1:8795/readyz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" &&
    break
  sleep 1
done
# At rest: ten seconds after the start, nothing playing and no panel open.
sleep 10
docker stats --no-stream --format 'memory at rest: {{.MemUsage}}' "$server"
docker exec "$server" "${node[@]}" /app/tests/perf/reads.ts /data
docker stats --no-stream --format 'memory after the reads: {{.MemUsage}}' "$server"
docker exec "$server" "${node[@]}" /app/tests/perf/encode.ts /tmp
