/**
 * Inside a running jukecord seeded by tests/perf/seed.ts (tests/perf/measure.sh runs it): times each read the panel
 * makes (the median and the slowest of 20) with the size of its answer, and sizes the live state a browser gets for
 * the thousand-track queue, plain and compressed.
 *
 *   node tests/perf/reads.ts <data directory>
 */
import fs from 'node:fs';
import path from 'node:path';
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

// The live state a panel gets when it connects, as JSON and as the bytes that cross the network.
for (const compress of [false, true]) {
  const socket = new WebSocket('ws://127.0.0.1:8795/api/v1/events?guild=local', {
    headers: { authorization: `Bearer ${token}` },
    perMessageDeflate: compress,
  });
  const state = await new Promise<string>((resolve, reject) => {
    socket.on('error', reject);
    socket.on('message', (data) => {
      const text = String(data);
      if ((JSON.parse(text) as { type: string }).type === 'state') resolve(text);
    });
  });
  // What the socket read off the network so far: the handshake, the state and any message before it.
  const wire = (socket as unknown as { _socket: { bytesRead: number } })._socket.bytesRead;
  console.log(
    `live state ${compress ? 'compressed' : 'plain     '}: ${(Buffer.byteLength(state) / 1024).toFixed(0)} KiB of JSON, ${(wire / 1024).toFixed(0)} KiB over the network`,
  );
  socket.close();
}
