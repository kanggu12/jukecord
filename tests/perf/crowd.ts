/**
 * A crowd of panels, for tests/perf/measure.sh: many live connections to one jukecord, each asking for gzip frames as
 * a browser does, while the queue changes a few times a second. Prints how many panels stayed connected and how long
 * a change took to reach them: from the request that made it to the frame that carried it, the median and the slowest.
 *
 *   node tests/perf/crowd.ts <jukecord's address> <host token file> <panels> <changes a second> <seconds>
 *
 * Runs in a container of its own beside the server's, so the crowd's own work does not count against the server's
 * processor cores.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import WebSocket from 'ws';

const [base = 'http://127.0.0.1:8795', tokenFile = '/data/host-token', ...numbers] = process.argv.slice(2);
const [panels = 100, rate = 3, seconds = 20] = numbers.map(Number);
const token = fs.readFileSync(tokenFile, 'utf8').trim();
const api = `${base}/api/v1`;
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The queue's version in a frame (null for a message without a queue), worked out once for each different frame:
// every panel is sent the same bytes, so unpacking each frame for each panel would time the crowd, not jukecord.
const unpacked = new Map<string, number | null>();
function versionIn(frame: Buffer, binary: boolean): number | null {
  const key = `${frame.length}:${zlib.crc32(frame)}`;
  const known = unpacked.get(key);
  if (known !== undefined) return known;
  const message = JSON.parse((binary ? zlib.gunzipSync(frame) : frame).toString()) as { queue?: { version?: number } };
  const version = message.queue?.version ?? null;
  unpacked.set(key, version);
  return version;
}

// When each change was asked for, by the queue version it makes; and how long each took to reach each panel.
const asked = new Map<number, number>();
const deliveries: number[] = [];
let connected = 0;
let closed = 0;

// One panel: it counts as connected once the server's state has arrived, and notes every change that reaches it.
function panel(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/api/v1/events?guild=local&gzip=1`, { headers });
    let latest = -1;
    socket.on('error', reject);
    socket.on('close', () => {
      closed += 1;
    });
    socket.on('message', (data, binary) => {
      const arrived = performance.now();
      const version = versionIn(data as Buffer, binary);
      if (version === null || version <= latest) return;
      // The first queue is the state: the panel is in. Later ones carry every change since the one before.
      if (latest < 0) {
        connected += 1;
        resolve(version);
      } else {
        for (let made = latest + 1; made <= version; made += 1) {
          const at = asked.get(made);
          if (at !== undefined) deliveries.push(arrived - at);
        }
      }
      latest = version;
    });
  });
}

// The crowd comes in fifties, as fast as jukecord takes them.
let version = 0;
const opening = performance.now();
for (let at = 0; at < panels; at += 50) {
  const states = await Promise.all(Array.from({ length: Math.min(50, panels - at) }, panel));
  version = Math.max(version, ...states);
}
console.log(`panels: ${connected} connected in ${((performance.now() - opening) / 1000).toFixed(1)} s`);

// The changes: the last track of the queue moves to the front, again and again, each one a new version of the queue.
const queue = (await (await fetch(`${api}/guilds/local/queue`, { headers })).json()) as { items: { id: number }[] };
const ids = queue.items.map((item) => item.id);
let made = 0;
const until = performance.now() + seconds * 1000;
while (performance.now() < until) {
  const started = performance.now();
  const id = ids.pop();
  if (id === undefined) break;
  ids.unshift(id);
  version += 1;
  asked.set(version, started);
  const answer = await fetch(`${api}/guilds/local/queue/${id}/move`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ index: 0 }),
  });
  if (!answer.ok) throw new Error(`a move was refused: ${answer.status} ${await answer.text()}`);
  made += 1;
  // The next change starts 1/rate of a second after this one started.
  await pause(Math.max(0, 1000 / rate - (performance.now() - started)));
}
// The last changes get a moment to arrive.
await pause(2000);

deliveries.sort((a, b) => a - b);
const median = deliveries[Math.floor(deliveries.length / 2)] ?? Number.NaN;
const slowest = deliveries.at(-1) ?? Number.NaN;
console.log(`changes: ${made} in ${seconds} s (${rate} a second)`);
console.log(`still connected: ${connected - closed} of ${panels}`);
console.log(
  `a change reached a panel in: median ${median.toFixed(0)} ms, slowest ${slowest.toFixed(0)} ms (${deliveries.length} deliveries, ${made * panels} expected)`,
);
// Leaving ends every connection; the count above was taken first.
process.exit(0);
