/**
 * Inside a running jukecord seeded by tests/perf/seed.ts (tests/perf/measure.sh runs it): times each read the panel
 * makes (the median and the slowest of 20) with the size of its answer, and sizes the live state a panel gets for the
 * thousand-track queue, as text and as the gzip frame a browser asks for.
 *
 *   node tests/perf/reads.ts <data directory>
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import WebSocket from 'ws';

// The host's token, which the server wrote into its data directory.
const dataDir = path.resolve(process.argv[2] ?? '/data');
const token = fs.readFileSync(path.join(dataDir, 'host-token'), 'utf8').trim();
const base = 'http://127.0.0.1:8795/api/v1';
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

// One request to the API, its answer read whole.
async function call(method: string, route: string, body?: unknown): Promise<{ status: number; text: string }> {
  const answer = await fetch(base + route, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: answer.status, text: await answer.text() };
}

const queue = JSON.parse((await call('GET', '/guilds/local/queue')).text) as { items: unknown[] };
console.log(`queue: ${queue.items.length} tracks`);

// Each read the panel makes, twenty times: the median and the slowest, and the answer's size.
const reads = [
  '/guilds/local/player',
  '/guilds/local/queue',
  '/guilds/local/history?limit=50',
  '/guilds/local/playlists',
  '/guilds/local/stats?days=30',
  '/guilds/local/stats?days=365',
  '/status',
  // Wrapped over the year of plays, as the panel's page asks for it when it opens.
  '/guilds/local/wrapped?period=last-12-months',
];
for (const route of reads) {
  const times: number[] = [];
  let bytes = 0;
  for (let i = 0; i < 20; i += 1) {
    const started = performance.now();
    const answer = await call('GET', route);
    times.push(performance.now() - started);
    if (answer.status !== 200) throw new Error(`${route}: ${answer.status}`);
    bytes = Buffer.byteLength(answer.text);
  }
  times.sort((a, b) => a - b);
  const median = (times[9] ?? 0) + ((times[10] ?? 0) - (times[9] ?? 0)) / 2;
  console.log(
    `GET ${route.padEnd(32)} median ${median.toFixed(1).padStart(6)} ms, slowest ${(times[19] ?? 0).toFixed(1).padStart(6)} ms, ${(bytes / 1024).toFixed(1).padStart(6)} KiB`,
  );
}

// The live state a panel gets when it connects: as text (what a client that does not ask gets), and as the gzip frame
// a browser asks for with gzip=1 (made once for every panel showing the server).
for (const packed of [false, true]) {
  const socket = new WebSocket(`ws://127.0.0.1:8795/api/v1/events?guild=local${packed ? '&gzip=1' : ''}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const state = await new Promise<{ json: number; frame: number }>((resolve, reject) => {
    socket.on('error', reject);
    socket.on('message', (data, isBinary) => {
      // A binary frame is gzip; a text frame is the JSON itself.
      const frame = data as Buffer;
      const json = isBinary ? zlib.gunzipSync(frame) : frame;
      if ((JSON.parse(json.toString()) as { type: string }).type === 'state') {
        resolve({ json: json.length, frame: frame.length });
      }
    });
  });
  console.log(
    `live state ${packed ? 'as gzip' : 'as text'}: ${(state.json / 1024).toFixed(0)} KiB of JSON, ${(state.frame / 1024).toFixed(0)} KiB sent`,
  );
  socket.close();
}
