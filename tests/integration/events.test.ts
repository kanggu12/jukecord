/**
 * Live updates over a real WebSocket: the hello, the whole state on subscribe, changes in the order they happen,
 * listeners, the clock exchange, and the refusals (no login, another site's page).
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';
import WebSocketClient from 'ws';
import { DEFAULT_LIVE_LIMITS, EVENTS_VERSION } from '../../src/web/events.ts';
import {
  ALICE,
  exampleTrack,
  GUILD,
  HOST_TOKEN,
  OTHER_GUILD,
  sessionFor,
  type TestServer,
  testServer,
} from '../support/web.ts';

// A WebSocket client that collects messages and hands them out by type, in the order they came. Binary messages are
// gzip, unpacked as the panel does (DecompressionStream, one message after another in the order they arrived).
class Socket {
  readonly messages: Record<string, unknown>[] = [];
  readonly socket: WebSocket;
  // How each message came: true for a binary (gzip) frame.
  readonly binary: boolean[] = [];
  // Messages not handed out yet, and the waits for messages not come yet.
  private readonly inbox: Record<string, unknown>[] = [];
  private readonly waiting: { type: string; resolve: (message: Record<string, unknown>) => void }[] = [];
  // Unpacking is asynchronous: each message waits for the one before it.
  private order: Promise<void> = Promise.resolve();
  readonly closed: Promise<{ code: number; reason: string }>;

  constructor(url: string, headers: Record<string, string>) {
    // Node's WebSocket takes headers through this non-standard option (undici); browsers send cookies themselves.
    this.socket = new WebSocket(url, { headers } as unknown as string[]);
    this.socket.binaryType = 'arraybuffer';
    this.closed = new Promise((resolve) => {
      this.socket.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason }));
    });
    this.socket.addEventListener('message', (event) => {
      const data = event.data as string | ArrayBuffer;
      this.order = this.order.then(async () => {
        const text =
          typeof data === 'string'
            ? data
            : await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
        const message = JSON.parse(text) as Record<string, unknown>;
        this.binary.push(typeof data !== 'string');
        this.messages.push(message);
        const index = this.waiting.findIndex((entry) => entry.type === message.type);
        const [entry] = index >= 0 ? this.waiting.splice(index, 1) : [];
        if (entry) entry.resolve(message);
        else this.inbox.push(message);
      });
    });
  }

  /** The oldest message of this type not handed out yet, waiting up to 3 s for one. */
  next(type: string): Promise<Record<string, unknown>> {
    const index = this.inbox.findIndex((message) => message.type === type);
    if (index >= 0) return Promise.resolve(this.inbox.splice(index, 1)[0] as Record<string, unknown>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no "${type}" message within 3 s`)), 3000);
      this.waiting.push({
        type,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
  }

  send(message: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(message));
  }

  close(): void {
    this.socket.close();
  }
}

describe('live updates', () => {
  let server: TestServer;
  let base: string;

  before(async () => {
    server = await testServer({ listen: true, found: { two: [exampleTrack('a'), exampleTrack('b')] } });
    base = server.url.replace('http://', 'ws://');
    server.directory.join(GUILD, ALICE);
    server.store.users.upsert({ id: ALICE, name: 'Alice', avatar: 'av' });
  });
  after(() => server.close());

  it('does not compress per connection, even for a client that offers it', async () => {
    // The upgrade by hand, to read the extension the server agreed to (a WebSocket object hides it).
    const headers = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
      const request = http.request(`${server.url}/api/v1/events`, {
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-version': '13',
          'sec-websocket-key': crypto.randomBytes(16).toString('base64'),
          'sec-websocket-extensions': 'permessage-deflate; client_max_window_bits',
          authorization: `Bearer ${HOST_TOKEN}`,
        },
      });
      request.on('upgrade', (response, socket) => {
        socket.destroy();
        resolve(response.headers);
      });
      request.on('response', (response) => reject(new Error(`no upgrade: ${response.statusCode}`)));
      request.on('error', reject);
      request.end();
    });
    // Declined: big messages are compressed once for everyone instead (see the gzip test below).
    assert.equal(headers['sec-websocket-extensions'], undefined);
  });

  it('says hello, sends the whole state on subscribe, then each change', async () => {
    const socket = new Socket(`${base}/api/v1/events`, { authorization: `Bearer ${HOST_TOKEN}` });
    const hello = await socket.next('hello');
    assert.equal(hello.v, EVENTS_VERSION);
    assert.equal(typeof hello.serverTime, 'number');
    socket.send({ type: 'subscribe', guild: GUILD });
    const state = await socket.next('state');
    assert.deepEqual(Object.keys(state).sort(), ['guild', 'listeners', 'player', 'queue', 'type', 'v', 'voice']);
    const added = socket.next('queue');
    const playerEvent = socket.next('player');
    await server.actions.add({ guildId: GUILD, userId: ALICE, mayControl: true, mayManage: false }, 'two');
    // Both tracks queued, then the first taken out to play, in one moment: one message with the queue as it ended,
    // its version counting both changes.
    const latest = (await added).queue as { items: { addedByName: string }[]; version: number };
    assert.equal(latest.items.length, 1);
    assert.equal(latest.items[0]?.addedByName, 'Alice');
    assert.equal(latest.version, 2);
    const player = (await playerEvent).player as { status: string; track: { title: string } };
    assert.equal(player.status, 'loading');
    assert.equal(player.track.title, 'Track a');
    // A change in another server does not reach this connection.
    const before = socket.messages.length;
    server.bus.emit('queue', { guildId: OTHER_GUILD, version: 1 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(socket.messages.length, before);
    socket.close();
  });

  it('answers pings with the server time and tells everyone who listens', async () => {
    const { cookie } = sessionFor(server, ALICE);
    const alice = new Socket(`${base}/api/v1/events?guild=${GUILD}`, { cookie, origin: server.url });
    await alice.next('state');
    const host = new Socket(`${base}/api/v1/events?guild=${GUILD}`, { authorization: `Bearer ${HOST_TOKEN}` });
    await host.next('state');
    alice.send({ type: 'ping', t: 123 });
    const pong = await alice.next('pong');
    assert.equal(pong.t, 123);
    assert.equal(typeof pong.serverTime, 'number');
    const announced = host.next('listeners');
    alice.send({ type: 'listening', on: true });
    const listeners = (await announced).listeners as { people: { name: string }[]; count: number };
    assert.deepEqual(listeners, { people: [{ id: ALICE, name: 'Alice', avatar: 'av' }], count: 1 });
    // Closing the page counts as no longer listening.
    const gone = host.next('listeners');
    alice.close();
    assert.deepEqual(((await gone).listeners as { count: number }).count, 0);
    host.close();
  });

  it('sends a big state and queue as gzip to a panel that says it can decompress, and as text otherwise', async () => {
    // A queue of a hundred tracks is about 30 KB of JSON: over the size below which messages stay text.
    const many = Array.from({ length: 100 }, (_, index) => exampleTrack(`big${index}`));
    const stored = many.map((track) => server.store.tracks.upsert(track).id);
    server.queue.add(OTHER_GUILD, stored, 'end', null);
    const packed = new Socket(`${base}/api/v1/events?guild=${OTHER_GUILD}&gzip=1`, {
      authorization: `Bearer ${HOST_TOKEN}`,
    });
    const plain = new Socket(`${base}/api/v1/events?guild=${OTHER_GUILD}`, { authorization: `Bearer ${HOST_TOKEN}` });
    const [packedState, plainState] = await Promise.all([packed.next('state'), plain.next('state')]);
    // The same state either way; only the frame differs.
    assert.deepEqual(packedState, plainState);
    assert.equal((packedState.queue as { items: unknown[] }).items.length, 100);
    const first = packed.messages.indexOf(packedState);
    assert.equal(packed.binary[first], true);
    assert.equal(plain.binary[plain.messages.indexOf(plainState)], false);
    // A change goes out the same way, and a small message (the pong) stays text for both.
    const changed = Promise.all([packed.next('queue'), plain.next('queue')]);
    server.queue.shuffle(OTHER_GUILD);
    const [packedQueue, plainQueue] = await changed;
    assert.deepEqual(packedQueue, plainQueue);
    packed.send({ type: 'ping', t: 1 });
    await packed.next('pong');
    assert.equal(packed.binary.at(-1), false);
    packed.close();
    plain.close();
    server.queue.clear(OTHER_GUILD);
  });

  it('refuses a connection without a login, and a cookie from another site', async () => {
    const anonymous = new Socket(`${base}/api/v1/events`, {});
    assert.equal((await anonymous.closed).code, 4401);
    const { cookie } = sessionFor(server, ALICE);
    const foreign = new Socket(`${base}/api/v1/events`, { cookie, origin: 'https://evil.example' });
    assert.equal((await foreign.closed).code, 4403);
  });

  it('refuses to subscribe to a server the login cannot open', async () => {
    const { cookie } = sessionFor(server, ALICE);
    const socket = new Socket(`${base}/api/v1/events`, { cookie, origin: server.url });
    await socket.next('hello');
    socket.send({ type: 'subscribe', guild: OTHER_GUILD });
    const error = await socket.next('error');
    assert.equal(error.code, 'forbidden');
    socket.close();
  });
});

describe('live updates end with the login', () => {
  it('closes a browser connection when its session logs out', async () => {
    const server = await testServer({ listen: true });
    try {
      server.directory.join(GUILD, ALICE);
      const { cookie, csrf } = sessionFor(server, ALICE);
      const socket = new Socket(`${server.url.replace('http://', 'ws://')}/api/v1/events?guild=${GUILD}`, {
        cookie,
        origin: server.url,
      });
      await socket.next('state');
      const logout = await fetch(`${server.url}/auth/logout`, {
        method: 'POST',
        headers: { cookie, 'x-jukecord-csrf': csrf },
      });
      assert.equal(logout.status, 204);
      assert.equal((await socket.closed).code, 4401);
    } finally {
      await server.close();
    }
  });
});

describe('live connections from an address that failed to log in too often', () => {
  it('turn away a credential that does not work with 1013, and let one that works in', async () => {
    const server = await testServer({ listen: true });
    try {
      for (let i = 0; i < 20; i += 1) {
        await fetch(`${server.url}/api/v1/me`, { headers: { authorization: 'Bearer jkc_wrong' } });
      }
      const base = `${server.url.replace('http://', 'ws://')}/api/v1/events`;
      const wrong = new Socket(base, { authorization: 'Bearer jkc_wrong' });
      assert.deepEqual(await wrong.closed, { code: 1013, reason: 'too many failed logins; wait ten minutes' });
      const host = new Socket(base, { authorization: `Bearer ${HOST_TOKEN}` });
      await host.next('hello');
      host.close();
    } finally {
      await server.close();
    }
  });
});

// A live connection whose browser is gone without a goodbye (the network lost, a laptop shut): the upgrade is made,
// and then nothing more is read or answered, pings included. Resolves once the upgrade is through.
function silentTab(url: string, cookie: string): Promise<net.Socket> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), hostname, () => {
      socket.write(
        'GET /api/v1/events HTTP/1.1\r\n' +
          `Host: ${hostname}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n` +
          `Cookie: ${cookie}\r\nOrigin: ${url}\r\n\r\n`,
      );
    });
    socket.once('data', (data) => {
      if (!data.toString('latin1').startsWith('HTTP/1.1 101')) reject(new Error(data.toString('latin1')));
      // From here on it is silent.
      socket.pause();
      resolve(socket);
    });
    socket.on('error', () => {});
  });
}

describe('live connections are capped', () => {
  it('make room for a tab of a login whose other tabs are gone without a goodbye, within moments', async () => {
    const server = await testServer({ listen: true, live: { perLogin: 2, probeMs: 300 } });
    const silent: net.Socket[] = [];
    const sockets: Socket[] = [];
    try {
      server.directory.join(GUILD, ALICE);
      const alice = sessionFor(server, ALICE);
      // Two tabs whose browser lost the network: they still hold the login's two places.
      silent.push(await silentTab(server.url, alice.cookie), await silentTab(server.url, alice.cookie));
      const base = `${server.url.replace('http://', 'ws://')}/api/v1/events`;
      const open = () => {
        const socket = new Socket(base, { cookie: alice.cookie, origin: server.url });
        sockets.push(socket);
        return socket;
      };
      // The browser comes back: its new tab is over the cap for now, and that wakes the two up with a ping.
      assert.deepEqual(await open().closed, {
        code: 1013,
        reason: 'too many live connections for this login; close a tab or two',
      });
      // They do not answer, so they are let go; the next try, as the panel makes it by itself, gets in.
      await new Promise((resolve) => setTimeout(resolve, 600));
      await open().next('hello');
      assert.equal(server.web.hub.counts().connections, 1);
    } finally {
      for (const socket of sockets) socket.close();
      for (const socket of silent) socket.destroy();
      await server.close();
    }
  });

  it('keep a tab that stalls for a moment, and give a tab the time a phone on a slow line takes to answer', async () => {
    // Fifteen seconds to answer a probe by default: a pong takes a fraction of a second from a browser that is there,
    // but a phone in a tunnel, or a ping stuck behind a big message, can stall for several. Five closed a tab that
    // stalled for six, and its reconnect was then refused because the tab knocking had taken its place.
    assert.ok((DEFAULT_LIVE_LIMITS.probeMs ?? 0) >= 15_000, `${DEFAULT_LIVE_LIMITS.probeMs} ms`);
    // The same at a smaller scale: a probe of 1.2 s, and a tab whose line stalls for 0.6 s of it.
    const server = await testServer({ listen: true, live: { perLogin: 2, probeMs: 1200 } });
    const clients: WebSocketClient[] = [];
    try {
      server.directory.join(GUILD, ALICE);
      const alice = sessionFor(server, ALICE);
      const base = `${server.url.replace('http://', 'ws://')}/api/v1/events?guild=${GUILD}`;
      const tab = () =>
        new Promise<WebSocketClient>((resolve) => {
          const client = new WebSocketClient(base, { headers: { cookie: alice.cookie, origin: server.url } });
          clients.push(client);
          client.on('error', () => {});
          client.once('open', () => resolve(client));
        });
      const phone = await tab();
      await tab();
      // The phone's line stalls: it reads nothing (pings included, which ws answers as it reads them).
      (phone as unknown as { _socket: net.Socket })._socket.pause();
      const knock = new Socket(base, { cookie: alice.cookie, origin: server.url });
      assert.equal((await knock.closed).code, 1013);
      await new Promise((resolve) => setTimeout(resolve, 600));
      (phone as unknown as { _socket: net.Socket })._socket.resume();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      // The probe is over: the phone answered in time and keeps its place; the login still has its two tabs.
      assert.equal(phone.readyState, WebSocketClient.OPEN);
      assert.equal(server.web.hub.counts().connections, 2);
    } finally {
      for (const client of clients) client.terminate();
      await server.close();
    }
  });

  it('in all, per login and per address, closing the one over a cap with 1013 and why; the host counts in all only', async () => {
    const server = await testServer({ listen: true, live: { total: 4, perLogin: 2, perAddress: 3 } });
    const sockets: Socket[] = [];
    try {
      server.directory.join(GUILD, ALICE);
      const base = `${server.url.replace('http://', 'ws://')}/api/v1/events`;
      const open = (headers: Record<string, string>) => {
        const socket = new Socket(base, headers);
        sockets.push(socket);
        return socket;
      };
      // Two tabs of one login, and a third: over the cap for that login.
      const first = sessionFor(server, ALICE);
      const asFirst = { cookie: first.cookie, origin: server.url };
      await open(asFirst).next('hello');
      await open(asFirst).next('hello');
      assert.deepEqual(await open(asFirst).closed, {
        code: 1013,
        reason: 'too many live connections for this login; close a tab or two',
      });
      // Another login from the same address: its first tab fits, the next is one too many from this address.
      const second = sessionFor(server, ALICE);
      const asSecond = { cookie: second.cookie, origin: server.url };
      await open(asSecond).next('hello');
      assert.deepEqual(await open(asSecond).closed, {
        code: 1013,
        reason: 'too many live connections from this address; close a tab or two',
      });
      // The host is not held to those two caps, only to the total: the fourth connection fits, the fifth does not.
      await open({ authorization: `Bearer ${HOST_TOKEN}` }).next('hello');
      assert.deepEqual(await open({ authorization: `Bearer ${HOST_TOKEN}` }).closed, {
        code: 1013,
        reason: 'jukecord has as many live connections as it allows',
      });
      // Three refusals, one line in the log (a crowd knocking again and again must not fill it).
      const told = server.logs.records.filter((record) => record.msg === 'refused live connections');
      assert.equal(told.length, 1);
      // A tab closed frees its place.
      const [tab] = sockets;
      tab?.close();
      await tab?.closed;
      await new Promise((resolve) => setTimeout(resolve, 50));
      await open(asFirst).next('hello');
      assert.equal(server.web.hub.counts().connections, 4);
    } finally {
      for (const socket of sockets) socket.close();
      await server.close();
    }
  });
});
