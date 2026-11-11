/**
 * Live updates over a real WebSocket: the hello, the whole state on subscribe, changes in the order they happen,
 * listeners, the clock exchange, and the refusals (no login, another site's page).
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { EVENTS_VERSION } from '../../src/web/events.ts';
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

// A WebSocket client that collects messages and hands them out by type, in the order they came.
class Socket {
  readonly messages: Record<string, unknown>[] = [];
  readonly socket: WebSocket;
  // Messages not handed out yet, and the waits for messages not come yet.
  private readonly inbox: Record<string, unknown>[] = [];
  private readonly waiting: { type: string; resolve: (message: Record<string, unknown>) => void }[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;

  constructor(url: string, headers: Record<string, string>) {
    // Node's WebSocket takes headers through this non-standard option (undici); browsers send cookies themselves.
    this.socket = new WebSocket(url, { headers } as unknown as string[]);
    this.closed = new Promise((resolve) => {
      this.socket.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason }));
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      this.messages.push(message);
      const index = this.waiting.findIndex((entry) => entry.type === message.type);
      const [entry] = index >= 0 ? this.waiting.splice(index, 1) : [];
      if (entry) entry.resolve(message);
      else this.inbox.push(message);
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

  it('agrees to compress messages with a client that offers it, keeping no context between them', async () => {
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
    const agreed = String(headers['sec-websocket-extensions'] ?? '');
    assert.match(agreed, /permessage-deflate/);
    assert.match(agreed, /server_no_context_takeover/);
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
    // In the order things happened: both tracks queued, then the first taken out to play.
    const first = (await added).queue as { items: { addedByName: string }[] };
    assert.equal(first.items.length, 2);
    assert.equal(first.items[0]?.addedByName, 'Alice');
    const taken = await socket.next('queue');
    assert.equal((taken.queue as { items: unknown[] }).items.length, 1);
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
