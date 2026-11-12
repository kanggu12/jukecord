#!/usr/bin/env bash
# How jukecord does with a lot in it, measured the same way each time. A throwaway jukecord gets a server used every
# day for a year (a thousand different tracks, all of them queued, and 10,000 plays: tests/perf/seed.ts), on as many
# processor cores as you give it (two by default, a small machine's worth). Then it prints:
#   - the server's memory at rest and after the reads,
#   - each read the panel makes, timed (the median and the slowest of 20) with the size of its answer,
#   - the live state a panel gets for the full queue, as text and as the gzip frame a browser asks for,
#   - how long a four-minute track takes to have its loudness evened out and be encoded,
#   - a crowd: a thousand panels connected at once while the queue changes three times a second for twenty seconds
#     (tests/perf/crowd.ts, in a container of its own): how many stay connected, how long a change takes to reach
#     them, and what the server uses meanwhile.
# Nothing reaches the internet or Discord, and everything it made is removed at the end.
#
#   tests/perf/measure.sh [cores] [panels]      (panels 0 leaves the crowd out)
#
# Needs the jukecord image (docker build -f deploy/docker/Dockerfile -t jukecord:dev .); JUKECORD_IMAGE picks
# another. The source is mounted over the image's, as tests/ui/run.sh does, so it measures this checkout.
set -euo pipefail
cd "$(dirname "$0")/../.."
cores=${1:-2}
panels=${2:-1000}
image=${JUKECORD_IMAGE:-jukecord:dev}
work=$(mktemp -d)
network=jukecord-perf-$$
server=jukecord-perf-$$
crowd=jukecord-perf-crowd-$$
# Everything this run made goes away at the end, whatever happened.
cleanup() {
  docker rm -f "$crowd" "$server" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  # The data folder belongs to the image's user; a container removes it.
  docker run --rm -v "$work:/work" --entrypoint sh "$image" -c 'rm -rf /work/data' >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
mkdir -p "$work/data"
chmod 0777 "$work/data"
docker network create "$network" >/dev/null
# The same container settings as compose.yaml (read-only, no capabilities, 1 GiB of memory without swap, 1024
# processes, a 256 MiB /tmp), with the cores given and no published port.
run=(--user 10001:10001 --read-only --tmpfs /tmp:size=256m --cap-drop ALL --security-opt no-new-privileges:true
  --memory 1g --memory-swap 1g --pids-limit 1024 --cpus "$cores" -v "$PWD:/app:ro" -v "$work/data:/data")
node=(node --disable-warning=ExperimentalWarning)

echo "jukecord $(sed -n 's/^  "version": "\(.*\)",$/\1/p' package.json) in $image, on $cores processor cores"
# A server used every day for a year (tests/perf/seed.ts).
docker run --rm "${run[@]}" "$image" "${node[@]}" /app/tests/perf/seed.ts /data
# Listening on every address of its container, so the crowd's container reaches it over their private network.
docker run -d --name "$server" --network "$network" -e JUKECORD_HOST=0.0.0.0 "${run[@]}" "$image" >/dev/null
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

if [ "$panels" -gt 0 ]; then
  echo "a crowd of $panels panels, the queue changing 3 times a second for 20 s:"
  # The crowd in a container of its own (no limit on its cores), with the host's token to connect and to make the
  # changes.
  docker run -d --name "$crowd" --network "$network" --user 10001:10001 -v "$PWD:/app:ro" -v "$work/data:/data:ro" \
    "$image" "${node[@]}" /app/tests/perf/crowd.ts "http://$server:8795" /data/host-token "$panels" 3 20 >/dev/null
  # What the server uses while the crowd is there: sampled until the crowd has left, the busiest sample kept.
  busiest=0
  memory=
  while [ "$(docker inspect -f '{{.State.Running}}' "$crowd" 2>/dev/null)" = true ]; do
    sample=$(docker stats --no-stream --format '{{.CPUPerc}} {{.MemUsage}}' "$server")
    cpu=${sample%%%*}
    # Compared as numbers with a decimal point.
    if awk -v a="$cpu" -v b="$busiest" 'BEGIN { exit !(a > b) }'; then
      busiest=$cpu
      memory=${sample#* }
    fi
  done
  docker logs "$crowd" 2>&1 | sed 's/^/  /'
  echo "  the server meanwhile: up to $busiest % of one processor core, memory $memory"
fi
