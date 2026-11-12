import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { InjectOptions } from 'fastify';
import { MediaCache } from '../../src/media/cache.ts';
import { API, API_PREFIX, OPERATIONS } from '../../src/web/api.ts';
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

const api = (path: string) => `${API_PREFIX}${path}`;

describe('the HTTP API', () => {
  let server: TestServer;

  before(async () => {
    server = await testServer({
      found: { one: [exampleTrack('a')], three: [exampleTrack('b'), exampleTrack('c'), exampleTrack('d')] },
    });
    server.directory.join(GUILD, ALICE);
    server.store.users.upsert({ id: ALICE, name: 'Alice', avatar: null });
  });
  after(() => server.close());

  const inject = (options: InjectOptions) => server.web.app.inject(options);

  it('answers the status to anyone and everything else only after a login', async () => {
    const status = await inject({ method: 'GET', url: api('/status') });
    assert.equal(status.statusCode, 200);
    assert.deepEqual(Object.keys(status.json()).sort(), ['discord', 'login', 'mode', 'uptimeMs', 'version']);
    const me = await inject({ method: 'GET', url: api('/me') });
    assert.equal(me.statusCode, 401);
    assert.deepEqual(me.json(), { error: { code: 'unauthorized', message: 'log in first' } });
  });

  it('adds, lists and plays with the host token, naming who added what', async () => {
    const added = await inject({
      method: 'POST',
      url: api(`/guilds/${GUILD}/queue`),
      headers: asHost,
      payload: { input: 'three' },
    });
    assert.equal(added.statusCode, 200);
    const body = added.json() as { items: { track: { title: string; source?: string } }[]; skippedFull: number };
    assert.equal(body.items.length, 3);
    // Internal fields stay inside: the response schema does not list the cache key.
    assert.equal(body.items[0]?.track.source, undefined);
    const player = await inject({ method: 'GET', url: api(`/guilds/${GUILD}/player`), headers: asHost });
    assert.equal(player.json().status, 'loading');
    assert.equal(player.json().track.title, 'Track b');
    const queue = await inject({ method: 'GET', url: api(`/guilds/${GUILD}/queue`), headers: asHost });
    assert.deepEqual(
      queue.json().items.map((item: { track: { title: string } }) => item.track.title),
      ['Track c', 'Track d'],
    );
  });

  it('turns action errors and invalid requests into the right statuses', async () => {
    const idle = await inject({ method: 'POST', url: api(`/guilds/${OTHER_GUILD}/player/skip`), headers: asHost });
    assert.equal(idle.statusCode, 409);
    assert.equal(idle.json().error.code, 'conflict');
    const empty = await inject({ method: 'POST', url: api(`/guilds/${GUILD}/queue`), headers: asHost, payload: {} });
    assert.equal(empty.statusCode, 400);
    assert.equal(empty.json().error.code, 'invalid');
    const badGuild = await inject({ method: 'GET', url: api('/guilds/nope/queue'), headers: asHost });
    assert.equal(badGuild.statusCode, 400);
    const unknown = await inject({ method: 'GET', url: api('/guilds/199999999999999999/queue'), headers: asHost });
    assert.equal(unknown.statusCode, 404);
    const nothing = await inject({
      method: 'POST',
      url: api(`/guilds/${GUILD}/queue`),
      headers: asHost,
      payload: { input: 'nothing' },
    });
    assert.equal(nothing.statusCode, 400);
    // A field the operation does not know is dropped, not refused.
    const extra = await inject({
      method: 'PUT',
      url: api(`/guilds/${GUILD}/player/repeat`),
      headers: asHost,
      payload: { mode: 'queue', volume: 11 },
    });
    assert.equal(extra.statusCode, 200);
    assert.equal(extra.json().repeat, 'queue');
    const badJson = await inject({
      method: 'POST',
      url: api(`/guilds/${GUILD}/queue`),
      headers: { ...asHost, 'content-type': 'application/json' },
      payload: '{"input":',
    });
    assert.equal(badJson.statusCode, 400);
    const missing = await inject({ method: 'GET', url: api('/nowhere'), headers: asHost });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, 'not-found');
  });

  it('keeps a read token to looking', async () => {
    const created = await inject({
      method: 'POST',
      url: api('/tokens'),
      headers: asHost,
      payload: { name: 'viewer', scope: 'read' },
    });
    const token = created.json().token as string;
    const headers = { authorization: `Bearer ${token}` };
    assert.equal((await inject({ method: 'GET', url: api(`/guilds/${GUILD}/queue`), headers })).statusCode, 200);
    const change = await inject({ method: 'POST', url: api(`/guilds/${GUILD}/queue/shuffle`), headers });
    assert.equal(change.statusCode, 403);
    assert.equal((await inject({ method: 'GET', url: api('/tokens'), headers })).statusCode, 403);
  });

  it('needs the CSRF header for changes made with a session cookie', async () => {
    const { cookie, csrf } = sessionFor(server, ALICE);
    assert.equal(
      (await inject({ method: 'GET', url: api(`/guilds/${GUILD}/queue`), headers: { cookie } })).statusCode,
      200,
    );
    const without = await inject({ method: 'POST', url: api(`/guilds/${GUILD}/queue/shuffle`), headers: { cookie } });
    assert.equal(without.statusCode, 403);
    assert.match(without.json().error.message, /CSRF/);
    const withIt = await inject({
      method: 'POST',
      url: api(`/guilds/${GUILD}/queue/shuffle`),
      headers: { cookie, [CSRF_HEADER]: csrf },
    });
    assert.equal(withIt.statusCode, 200);
    const me = await inject({ method: 'GET', url: api('/me'), headers: { cookie } });
    assert.deepEqual([me.json().kind, me.json().name, me.json().csrf], ['user', 'Alice', csrf]);
  });

  it('applies the DJ role and membership to a Discord login', async () => {
    const { cookie, csrf } = sessionFor(server, ALICE);
    const headers = { cookie, [CSRF_HEADER]: csrf };
    // Not a member of the other server.
    assert.equal((await inject({ method: 'GET', url: api(`/guilds/${OTHER_GUILD}/queue`), headers })).statusCode, 403);
    // Setting the DJ role needs Manage Server, which Alice does not have.
    const set = await inject({
      method: 'PUT',
      url: api(`/guilds/${GUILD}/settings/dj-role`),
      headers,
      payload: { roleId: DJ_ROLE },
    });
    assert.equal(set.statusCode, 403);
    const byHost = await inject({
      method: 'PUT',
      url: api(`/guilds/${GUILD}/settings/dj-role`),
      headers: asHost,
      payload: { roleId: DJ_ROLE },
    });
    assert.equal(byHost.json().djRoleId, DJ_ROLE);
    // Alice cannot change the music now (the membership answer is fresh enough; the rule is read on every call).
    const shuffle = await inject({ method: 'POST', url: api(`/guilds/${GUILD}/queue/shuffle`), headers });
    assert.equal(shuffle.statusCode, 403);
    assert.match(shuffle.json().error.message, /DJ role/);
    await inject({
      method: 'PUT',
      url: api(`/guilds/${GUILD}/settings/dj-role`),
      headers: asHost,
      payload: { roleId: null },
    });
    // Bob is in no server at all.
    const bob = sessionFor(server, BOB);
    assert.deepEqual(
      (await inject({ method: 'GET', url: api('/guilds'), headers: { cookie: bob.cookie } })).json(),
      [],
    );
  });

  it('keeps the host operations to the host', async () => {
    const { cookie } = sessionFor(server, ALICE);
    assert.equal((await inject({ method: 'GET', url: api('/logs'), headers: { cookie } })).statusCode, 403);
    assert.equal((await inject({ method: 'GET', url: api('/logs'), headers: asHost })).statusCode, 200);
    assert.equal((await inject({ method: 'GET', url: api('/doctor'), headers: asHost })).json().ok, true);
  });

  it('logs a browser in once with a login link', async () => {
    const link = await inject({ method: 'POST', url: api('/login-links'), headers: asHost });
    const url = new URL(link.json().url as string);
    assert.equal(url.origin, 'http://localhost:8795');
    const used = await inject({ method: 'GET', url: url.pathname });
    assert.equal(used.statusCode, 302);
    assert.equal(used.headers.location, '/');
    const setCookie = String(used.headers['set-cookie']);
    assert.match(setCookie, new RegExp(`^${SESSION_COOKIE}=`));
    const me = await inject({ method: 'GET', url: api('/me'), headers: { cookie: setCookie.split(';')[0] } });
    assert.equal(me.json().kind, 'host');
    const again = await inject({ method: 'GET', url: url.pathname });
    assert.equal(again.headers.location, '/login?error=link');
  });

  it('removes a session cookie that no longer logs in', async () => {
    const stale = await inject({
      method: 'GET',
      url: api('/me'),
      headers: { cookie: `${SESSION_COOKIE}=gone` },
      remoteAddress: '10.9.9.9',
    });
    assert.equal(stale.statusCode, 401);
    assert.match(String(stale.headers['set-cookie']), /Max-Age=0/);
  });

  it('blocks an address after 20 failed logins', async () => {
    for (let i = 0; i < 20; i += 1) {
      await inject({
        method: 'GET',
        url: api('/me'),
        headers: { authorization: 'Bearer jkc_wrong' },
        remoteAddress: '10.0.0.7',
      });
    }
    const blocked = await inject({ method: 'GET', url: api('/me'), headers: asHost, remoteAddress: '10.0.0.7' });
    assert.equal(blocked.statusCode, 429);
    // Other addresses are not affected.
    assert.equal(
      (await inject({ method: 'GET', url: api('/me'), headers: asHost, remoteAddress: '10.0.0.8' })).statusCode,
      200,
    );
  });

  it('serves the OpenAPI document with every operation and only references that resolve', async () => {
    const document = (await inject({ method: 'GET', url: api('/openapi.json') })).json() as {
      paths: Record<string, Record<string, { operationId: string }>>;
      components: { schemas: Record<string, unknown> };
    };
    const ids = Object.values(document.paths).flatMap((methods) => Object.values(methods).map((op) => op.operationId));
    for (const name of OPERATIONS) assert.ok(ids.includes(name), `${name} is missing from the document`);
    assert.equal(new Set(ids).size, ids.length);
    for (const name of OPERATIONS) {
      const spec = API[name];
      assert.equal(document.paths[spec.path]?.[spec.method.toLowerCase()]?.operationId, name);
    }
    const refs = [...JSON.stringify(document).matchAll(/"\$ref":"#\/components\/schemas\/(\w+)"/g)].map((m) => m[1]);
    assert.ok(refs.length > 20);
    for (const ref of refs) assert.ok(ref && ref in document.components.schemas, `${ref} does not resolve`);
  });

  it('answers health, readiness and metrics', async () => {
    assert.equal((await inject({ method: 'GET', url: '/healthz' })).body, 'ok\n');
    assert.deepEqual((await inject({ method: 'GET', url: '/readyz' })).json(), { ready: true, discord: true });
    const metrics = (await inject({ method: 'GET', url: '/metrics' })).body;
    assert.match(metrics, /^jukecord_info\{version="\d+\.\d+\.\d+.*"\} 1$/m);
    assert.match(metrics, /^jukecord_players\{status="loading"\} 1$/m);
    assert.match(metrics, /^jukecord_http_responses_total\{class="2xx"\} \d+$/m);
  });

  it('keeps the metrics from the internet: nothing through the proxy or from a public address', async () => {
    // From a machine beside jukecord (the cluster, the same network): the numbers.
    assert.equal((await inject({ method: 'GET', url: '/metrics', remoteAddress: '10.1.2.3' })).statusCode, 200);
    // Through the reverse proxy, which adds X-Forwarded-For, or from a public address: an unknown path.
    const proxied = await inject({ method: 'GET', url: '/metrics', headers: { 'x-forwarded-for': '203.0.113.9' } });
    assert.equal(proxied.statusCode, 404);
    assert.equal((await inject({ method: 'GET', url: '/metrics', remoteAddress: '203.0.113.9' })).statusCode, 404);
  });

  it('sends security headers, and no caching of API answers', async () => {
    const page = await inject({
      method: 'GET',
      url: '/stats',
      headers: { accept: 'text/html', host: 'localhost:8795' },
    });
    assert.equal(page.statusCode, 200);
    assert.match(
      String(page.headers['content-security-policy']),
      /default-src 'self'.*connect-src 'self' ws:\/\/localhost:8795/,
    );
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    const answer = await inject({ method: 'GET', url: api('/status') });
    assert.equal(answer.headers['cache-control'], 'no-store');
  });

  it("serves a server's queued track with Range, and nothing else", async () => {
    const track = server.store.tracks.upsert(exampleTrack('audio'));
    const url = api(`/guilds/${GUILD}/tracks/${track.id}/audio`);
    // Not queued anywhere yet: not served, whatever the cache holds.
    assert.equal((await inject({ method: 'GET', url, headers: asHost })).statusCode, 404);
    // A track "number" that is not one is not looked for at all.
    for (const odd of ['abc', '0', '1.5', '99999999999999999999']) {
      const answer = await inject({ method: 'GET', url: api(`/guilds/${GUILD}/tracks/${odd}/audio`), headers: asHost });
      assert.equal(answer.statusCode, 404, odd);
    }
    server.queue.add(GUILD, [track.id], 'end', null);
    assert.equal((await inject({ method: 'GET', url, headers: asHost })).statusCode, 409);
    const key = MediaCache.keyOf(track.source);
    const tmp = server.cache.tmpPath(key);
    fs.writeFileSync(tmp, Buffer.alloc(1000, 7));
    server.cache.commit(key, tmp, { source: track.source, durationMs: 1000, loudness: null });
    const whole = await inject({ method: 'GET', url, headers: asHost });
    assert.equal(whole.statusCode, 200);
    assert.match(String(whole.headers['content-type']), /^audio\/ogg/);
    assert.equal(whole.rawPayload.length, 1000);
    // A track's file never changes: browsers keep it for a day (the panel files' "no-cache" must not replace it).
    assert.equal(whole.headers['cache-control'], 'private, max-age=86400');
    const part = await inject({ method: 'GET', url, headers: { ...asHost, range: 'bytes=100-199' } });
    assert.equal(part.statusCode, 206);
    assert.equal(part.rawPayload.length, 100);
    assert.equal((await inject({ method: 'GET', url })).statusCode, 401);
    // Through another server's path: that server does not have it.
    assert.equal(
      (await inject({ method: 'GET', url: api(`/guilds/${OTHER_GUILD}/tracks/${track.id}/audio`), headers: asHost }))
        .statusCode,
      404,
    );
    // A member of neither server cannot ask at all.
    const stranger = sessionFor(server, BOB);
    assert.equal((await inject({ method: 'GET', url, headers: { cookie: stranger.cookie } })).statusCode, 403);
  });
});

