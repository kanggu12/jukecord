/**
 * A split jukecord, a core and two edges in one process on a real web server each: what a browser and the command line
 * see through an edge is what they see in one process (the same answers and refusals with the same statuses, the same
 * live updates, the audio with its Range requests), changes made through one edge reach the panels of the other, who
 * listens on each edge is added up at the core and shown on every edge, and a core that stops or restarts is said at
 * once (503 with Retry-After, panels told to reconnect) and found again. On the memory bus always, and on Redis or
 * Valkey when JUKECORD_TEST_BUS_URL names one.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { MemoryTransport } from '../../src/bus/memory.ts';
import { MediaCache } from '../../src/media/cache.ts';
import { openApiDocument } from '../../src/web/openapi.ts';
import { eventually, testBuses } from '../support/bus.ts';
import { type Split, split, type TestCore, type TestEdge } from '../support/split.ts';
import { ALICE, BOB, exampleTrack, GUILD, HOST_TOKEN } from '../support/web.ts';

const host = { authorization: `Bearer ${HOST_TOKEN}` };

// Asks an edge over HTTP as the command line does (a token, JSON in and out).
async function ask(
  edge: TestEdge,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = host,
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const response = await fetch(`${edge.url}/api/v1${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    headers: response.headers,
  };
}

// A panel's live connection: its messages by type, in the order they came, and how it was closed.
class Live {
  readonly socket: WebSocket;
  readonly messages: Record<string, unknown>[] = [];
  readonly closed: Promise<number>;

  constructor(edge: TestEdge, guild: string, headers: Record<string, string> = host) {
    this.socket = new WebSocket(`${edge.url.replace('http://', 'ws://')}/api/v1/events?guild=${guild}`, {
      headers,
    } as unknown as string[]);
    this.closed = new Promise((resolve) => this.socket.addEventListener('close', (event) => resolve(event.code)));
    this.socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') this.messages.push(JSON.parse(event.data) as Record<string, unknown>);
    });
  }

  of(type: string): Record<string, unknown>[] {
    return this.messages.filter((message) => message.type === type);
  }

  send(message: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(message));
  }

  close(): void {
    this.socket.close();
  }
}

for (const { name, make } of testBuses()) {
  describe(`a split jukecord on the ${name} bus`, () => {
    let pieces: Split;
    let core: TestCore;
    let one: TestEdge;
    let two: TestEdge;

    before(async () => {
      pieces = await split(make(), {
        found: { 'two tracks': [exampleTrack('a'), exampleTrack('b')], 'one track': [exampleTrack('c')] },
        coreLostAfterMs: 1500,
        // A burst of two changes and hardly any more, so a third from the same login is refused wherever it comes in.
        rates: { changes: { perSecond: 0.01, burst: 2 } },
      });
      core = await pieces.core();
      one = await pieces.edge(core);
      two = await pieces.edge(core);
      // Both edges hear the core before the tests ask them anything.
      await eventually(() => one.edge.watch.seen && two.edge.watch.seen, 'the core heard by both edges');
      core.directory.join(GUILD, ALICE);
      core.directory.join(GUILD, BOB);
      await pieces.store.users.upsert({ id: ALICE, name: 'Alice', avatar: null });
    });
    after(() => pieces.close());

    it('answers the API through an edge as one process does, and its document is the same', async () => {
      const status = await ask(one, 'GET', '/status');
      assert.equal(status.status, 200);
      assert.equal(status.body.mode, 'discord');
      const guilds = await ask(one, 'GET', '/guilds');
      assert.deepEqual((guilds.body as unknown as { id: string }[]).map((guild) => guild.id).sort(), [
        '100000000000000001',
        '100000000000000002',
      ]);
      // The document the command line builds its requests from.
      const document = await (await fetch(`${one.url}/api/v1/openapi.json`)).json();
      assert.deepEqual(document, JSON.parse(JSON.stringify(openApiDocument('/api/v1'))));
    });

    it("writes each role's figures on its own /metrics: an edge its panels and calls, the core its players", async () => {
      const edge = await (await fetch(`${one.url}/metrics`)).text();
      assert.match(edge, /^jukecord_panel_connections \d+$/m);
      assert.match(edge, /^jukecord_bus_commands_total\{command="actions\.status",outcome="ok"\} \d+$/m);
      assert.doesNotMatch(edge, /^jukecord_players\{/m);
      const coreMetrics = await (await fetch(`${core.healthUrl}/metrics`)).text();
      assert.match(coreMetrics, /^jukecord_players\{status="idle"\} \d+$/m);
      assert.match(coreMetrics, /^jukecord_edges 2$/m);
      assert.match(coreMetrics, /^jukecord_bus_commands_served_total\{command="actions\.status",outcome="ok"\} \d+$/m);
      // And their readiness by parts.
      const coreReady = (await (await fetch(`${core.healthUrl}/readyz`)).json()) as { parts: Record<string, string> };
      assert.deepEqual(coreReady.parts, { database: 'ok', bus: 'ok' });
    });

    it('keeps the status of every refusal: 404, 409, 400 and 403 as in one process', async () => {
      assert.equal((await ask(one, 'DELETE', `/guilds/${GUILD}/queue/99999`)).status, 404);
      const pause = await ask(one, 'POST', `/guilds/${GUILD}/player/pause`);
      assert.equal(pause.status, 409);
      assert.deepEqual(pause.body, { error: { code: 'conflict', message: 'nothing is playing' } });
      // Refused by the edge's own checks (the schema), before the core is asked.
      assert.equal((await ask(one, 'POST', `/guilds/${GUILD}/queue`, {})).status, 400);
      // A server the bot is not in: the core's access rules say so.
      assert.equal((await ask(one, 'GET', '/guilds/100000000000000009/queue')).status, 404);
      // An action the core refuses for who is asking: a member without the DJ role where one is set.
      await pieces.store.settings.setDjRole(GUILD, '500000000000000001');
      const session = await sessionHeaders(one, BOB);
      const refused = await ask(one, 'POST', `/guilds/${GUILD}/queue/shuffle`, undefined, session);
      assert.equal(refused.status, 403);
      assert.match(String((refused.body.error as { message: string }).message), /DJ role/);
      await pieces.store.settings.setDjRole(GUILD, null);
    });

    it("hands a change made through one edge to the other edge's panels", async () => {
      const panel = new Live(two, GUILD);
      await eventually(() => panel.of('state').length === 1, 'the state on the other edge');
      const added = await ask(one, 'POST', `/guilds/${GUILD}/queue`, { input: 'two tracks' });
      assert.equal(added.status, 200);
      assert.equal((added.body.items as unknown[]).length, 2);
      await eventually(
        () => panel.of('player').some((message) => (message.player as { status: string }).status === 'loading'),
        'the player loading on the other edge',
      );
      await eventually(
        () => panel.of('queue').some((message) => ((message.queue as { items: unknown[] }).items.length ?? 0) === 1),
        'the queue on the other edge',
      );
      panel.close();
    });

    it('streams the audio of a queued track from the core, Range requests and all, through either edge', async () => {
      const track = await pieces.store.tracks.upsert(exampleTrack('audio'));
      await core.queue.add(GUILD, [track.id], 'end', null);
      // The track's file in the core's media cache, as a fetch leaves it.
      const key = MediaCache.keyOf(track.source);
      const tmp = core.cache.tmpPath(key);
      fs.writeFileSync(tmp, Buffer.from('OggS-0123456789-the-rest-of-the-file'));
      core.cache.commit(key, tmp, { source: track.source, durationMs: 1000, loudness: -14 });
      for (const edge of [one, two]) {
        const whole = await fetch(`${edge.url}/api/v1/guilds/${GUILD}/tracks/${track.id}/audio`, { headers: host });
        assert.equal(whole.status, 200);
        assert.equal(await whole.text(), 'OggS-0123456789-the-rest-of-the-file');
        assert.equal(whole.headers.get('cache-control'), 'private, max-age=86400');
        const part = await fetch(`${edge.url}/api/v1/guilds/${GUILD}/tracks/${track.id}/audio`, {
          headers: { ...host, range: 'bytes=5-14' },
        });
        assert.equal(part.status, 206);
        assert.equal(part.headers.get('content-range'), `bytes 5-14/${'OggS-0123456789-the-rest-of-the-file'.length}`);
        assert.equal(await part.text(), '0123456789');
      }
      // The MP3 copy: none is made in these tests, which the core says as one process does.
      const mp3 = await fetch(`${one.url}/api/v1/guilds/${GUILD}/tracks/${track.id}/audio?format=mp3`, {
        headers: host,
      });
      assert.equal(mp3.status, 409);
      // A track not in this server's queue is refused as in one process, by the core.
      const other = await pieces.store.tracks.upsert(exampleTrack('elsewhere'));
      const refused = await fetch(`${one.url}/api/v1/guilds/${GUILD}/tracks/${other.id}/audio`, { headers: host });
      assert.equal(refused.status, 404);
      // Without the secret, the core's internal port answers nothing.
      const direct = await fetch(`${core.internalUrl}/internal/v1/audio?guild=${GUILD}&track=${track.id}`);
      assert.equal(direct.status, 401);
      // An edge given another secret than its core's: the browser hears jukecord is away, and the log says why.
      const astray = await pieces.edge(core, { secret: 'not-the-secret-0123456789abcdef0123456789' });
      const refused2 = await fetch(`${astray.url}/api/v1/guilds/${GUILD}/tracks/${track.id}/audio`, { headers: host });
      assert.equal(refused2.status, 503);
      assert.ok(
        astray.logs.records.some((record) => String(record.fields.reason).includes('JUKECORD_INTERNAL_SECRET')),
      );
      await astray.stop();
    });

    it('adds up who listens on each edge at the core, and shows everyone on every edge', async () => {
      const alice = await sessionHeaders(one, ALICE);
      const listening = new Live(one, GUILD, alice);
      const watching = new Live(two, GUILD);
      await eventually(() => listening.of('state').length === 1 && watching.of('state').length === 1, 'both states');
      listening.send({ type: 'listening', on: true });
      await eventually(() => core.services.audience.count(GUILD) === 1, 'the core counting the browser');
      assert.deepEqual(core.services.audience.people(GUILD), [ALICE]);
      // The other edge's panel shows her, though her browser is on the first edge.
      await eventually(
        () =>
          watching
            .of('listeners')
            .some((message) => (message.listeners as { people: { id: string | null }[] }).people[0]?.id === ALICE),
        'Alice shown on the other edge',
      );
      listening.close();
      await eventually(() => core.services.audience.count(GUILD) === 0, 'the core counting nobody');
      watching.close();
    });

    it("ends a session's live connections on every edge when it logs out on one", async () => {
      const cookie = await sessionHeaders(one, ALICE);
      const away = new Live(two, GUILD, { cookie: cookie.cookie ?? '' });
      await eventually(() => away.of('state').length === 1, 'the state');
      const out = await fetch(`${one.url}/auth/logout`, {
        method: 'POST',
        headers: { cookie: cookie.cookie ?? '', 'x-jukecord-csrf': cookie['x-jukecord-csrf'] ?? '' },
      });
      assert.equal(out.status, 204);
      assert.equal(await away.closed, 4401);
    });

    it("ends a revoked listening link's guests on every edge, whichever edge revoked it", async () => {
      const made = await ask(one, 'POST', `/guilds/${GUILD}/listen-links`, { days: 1 });
      assert.equal(made.status, 200);
      const code = String(made.body.url).split('#')[1] ?? '';
      // The guest comes in through the other edge, as a browser behind the front may.
      const entered = await fetch(`${two.url}/auth/listen`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      assert.equal(entered.status, 200);
      const cookie = (entered.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      const guest = new Live(two, GUILD, { cookie });
      await eventually(() => guest.of('state').length === 1, "the guest's state");
      const id = (made.body.link as { id: number }).id;
      assert.equal((await ask(one, 'DELETE', `/guilds/${GUILD}/listen-links/${id}`)).status, 200);
      assert.equal(await guest.closed, 4401);
    });

    it("counts a login's changes together on every edge (the rates are in the shared cache)", async () => {
      const alice = await sessionHeaders(one, ALICE);
      // Two changes at once and one more a second: the third through the other edge is the one too many.
      const statuses: number[] = [];
      for (const edge of [one, one, two]) {
        statuses.push((await ask(edge, 'POST', `/guilds/${GUILD}/queue/shuffle`, undefined, alice)).status);
      }
      assert.deepEqual(statuses, [200, 200, 429]);
    });

    it('asks the core for the host jobs: its log, its self-check, its backup', async () => {
      const logs = await ask(one, 'GET', '/logs?limit=5');
      assert.equal((logs.body as unknown as { msg: string }[])[0]?.msg, 'from the core');
      const doctor = await ask(one, 'GET', '/doctor');
      assert.match(JSON.stringify(doctor.body), /asked with discordLogin=false/);
      const backup = await ask(one, 'POST', '/backups');
      assert.equal(backup.status, 200);
    });

    it('says at once when the core stops, tells the panels to reconnect, and finds the next core', async () => {
      const panel = new Live(one, GUILD);
      await eventually(() => panel.of('state').length === 1, 'the state');
      await core.stop();
      // The goodbye: the panels are told to reconnect (1012), and nothing waits for the core.
      assert.equal(await panel.closed, 1012);
      const started = Date.now();
      const away = await ask(one, 'GET', `/guilds/${GUILD}/queue`);
      assert.equal(away.status, 503);
      assert.equal(away.headers.get('retry-after'), '2');
      assert.ok(Date.now() - started < 1000, 'refused at once');
      const ready = await (await fetch(`${one.url}/readyz`)).json();
      assert.equal((ready as { parts: Record<string, string> }).parts.core, 'no heartbeat from the core lately');
      // The next core: the edges find it and answer again, from where the database is.
      core = await pieces.core();
      await eventually(() => one.edge.watch.instance === core.instance, 'the new core heard');
      const back = await ask(one, 'GET', `/guilds/${GUILD}/queue`);
      assert.equal(back.status, 200);
      assert.ok((back.body.items as unknown[]).length >= 1, 'the queue is still there');
      const fresh = new Live(one, GUILD);
      await eventually(() => fresh.of('state').length === 1, 'a state from the new core');
      fresh.close();
    });
  });
}

describe('a split jukecord whose edge is cut off from the bus', () => {
  it('refuses at once while cut off, and tells its panels to reconnect when the bus is back', async () => {
    const { memoryBus } = await import('../support/bus.ts');
    const pieces = await split(memoryBus(), { coreLostAfterMs: 60_000 });
    try {
      const core = await pieces.core();
      const edge = await pieces.edge(core);
      await eventually(() => edge.edge.watch.seen, 'the core heard');
      const panel = new Live(edge, 'local');
      await eventually(() => panel.of('state').length === 1 || panel.of('error').length > 0, 'the first answer');
      const transport = edge.transport as MemoryTransport;
      transport.setConnected(false);
      const started = Date.now();
      const away = await ask(edge, 'GET', `/guilds/${GUILD}/queue`);
      assert.equal(away.status, 503);
      assert.ok(Date.now() - started < 1000, 'refused at once');
      assert.equal(((await (await fetch(`${edge.url}/readyz`)).json()) as { ready: boolean }).ready, false);
      // Back: what the bus carried meanwhile is lost, so every panel is told to reconnect and ask again.
      transport.setConnected(true);
      assert.equal(await panel.closed, 1012);
    } finally {
      await pieces.close();
    }
  });
});

// A logged-in member's headers through an edge: the session cookie and its CSRF token.
async function sessionHeaders(edge: TestEdge, userId: string): Promise<Record<string, string>> {
  const set = await edge.auth.startSession({ kind: 'user', userId });
  const cookie = set.split(';')[0] ?? '';
  const caller = await edge.auth.identify({ cookie });
  return { cookie, 'x-jukecord-csrf': caller?.csrf ?? '' };
}
