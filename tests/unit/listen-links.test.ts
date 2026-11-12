/**
 * Listening links and the guests they let in, and friends the host lets in with a login link: who may make, list and
 * revoke links; a guest's way in (the code from the panel's page, counted against the link's places and against
 * guessing); everything a guest must not reach (other servers, changes, statistics, logs, tokens, settings, the audio
 * of tracks not playing or queued); a revoked link ending its guests at once; and a friend held to view or control, to
 * the rates and never to the host's rights.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { InjectOptions } from 'fastify';
import { GUESTS_PER_LINK } from '../../src/app/actions.ts';
import { MediaCache } from '../../src/media/cache.ts';
import { API_PREFIX } from '../../src/web/api.ts';
import { CSRF_HEADER, SESSION_COOKIE } from '../../src/web/auth.ts';
import {
  ALICE,
  asHost,
  BOB,
  DJ_ROLE,
  exampleTrack,
  GUILD,
  OTHER_GUILD,
  sessionFor,
  type TestServer,
  testServer,
} from '../support/web.ts';

const api = (route: string) => `${API_PREFIX}${route}`;
// The methods the API takes.
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
// The panel's own page sends the code: same origin as the server the tests reach.
const PANEL = { origin: 'http://localhost:80', host: 'localhost:80' };

// A guest's cookie and CSRF token, from a code redeemed the way the panel's page does it.
async function guestOf(server: TestServer, code: string): Promise<{ cookie: string; csrf: string }> {
  const answer = await server.web.app.inject({
    method: 'POST',
    url: '/auth/listen',
    headers: PANEL,
    payload: { code },
  });
  assert.equal(answer.statusCode, 200, answer.body);
  const cookie = String(answer.headers['set-cookie']).split(';')[0] ?? '';
  const me = await server.web.app.inject({ method: 'GET', url: api('/me'), headers: { cookie } });
  return { cookie, csrf: me.json().csrf as string };
}

// The code of a new link to a server, made by the host for `days`.
async function newLink(server: TestServer, guild = GUILD, days = 7): Promise<{ code: string; id: number }> {
  const made = await server.web.app.inject({
    method: 'POST',
    url: api(`/guilds/${guild}/listen-links`),
    headers: asHost,
    payload: { days },
  });
  assert.equal(made.statusCode, 200, made.body);
  const url = new URL(made.json().url as string);
  // The code travels after a "#", which a browser never sends to a server.
  assert.equal(url.pathname, '/listen');
  return { code: url.hash.slice(1), id: made.json().link.id as number };
}

describe('listening links', () => {
  let server: TestServer;
  const inject = (options: InjectOptions) => server.web.app.inject(options);

  before(async () => {
    server = await testServer({ found: { one: [exampleTrack('a')], two: [exampleTrack('b'), exampleTrack('c')] } });
    server.directory.join(GUILD, ALICE);
    server.directory.join(GUILD, BOB, { manage: true });
    server.store.users.upsert({ id: ALICE, name: 'Alice', avatar: null });
  });
  after(() => server.close());

  it('are made by people who may change the music, for 1, 7 or 30 days, shown once and kept as a hash', async () => {
    const alice = sessionFor(server, ALICE);
    const made = await inject({
      method: 'POST',
      url: api(`/guilds/${GUILD}/listen-links`),
      headers: { cookie: alice.cookie, [CSRF_HEADER]: alice.csrf },
      payload: { days: 30 },
    });
    assert.equal(made.statusCode, 200, made.body);
    const body = made.json();
    assert.equal(body.link.createdByName, 'Alice');
    assert.equal(body.link.maxGuests, GUESTS_PER_LINK);
    assert.equal(body.link.expiresAt - body.link.createdAt, 30 * 86_400_000);
    const code = new URL(body.url).hash.slice(1);
    assert.match(code, /^[A-Za-z0-9_-]{43}$/);
    // Only the hash is in the database.
    assert.ok(!JSON.stringify(server.store.db.prepare('SELECT * FROM listen_links').all()).includes(code));
    // Another length is refused, and someone without the DJ role may not make one.
    const twice = await inject({
      method: 'POST',
      url: api(`/guilds/${GUILD}/listen-links`),
      headers: asHost,
      payload: { days: 2 },
    });
    assert.equal(twice.statusCode, 400);
    server.store.settings.setDjRole(GUILD, DJ_ROLE);
    const refused = await inject({
      method: 'POST',
      url: api(`/guilds/${GUILD}/listen-links`),
      headers: { cookie: alice.cookie, [CSRF_HEADER]: alice.csrf },
      payload: { days: 1 },
    });
    assert.equal(refused.statusCode, 403);
    server.store.settings.setDjRole(GUILD, null);
  });

  it("are listed to their makers, all of them to Manage Server, and revoked by the same, nobody else's", async () => {
    const alices = (await inject({ method: 'GET', url: api(`/guilds/${GUILD}/listen-links`), headers: asHost }))
      .json()
      .map((link: { id: number }) => link.id) as number[];
    const host = await newLink(server);
    const alice = sessionFor(server, ALICE);
    const asAlice = { cookie: alice.cookie, [CSRF_HEADER]: alice.csrf };
    const hers = (await inject({ method: 'GET', url: api(`/guilds/${GUILD}/listen-links`), headers: asAlice })).json();
    assert.ok(hers.every((link: { createdBy: string }) => link.createdBy === ALICE));
    assert.ok(!hers.some((link: { id: number }) => link.id === host.id));
    const bob = sessionFor(server, BOB);
    const all = (
      await inject({ method: 'GET', url: api(`/guilds/${GUILD}/listen-links`), headers: { cookie: bob.cookie } })
    ).json();
    assert.ok(all.some((link: { id: number }) => link.id === host.id));
    // Alice cannot revoke the host's; Bob (Manage Server) can; a link of another server is not found here.
    const revoke = (id: number, headers: Record<string, string>, guild = GUILD) =>
      inject({ method: 'DELETE', url: api(`/guilds/${guild}/listen-links/${id}`), headers });
    assert.equal((await revoke(host.id, asAlice)).statusCode, 403);
    assert.equal((await revoke(host.id, { cookie: bob.cookie, [CSRF_HEADER]: bob.csrf })).statusCode, 200);
    const other = await newLink(server, OTHER_GUILD);
    assert.equal((await revoke(other.id, asHost)).statusCode, 404);
    assert.equal((await revoke(alices[0] ?? 0, asAlice)).statusCode, 200);
  });

  it("let a browser in as a guest from the panel's page, once per browser, up to the link's places", async () => {
    const link = await newLink(server);
    const guest = await guestOf(server, link.code);
    assert.match(decodeURIComponent(guest.cookie), new RegExp(`^${SESSION_COOKIE}=g\\.`));
    const me = (await inject({ method: 'GET', url: api('/me'), headers: { cookie: guest.cookie } })).json();
    assert.equal(me.kind, 'guest');
    assert.equal(me.scope, 'read');
    assert.equal(me.guest.guildId, GUILD);
    // The same browser again takes no second place; a member's browser keeps its own login.
    const again = await inject({
      method: 'POST',
      url: '/auth/listen',
      headers: { ...PANEL, cookie: guest.cookie },
      payload: { code: link.code },
    });
    assert.equal(again.headers['set-cookie'], undefined);
    const alice = sessionFor(server, ALICE);
    const member = await inject({
      method: 'POST',
      url: '/auth/listen',
      headers: { ...PANEL, cookie: alice.cookie },
      payload: { code: link.code },
    });
    assert.equal(member.statusCode, 200);
    assert.equal(member.headers['set-cookie'], undefined);
    assert.equal(server.store.guests.count(link.id), 1);
    // Every place taken: the next browser is told so.
    for (let i = 1; i < GUESTS_PER_LINK; i += 1) await guestOf(server, link.code);
    const full = await inject({ method: 'POST', url: '/auth/listen', headers: PANEL, payload: { code: link.code } });
    assert.equal(full.statusCode, 409);
    // Leaving frees a place.
    await inject({ method: 'POST', url: '/auth/logout', headers: { cookie: guest.cookie, [CSRF_HEADER]: guest.csrf } });
    assert.equal(server.store.guests.count(link.id), GUESTS_PER_LINK - 1);
  });

  it('let nobody in with a wrong code, count it as a failed login, and refuse another site', async () => {
    const wrong = await inject({
      method: 'POST',
      url: '/auth/listen',
      headers: PANEL,
      payload: { code: 'x'.repeat(43) },
      remoteAddress: '10.4.4.4',
    });
    assert.equal(wrong.statusCode, 404);
    for (let i = 0; i < 20; i += 1) {
      await inject({
        method: 'POST',
        url: '/auth/listen',
        headers: PANEL,
        payload: { code: 'y' },
        remoteAddress: '10.4.4.4',
      });
    }
    const blocked = await inject({
      method: 'POST',
      url: '/auth/listen',
      headers: PANEL,
      payload: { code: 'z' },
      remoteAddress: '10.4.4.4',
    });
    assert.equal(blocked.statusCode, 429);
    const link = await newLink(server);
    const elsewhere = await inject({
      method: 'POST',
      url: '/auth/listen',
      headers: { origin: 'https://evil.example', host: 'localhost:80' },
      payload: { code: link.code },
    });
    assert.equal(elsewhere.statusCode, 403);
    assert.equal(server.store.guests.count(link.id), 0);
  });
});

describe('what a guest must not reach', () => {
  let server: TestServer;
  let guest: { cookie: string; csrf: string };
  const inject = (options: InjectOptions) => server.web.app.inject(options);
  // A request as the guest, with its CSRF token (so a refusal is the guest's, not a missing token's).
  const as = (method: Method, url: string, payload?: unknown) =>
    inject({
      method,
      url: api(url),
      headers: { cookie: guest.cookie, [CSRF_HEADER]: guest.csrf },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });

  before(async () => {
    server = await testServer({ found: { one: [exampleTrack('a')], two: [exampleTrack('b'), exampleTrack('c')] } });
    // A track playing and one queued in the guest's server, one track in another server.
    for (const [guild, input] of [
      [GUILD, 'two'],
      [OTHER_GUILD, 'one'],
    ] as const) {
      await inject({ method: 'POST', url: api(`/guilds/${guild}/queue`), headers: asHost, payload: { input } });
    }
    guest = await guestOf(server, (await newLink(server)).code);
  });
  after(() => server.close());

  it('sees the player, the queue and the lyrics of its server, and nothing of another', async () => {
    assert.equal((await as('GET', `/guilds/${GUILD}/player`)).statusCode, 200);
    assert.equal((await as('GET', `/guilds/${GUILD}/queue`)).statusCode, 200);
    // Lyrics are off in this test server: allowed through, and answered so.
    assert.equal((await as('GET', `/guilds/${GUILD}/lyrics`)).statusCode, 503);
    const guilds = (await as('GET', '/guilds')).json();
    assert.deepEqual(
      guilds.map((guild: { id: string; mayControl: boolean; mayManage: boolean }) => [
        guild.id,
        guild.mayControl,
        guild.mayManage,
      ]),
      [[GUILD, false, false]],
    );
    for (const route of [
      `/guilds/${OTHER_GUILD}/player`,
      `/guilds/${OTHER_GUILD}/queue`,
      '/guilds/199999999999999999/queue',
    ]) {
      const answer = await as('GET', route);
      assert.equal(answer.statusCode, 403, route);
    }
  });

  it('changes nothing, even with its CSRF token', async () => {
    const changes: [Method, string, unknown?][] = [
      ['POST', `/guilds/${GUILD}/queue`, { input: 'one' }],
      ['POST', `/guilds/${GUILD}/player/skip`],
      ['POST', `/guilds/${GUILD}/player/pause`],
      ['POST', `/guilds/${GUILD}/player/seek`, { positionMs: 1000 }],
      ['PUT', `/guilds/${GUILD}/player/repeat`, { mode: 'queue' }],
      ['PUT', `/guilds/${GUILD}/player/stop-after`, { on: true }],
      ['POST', `/guilds/${GUILD}/queue/shuffle`],
      ['DELETE', `/guilds/${GUILD}/queue`],
      ['POST', `/guilds/${GUILD}/playlists`, { name: 'mine' }],
      ['PUT', `/guilds/${GUILD}/voice`, {}],
      ['PUT', `/guilds/${GUILD}/settings/dj-role`, { roleId: null }],
      ['POST', `/guilds/${GUILD}/listen-links`, { days: 1 }],
      ['POST', '/tokens', { name: 'mine', scope: 'read' }],
      ['POST', '/login-links', {}],
      ['POST', '/backups'],
      // How the server's people share the music, and its sound.
      ['PUT', `/guilds/${GUILD}/settings/vote-skip`, { on: false }],
      ['POST', `/guilds/${GUILD}/queue/turns`],
      ['PUT', `/guilds/${GUILD}/voice/volume`, { percent: 50 }],
      ['PUT', `/guilds/${GUILD}/voice/sound`, { preset: 'bass' }],
      // Likes, autoplay and playlists from files: a guest has no login of its own to like with, and adds nothing.
      ['PUT', `/guilds/${GUILD}/likes/1`],
      ['DELETE', `/guilds/${GUILD}/likes/1`],
      ['POST', `/guilds/${GUILD}/likes/queue`, {}],
      ['PUT', `/guilds/${GUILD}/player/autoplay`, { mode: 'history' }],
      ['POST', `/guilds/${GUILD}/playlists/import`, { name: 'mine', content: 'https://media.example/one' }],
    ];
    for (const [method, route, payload] of changes) {
      const answer = await as(method, route, payload);
      assert.equal(answer.statusCode, 403, `${method} ${route}`);
    }
    assert.equal(server.queue.size(GUILD), 1);
    assert.equal(server.players.get(GUILD).snapshot().repeat, 'off');
  });

  it('reaches no statistics, history, playlists, settings, channels, logs, tokens, links, searches or likes', async () => {
    for (const route of [
      `/guilds/${GUILD}/stats`,
      `/guilds/${GUILD}/history`,
      `/guilds/${GUILD}/playlists`,
      `/guilds/${GUILD}/settings`,
      `/guilds/${GUILD}/voice`,
      `/guilds/${GUILD}/listen-links`,
      // A search, the likes and a playlist's file: a guest neither adds nor likes.
      `/guilds/${GUILD}/search?q=paper%20boats`,
      `/guilds/${GUILD}/likes`,
      `/guilds/${GUILD}/playlists/mine/export`,
      '/logs',
      '/tokens',
      '/doctor',
    ]) {
      const answer = await as('GET', route);
      assert.equal(answer.statusCode, 403, route);
      assert.equal(answer.json().error.message, 'a guest of a listening link can only listen', route);
    }
  });

  it('hears only the audio of what its server plays or has queued', async () => {
    const current = server.players.get(GUILD).snapshot().track;
    const queued = server.queue.list(GUILD)[0]?.track;
    const elsewhere = server.players.get(OTHER_GUILD).snapshot().track;
    assert.ok(current && queued && elsewhere);
    // A file for each, so the answer is about whether it may be heard, not whether it is ready.
    for (const track of [current, queued, elsewhere]) {
      const key = MediaCache.keyOf(track.source);
      fs.writeFileSync(path.join(server.cache.dir, `${key}.opus`), 'OggS');
      fs.writeFileSync(
        path.join(server.cache.dir, `${key}.json`),
        JSON.stringify({ source: track.source, durationMs: 1 }),
      );
    }
    server.cache.init();
    const audio = (guild: string, id: number) =>
      inject({ method: 'GET', url: api(`/guilds/${guild}/tracks/${id}/audio`), headers: { cookie: guest.cookie } });
    assert.equal((await audio(GUILD, current.id)).statusCode, 200);
    assert.equal((await audio(GUILD, queued.id)).statusCode, 200);
    // Another server's track, through either server's address; a track played before and gone from the queue.
    assert.equal((await audio(OTHER_GUILD, elsewhere.id)).statusCode, 403);
    assert.equal((await audio(GUILD, elsewhere.id)).statusCode, 404);
  });
});

describe('a revoked or expired listening link', () => {
  it('ends its guests at once, their live connections too', async () => {
    const server = await testServer({ listen: true });
    try {
      const link = await newLink(server);
      const guest = await guestOf(server, link.code);
      const socket = new WebSocket(`${server.url.replace('http', 'ws')}/api/v1/events?guild=${GUILD}`, {
        headers: { cookie: guest.cookie },
      } as unknown as string[]);
      const closed = new Promise<{ code: number; reason: string }>((resolve) =>
        socket.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason })),
      );
      const state = new Promise<Record<string, unknown>>((resolve) =>
        socket.addEventListener('message', (event) => {
          const message = JSON.parse(String(event.data)) as Record<string, unknown>;
          if (message.type === 'state') resolve(message);
        }),
      );
      // Its live state hides the voice channels and says the guest is a guest among the listeners.
      const first = await state;
      assert.deepEqual((first.voice as { channels: unknown[] }).channels, []);
      socket.send(JSON.stringify({ type: 'listening', on: true }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(server.web.hub.listeners(GUILD).people, [
        { id: null, name: 'Guest', avatar: null, guest: true },
      ]);
      await server.web.app.inject({
        method: 'DELETE',
        url: api(`/guilds/${GUILD}/listen-links/${link.id}`),
        headers: asHost,
      });
      assert.deepEqual(await closed, { code: 4401, reason: 'the listening link has ended' });
      const me = await server.web.app.inject({ method: 'GET', url: api('/me'), headers: { cookie: guest.cookie } });
      assert.equal(me.statusCode, 401);
    } finally {
      await server.close();
    }
  });

  it('ends with its time', async () => {
    const server = await testServer();
    try {
      const guest = await guestOf(server, (await newLink(server, GUILD, 1)).code);
      const me = () => server.web.app.inject({ method: 'GET', url: api('/me'), headers: { cookie: guest.cookie } });
      assert.equal((await me()).statusCode, 200);
      await server.clock.advance(86_400_000);
      assert.equal((await me()).statusCode, 401);
    } finally {
      await server.close();
    }
  });
});

describe('a friend the host lets in with a login link', () => {
  // A friend's session cookie, through a login link the host made for that scope.
  async function friend(server: TestServer, scope: 'read' | 'control') {
    const link = await server.web.app.inject({
      method: 'POST',
      url: api(`/login-links?scope=${scope}`),
      headers: asHost,
    });
    assert.equal(link.json().scope, scope);
    const used = await server.web.app.inject({ method: 'GET', url: new URL(link.json().url as string).pathname });
    const cookie = String(used.headers['set-cookie']).split(';')[0] ?? '';
    const me = await server.web.app.inject({ method: 'GET', url: api('/me'), headers: { cookie } });
    return { cookie, csrf: me.json().csrf as string, me: me.json() };
  }

  it("may view, or control, in every server, but never manage, make tokens or links for others, or reach the host's", async () => {
    const server = await testServer({ found: { one: [exampleTrack('a')] } });
    try {
      const viewer = await friend(server, 'read');
      assert.deepEqual([viewer.me.kind, viewer.me.scope], ['friend', 'read']);
      const controller = await friend(server, 'control');
      const send = (who: { cookie: string; csrf: string }, method: Method, route: string, payload?: unknown) =>
        server.web.app.inject({
          method,
          url: api(route),
          headers: { cookie: who.cookie, [CSRF_HEADER]: who.csrf },
          ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
        });
      assert.equal((await send(viewer, 'GET', `/guilds/${GUILD}/queue`)).statusCode, 200);
      assert.equal((await send(viewer, 'POST', `/guilds/${GUILD}/queue`, { input: 'one' })).statusCode, 403);
      assert.equal((await send(controller, 'POST', `/guilds/${GUILD}/queue`, { input: 'one' })).statusCode, 200);
      const guilds = (await send(controller, 'GET', '/guilds')).json();
      assert.deepEqual(
        guilds.map((guild: { mayControl: boolean; mayManage: boolean }) => [guild.mayControl, guild.mayManage]),
        [
          [true, false],
          [true, false],
        ],
      );
      for (const [method, route, payload] of [
        ['PUT', `/guilds/${GUILD}/settings/dj-role`, { roleId: null }],
        ['POST', '/tokens', { name: 'mine', scope: 'read' }],
        ['GET', '/tokens'],
        ['GET', '/logs'],
        ['POST', '/login-links', {}],
        ['POST', '/backups'],
      ] as [Method, string, unknown?][]) {
        assert.equal((await send(controller, method, route, payload)).statusCode, 403, `${method} ${route}`);
      }
      // A friend's row is never read as the host's.
      assert.equal(server.auth.identify({ cookie: controller.cookie })?.principal.kind, 'friend');
    } finally {
      await server.close();
    }
  });

  it('is held to the rates of changes, as anyone but the host is', async () => {
    const server = await testServer({
      found: { one: [exampleTrack('a')] },
      rates: { changes: { perSecond: 0.001, burst: 2 }, now: () => 0 },
    });
    try {
      const controller = await friend(server, 'control');
      const shuffle = (headers: Record<string, string>) =>
        server.web.app.inject({ method: 'POST', url: api(`/guilds/${GUILD}/queue/shuffle`), headers });
      const asFriend = { cookie: controller.cookie, [CSRF_HEADER]: controller.csrf };
      assert.equal((await shuffle(asFriend)).statusCode, 200);
      assert.equal((await shuffle(asFriend)).statusCode, 200);
      assert.equal((await shuffle(asFriend)).statusCode, 429);
      // The host is not.
      for (let i = 0; i < 4; i += 1) assert.equal((await shuffle(asHost)).statusCode, 200);
    } finally {
      await server.close();
    }
  });
});
