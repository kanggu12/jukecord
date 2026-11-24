/**
 * The checks tests/split/run.sh runs against a split jukecord it started: talking to each edge and the front over
 * HTTP and WebSocket as browsers and the command line do, and restarting the core in between.
 *
 * It reads where everything is from the environment run.sh sets (JUKECORD_E2E_*), and fails with the step it was at.
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (tests/split/run.sh sets it)`);
  return value;
};

const token = env('JUKECORD_E2E_TOKEN');
const front = env('JUKECORD_E2E_FRONT');
const edges = [env('JUKECORD_E2E_EDGE1'), env('JUKECORD_E2E_EDGE2')] as const;
const core = env('JUKECORD_E2E_CORE');
const restartCore = env('JUKECORD_E2E_RESTART');
// The database the services share (postgres or mysql), and a login link `jukecord link` made in edge 1.
const database = env('JUKECORD_E2E_DATABASE');
const loginLink = env('JUKECORD_E2E_LINK');
// The one server of browser-only mode, and the track's address on the test's file server.
const GUILD = 'local';
const TRACK = 'http://media/tone.ogg';
const auth = { authorization: `Bearer ${token}` };

let step = '';
function says(what: string): void {
  step = what;
  process.stdout.write(`- ${what}\n`);
}

// Asks until the answer is good, for at most `ms`: what a service takes a moment to become.
async function until<T>(what: string, ask: () => Promise<T | null>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown = null;
  for (;;) {
    try {
      const value = await ask();
      if (value !== null) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${last ? ` (last: ${String(last)})` : ''}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function json(url: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as unknown) : null };
}

// A panel's live connection to an edge, subscribed to the server: its messages in order, and its close.
function live(edge: string) {
  const messages: Record<string, unknown>[] = [];
  const socket = new WebSocket(`${edge.replace('http://', 'ws://')}/api/v1/events?guild=${GUILD}`, {
    headers: auth,
  } as unknown as string[]);
  const closed = new Promise<number>((resolve) => socket.addEventListener('close', (event) => resolve(event.code)));
  socket.addEventListener('message', (event) => {
    if (typeof event.data === 'string') messages.push(JSON.parse(event.data) as Record<string, unknown>);
  });
  return {
    messages,
    closed,
    close: () => socket.close(),
    of: (type: string) => messages.filter((m) => m.type === type),
  };
}

type Player = { status: string; track: { id: number; title: string } | null; version: number };
type Readiness = { ready: boolean; parts: Record<string, { state: string; required: boolean; kind?: string }> };

async function main(): Promise<void> {
  says('every edge is ready, with its core, and the core with its database and bus');
  for (const edge of edges) {
    await until(`${edge} ready`, async () => {
      const ready = (await json(`${edge}/readyz`)).body as { ready: boolean } | null;
      return ready?.ready ? ready : null;
    });
  }
  const coreReady = (await json(`${core}/readyz`)).body as Readiness;
  for (const part of ['database', 'bus', 'cache']) assert.equal(coreReady.parts[part]?.state, 'ok', part);
  assert.equal(coreReady.parts.database?.kind, database);
  assert.equal(coreReady.parts.bus?.kind, 'redis');
  const edgeReady = (await json(`${edges[1]}/readyz`)).body as Readiness;
  for (const part of ['database', 'bus', 'cache', 'core']) assert.equal(edgeReady.parts[part]?.state, 'ok', part);

  says('a login link made in edge 1 logs a browser in at edge 2, once (the links are on the shared cache)');
  const code = loginLink.split('/auth/link/')[1] ?? '';
  assert.ok(code, `a login link: ${loginLink}`);
  const opened = await fetch(`${edges[1]}/auth/link/${code}`, { redirect: 'manual' });
  assert.equal(opened.status, 302);
  assert.equal(opened.headers.get('location'), '/');
  const cookie = (opened.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const me = await fetch(`${front}/api/v1/me`, { headers: { cookie } });
  assert.equal(me.status, 200, 'the session works through the front');
  const spent = await fetch(`${edges[0]}/auth/link/${code}`, { redirect: 'manual' });
  assert.equal(spent.headers.get('location'), '/login?error=link');

  says('the front answers for the edges, the same answers as one process');
  const status = (await json(`${front}/api/v1/status`)).body as { mode: string };
  assert.equal(status.mode, 'browser-only');
  const page = await fetch(`${front}/`, { headers: { accept: 'text/html' } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>/);

  says('a track added through edge 1 reaches a live connection of edge 2');
  const watching = live(edges[1]);
  await until('the state on edge 2', async () => (watching.of('state').length > 0 ? true : null), 15_000);
  const added = await json(`${edges[0]}/api/v1/guilds/${GUILD}/queue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: TRACK }),
  });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  const player = await until(
    'the track playing, as edge 2 is told',
    async () => {
      const last = watching.of('player').at(-1)?.player as Player | undefined;
      return last?.status === 'playing' && last.track ? last : null;
    },
    90_000,
  );

  says('the audio plays through an edge, a Range request too, and through the front');
  const audio = `/api/v1/guilds/${GUILD}/tracks/${player.track?.id}/audio`;
  const part = await fetch(`${edges[1]}${audio}`, { headers: { ...auth, range: 'bytes=0-99' } });
  assert.equal(part.status, 206);
  const bytes = Buffer.from(await part.arrayBuffer());
  assert.equal(bytes.length, 100);
  assert.equal(bytes.subarray(0, 4).toString('latin1'), 'OggS');
  const size = Number(/\/(\d+)$/.exec(part.headers.get('content-range') ?? '')?.[1]);
  const whole = await fetch(`${front}${audio}`, { headers: auth });
  assert.equal(whole.status, 200);
  assert.equal((await whole.arrayBuffer()).byteLength, size);

  says('the core restarts: the panels are told to reconnect, and the edges find the new core');
  const panel = live(edges[0]);
  await until('the state on edge 1', async () => (panel.of('state').length > 0 ? true : null), 15_000);
  execSync(restartCore, { stdio: 'inherit' });
  assert.equal(await panel.closed, 1012);
  for (const edge of edges) {
    await until(`${edge} ready again`, async () => {
      const ready = (await json(`${edge}/readyz`)).body as Readiness | null;
      return ready?.ready ? ready : null;
    });
  }
  // The new core restored the server where the old one left it: the same track, paused.
  const restored = await until('the restored player', async () => {
    const answer = await json(`${edges[1]}/api/v1/guilds/${GUILD}/player`);
    return answer.status === 200 ? (answer.body as Player) : null;
  });
  assert.equal(restored.track?.id, player.track?.id);
  assert.equal(restored.status, 'paused');
  const again = live(edges[1]);
  await until('a state from the new core', async () => (again.of('state').length > 0 ? true : null), 15_000);
  for (const socket of [watching, again]) socket.close();
}

main().then(
  () => process.stdout.write('the split works end to end\n'),
  (error: unknown) => {
    process.stderr.write(`failed at "${step}": ${error instanceof Error ? (error.stack ?? error.message) : error}\n`);
    process.exit(1);
  },
);