describe('the HTTP API in browser-only mode', () => {
  it('has the one local queue', async () => {
    const server = await testServer({ browserOnly: true, found: { one: [exampleTrack('a')] } });
    try {
      const guilds = await server.web.app.inject({ method: 'GET', url: api('/guilds'), headers: asHost });
      assert.deepEqual(
        guilds.json().map((guild: { id: string }) => guild.id),
        ['local'],
      );
      const status = await server.web.app.inject({ method: 'GET', url: api('/status') });
      assert.equal(status.json().mode, 'browser-only');
      const voice = await server.web.app.inject({ method: 'GET', url: api('/guilds/local/voice'), headers: asHost });
      assert.deepEqual(voice.json(), { current: null, channels: [] });
      const join = await server.web.app.inject({
        method: 'PUT',
        url: api('/guilds/local/voice'),
        headers: asHost,
        payload: {},
      });
      assert.equal(join.statusCode, 503);
    } finally {
      await server.close();
    }
  });
});

describe('logging in with Discord through the server', () => {
  it('lets members in, sends others back with the reason, and keeps the state cookie to one login', async () => {
    const fetcher = (async (url: string | URL) => {
      if (String(url).endsWith('/oauth2/token')) return Response.json({ access_token: 'a' });
      if (String(url).endsWith('/users/@me'))
        return Response.json({ id: ALICE, username: 'alice', global_name: 'Alice' });
      return new Response(null);
    }) as typeof fetch;
    const server = await testServer({
      fetch: fetcher,
      oauth: {
        clientId: '108876543210987654',
        clientSecret: 's',
        redirectUri: 'http://localhost:8795/auth/callback',
        api: 'https://discord.test/api',
        authorize: 'https://discord.test/oauth2/authorize',
      },
    });
    try {
      const app = server.web.app;
      const login = async () => {
        const start = await app.inject({ method: 'GET', url: '/auth/login?next=/stats' });
        assert.equal(start.statusCode, 302);
        const state = new URL(String(start.headers.location)).searchParams.get('state');
        const stateCookie = String(start.headers['set-cookie']).split(';')[0];
        return app.inject({
          method: 'GET',
          url: `/auth/callback?code=c&state=${state}`,
          headers: { cookie: stateCookie },
        });
      };
      // Just started, Discord's server list not here yet: "still connecting", and not counted as a failed login
      // (21 of them would pass the limit of 20).
      server.directory.serversKnown = false;
      for (let i = 0; i < 21; i += 1) {
        assert.equal((await login()).headers.location, '/login?error=connecting');
      }
      const early = await app.inject({ method: 'GET', url: api('/guilds'), headers: asHost });
      assert.equal(early.statusCode, 503);
      assert.equal(early.json().error.code, 'unavailable');
      server.directory.serversKnown = true;
      const stranger = await login();
      assert.equal(stranger.headers.location, '/login?error=not-a-member');
      server.directory.join(GUILD, ALICE);
      const member = await login();
      assert.equal(member.headers.location, '/stats');
      const session = [member.headers['set-cookie']].flat().find((value) => String(value).startsWith(SESSION_COOKIE));
      assert.ok(session);
      const me = await app.inject({
        method: 'GET',
        url: api('/me'),
        headers: { cookie: String(session).split(';')[0] },
      });
      assert.equal(me.json().name, 'Alice');
      const cancelled = await app.inject({ method: 'GET', url: '/auth/callback?error=access_denied' });
      assert.equal(cancelled.headers.location, '/login?error=cancelled');
    } finally {
      await server.close();
    }
  });
});
