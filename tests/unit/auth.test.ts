import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { MemoryCache } from '../../src/cache/memory.ts';
import { createLogger } from '../../src/log.ts';
import { MetricsRegistry } from '../../src/metrics/registry.ts';
import {
  Auth,
  addressFailures,
  addressKey,
  cookie,
  ensureHostToken,
  hashSecret,
  LoginLimiter,
  nameFailures,
  parseCookies,
  SESSION_COOKIE,
  safeNext,
} from '../../src/web/auth.ts';
import { memoryStore } from '../support/store.ts';
import { ALICE, HOST_TOKEN } from '../support/web.ts';

const log = createLogger({ level: 'error', sinks: [] });

async function setup(options: { fetch?: typeof fetch; now?: () => number } = {}) {
  let now = Date.UTC(2026, 10, 11);
  const clock = options.now ?? (() => now);
  const store = await memoryStore(clock);
  // The cache on the same clock, so the ten minutes of a login link pass when the test says.
  const cache = new MemoryCache({ now: clock });
  const auth = new Auth({
    store,
    hostToken: HOST_TOKEN,
    secureCookies: false,
    cache,
    log,
    now: clock,
    oauth: {
      clientId: '108876543210987654',
      clientSecret: 'oauth-secret',
      redirectUri: 'http://localhost:8795/auth/callback',
      api: 'https://discord.test/api',
      authorize: 'https://discord.test/oauth2/authorize',
    },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return { store, cache, auth, advance: (ms: number) => (now += ms) };
}

describe('cookies', () => {
  it('reads a Cookie header and writes httpOnly SameSite cookies', () => {
    assert.deepEqual(
      [...parseCookies('a=1; jukecord_session=x%20y; broken; b=%E0%A4%A')],
      [
        ['a', '1'],
        ['jukecord_session', 'x y'],
      ],
    );
    assert.equal(
      cookie('n', 'v', { maxAgeSeconds: 60, secure: true }),
      'n=v; Path=/; HttpOnly; SameSite=Lax; Max-Age=60; Secure',
    );
  });
});

describe('ensureHostToken', () => {
  it('makes the host token once, readable by its owner only, and keeps it across starts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-host-'));
    try {
      const first = ensureHostToken(dir);
      assert.match(first, /^jkc_[A-Za-z0-9_-]{43}$/);
      // Windows keeps no such bits (a file's mode there says only whether it is read-only); there the data folder in
      // the user's own profile is what keeps other users out.
      if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'host-token')).mode & 0o777, 0o600);
      assert.equal(ensureHostToken(dir), first);
      // A damaged file is replaced rather than trusted.
      fs.writeFileSync(path.join(dir, 'host-token'), 'garbage');
      assert.notEqual(ensureHostToken(dir), first);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Auth tokens', () => {
  it('knows the host token, stores other tokens as hashes, and narrows what each may do', async () => {
    const { store, auth } = await setup();
    const host = await auth.identify({ authorization: `Bearer ${HOST_TOKEN}` });
    assert.deepEqual([host?.principal.kind, host?.scope, host?.via], ['host', 'admin', 'token']);
    assert.ok(host);
    const made = await auth.createToken(host, 'script', 'read');
    // Only the hash is in the database.
    const row = await store.sql.get('SELECT hash FROM api_tokens');
    assert.equal(row?.hash, hashSecret(made.token));
    assert.ok(!JSON.stringify(await store.sql.all('SELECT * FROM api_tokens')).includes(made.token));
    const reader = await auth.identify({ authorization: `Bearer ${made.token}` });
    assert.equal(reader?.scope, 'read');
    // A read token cannot make a wider one.
    assert.ok(reader);
    await assert.rejects(() => auth.createToken(reader, 'wider', 'admin'), /cannot make/);
    assert.equal(await auth.identify({ authorization: 'Bearer jkc_not-a-real-token' }), null);
    assert.equal(await auth.identify({ authorization: 'Basic abc' }), null);
  });

  it("lets a user list and revoke only their own tokens, and the host anyone's", async () => {
    const { auth } = await setup();
    const host = await auth.identify({ authorization: `Bearer ${HOST_TOKEN}` });
    assert.ok(host);
    const alice = { ...host, principal: { kind: 'user' as const, userId: ALICE } };
    const hosts = await auth.createToken(host, 'host script', 'admin');
    const alices = await auth.createToken(alice, 'my phone', 'control');
    assert.deepEqual(
      (await auth.listTokens(alice)).map((token) => token.name),
      ['my phone'],
    );
    assert.equal((await auth.listTokens(host)).length, 2);
    assert.equal(await auth.revokeToken(alice, hosts.info.id), false);
    assert.equal(await auth.revokeToken(alice, alices.info.id), true);
    assert.equal(await auth.identify({ authorization: `Bearer ${alices.token}` }), null);
    assert.equal(await auth.revokeToken(host, hosts.info.id), true);
  });
});

describe('Auth sessions', () => {
  it('logs a browser in with a cookie, needs the CSRF token for changes, and ends on logout or after 30 days', async () => {
    const { auth, advance } = await setup();
    const set = await auth.startSession({ kind: 'user', userId: ALICE });
    assert.match(
      set,
      new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000$`),
    );
    const header = set.split(';')[0];
    const caller = await auth.identify({ cookie: `other=1; ${header}` });
    assert.equal(caller?.via, 'session');
    assert.ok(caller?.csrf);
    assert.equal(auth.csrfOk(caller, caller.csrf), true);
    assert.equal(auth.csrfOk(caller, undefined), false);
    assert.equal(auth.csrfOk(caller, `${caller.csrf}x`), false);
    // A bearer token wins over a cookie in the same request.
    assert.equal((await auth.identify({ cookie: header, authorization: `Bearer ${HOST_TOKEN}` }))?.via, 'token');
    advance(30 * 86_400_000);
    assert.equal(await auth.identify({ cookie: header }), null);
    const again = (await auth.startSession({ kind: 'host' })).split(';')[0];
    const host = await auth.identify({ cookie: again });
    assert.equal(host?.principal.kind, 'host');
    assert.match(await auth.endSession(host), /Max-Age=0/);
    assert.equal(await auth.identify({ cookie: again }), null);
  });

  it('turns a login link into one login within ten minutes', async () => {
    const { auth, cache, advance } = await setup();
    const first = await auth.createLink();
    // The host's own, unless made for a friend.
    assert.equal(await auth.useLink(first.code), 'admin');
    assert.equal(await auth.useLink(first.code), null);
    const friend = await auth.createLink('control');
    // The cache holds the code's hash, never the code itself.
    assert.equal(await cache.get(`auth:link:${friend.code}`), null);
    assert.notEqual(await cache.get(`auth:link:${hashSecret(friend.code)}`), null);
    assert.equal(await auth.useLink(friend.code), 'control');
    const second = await auth.createLink();
    advance(10 * 60_000);
    assert.equal(await auth.useLink(second.code), null);
  });

  it('lets two browsers bringing one link at once log in once between them', async () => {
    const { auth } = await setup();
    const link = await auth.createLink();
    const both = await Promise.all([auth.useLink(link.code), auth.useLink(link.code)]);
    assert.deepEqual(both.sort(), ['admin', null].sort());
  });

  it('takes a link made by another process sharing the cache', async () => {
    const { store, cache, auth } = await setup();
    // A second jukecord over the same cache: what one makes, the other takes (an edge to another edge).
    const other = new Auth({ store, hostToken: HOST_TOKEN, secureCookies: false, oauth: null, cache, log });
    const link = await auth.createLink('read');
    assert.equal(await other.useLink(link.code), 'read');
    assert.equal(await auth.useLink(link.code), null);
  });
});

describe('LoginLimiter', () => {
  it('blocks an address after 20 failures in 10 minutes and lets it in again after', async () => {
    let now = 0;
    const limiter = new LoginLimiter(new MemoryCache({ now: () => now }));
    const here = addressFailures('10.0.0.1');
    for (let i = 0; i < 19; i += 1) assert.equal(await limiter.fail([here]), false);
    assert.equal(await limiter.blocked([here]), false);
    // The twentieth failure is not refused itself; the try after it is the first one that is.
    assert.equal(await limiter.fail([here]), false);
    assert.equal(await limiter.blocked([here]), true);
    assert.equal(await limiter.fail([here]), true);
    assert.equal(await limiter.blocked([addressFailures('10.0.0.2')]), false);
    now += 10 * 60_000 + 1;
    assert.equal(await limiter.blocked([here]), false);
  });

  it('blocks on any of its keys: an address, or a name tried from many addresses', async () => {
    const limiter = new LoginLimiter(new MemoryCache(), { limit: 3 });
    const alice = nameFailures('ldap', 'Alice');
    // The name as the directory compares it: one count whatever the case and the spaces around it.
    assert.equal(nameFailures('ldap', ' ALICE '), alice);
    assert.notEqual(nameFailures('oidc', 'alice'), alice);
    // However long the name sent, its key is no longer than the longest name taken.
    assert.equal(nameFailures('ldap', 'x'.repeat(60_000)).length, 'name:ldap:'.length + 256);
    for (const address of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) await limiter.fail([addressFailures(address), alice]);
    // Each address failed once; the name three times.
    assert.equal(await limiter.blocked([addressFailures('10.0.0.4')]), false);
    assert.equal(await limiter.blocked([addressFailures('10.0.0.4'), alice]), true);
    assert.equal(await limiter.blocked([addressFailures('10.0.0.4'), nameFailures('ldap', 'bob')]), false);
  });

  it('counts the logins by way and outcome', async () => {
    const { store, cache } = await setup();
    const metrics = new MetricsRegistry();
    const auth = new Auth({ store, hostToken: HOST_TOKEN, secureCookies: false, oauth: null, cache, log, metrics });
    auth.counted('ldap', 'failed');
    auth.counted('ldap', 'failed');
    auth.counted('oidc', 'ok');
    const text = metrics.render();
    assert.match(text, /^jukecord_logins_total\{method="ldap",outcome="failed"\} 2$/m);
    assert.match(text, /^jukecord_logins_total\{method="oidc",outcome="ok"\} 1$/m);
  });
});

describe('Discord login', () => {
  // A fake Discord: the token exchange, the user, and the revocation, recording what was asked.
  function fakeDiscord(
    user: Record<string, unknown> = { id: ALICE, username: 'alice', global_name: 'Alice', avatar: 'abc' },
  ) {
    const calls: { url: string; body: string }[] = [];
    const fetcher = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? '') });
      if (String(url).endsWith('/oauth2/token')) return Response.json({ access_token: 'discord-access' });
      if (String(url).endsWith('/users/@me')) return Response.json(user);
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    return { calls, fetcher };
  }

  it('sends people to Discord with a state, and brings them back as themselves', async () => {
    const discord = fakeDiscord();
    const { auth } = await setup({ fetch: discord.fetcher });
    const started = auth.oauthStart('/stats');
    const location = new URL(started.location);
    assert.equal(location.origin + location.pathname, 'https://discord.test/oauth2/authorize');
    assert.equal(location.searchParams.get('scope'), 'identify');
    assert.equal(location.searchParams.get('redirect_uri'), 'http://localhost:8795/auth/callback');
    const state = location.searchParams.get('state') ?? '';
    const back = await auth.oauthFinish('the-code', state, started.cookie.split(';')[0]);
    assert.deepEqual(back, { person: { id: ALICE, name: 'Alice', avatar: 'abc' }, next: '/stats' });
    // The code was traded with the secret, and the access token was revoked afterwards.
    assert.match(discord.calls[0]?.body ?? '', /code=the-code/);
    assert.match(discord.calls[0]?.body ?? '', /client_secret=oauth-secret/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(discord.calls.some((call) => call.url.endsWith('/oauth2/token/revoke')));
  });

  it('refuses a state from another browser and never redirects off the site', async () => {
    const discord = fakeDiscord();
    const { auth } = await setup({ fetch: discord.fetcher });
    const started = auth.oauthStart('//evil.example/');
    const state = new URL(started.location).searchParams.get('state') ?? '';
    await assert.rejects(
      auth.oauthFinish('c', `${state.slice(0, -1)}x`, started.cookie.split(';')[0]),
      /did not start/,
    );
    await assert.rejects(auth.oauthFinish('c', state, undefined), /did not start/);
    assert.equal(discord.calls.length, 0);
    const back = await auth.oauthFinish('c', state, started.cookie.split(';')[0]);
    assert.equal(back.next, '/');
  });

  it('refuses a user without a proper ID', async () => {
    const discord = fakeDiscord({ id: 'not-a-snowflake', username: 'x' });
    const { auth } = await setup({ fetch: discord.fetcher });
    const started = auth.oauthStart('/');
    const state = new URL(started.location).searchParams.get('state') ?? '';
    await assert.rejects(auth.oauthFinish('c', state, started.cookie.split(';')[0]), /without an ID/);
  });
});

describe('addressKey and the limiter under a scan', () => {
  it('counts an IPv6 /56 as one address, IPv4 written as IPv6 as the IPv4 address, and no address as one', async () => {
    assert.equal(addressKey('2001:db8:1:2:3:4:5:6'), '2001:db8:1:0::/56');
    assert.equal(addressKey('2001:db8:1:2::9'), '2001:db8:1:0::/56');
    assert.equal(addressKey('2001:db8:1:1ff::9'), '2001:db8:1:100::/56');
    assert.equal(addressKey('2001:db8::1'), '2001:db8:0:0::/56');
    assert.equal(addressKey('::ffff:192.0.2.7'), '192.0.2.7');
    assert.equal(addressKey('192.0.2.7'), '192.0.2.7');
    assert.equal(addressKey(undefined), 'unknown');
    const limiter = new LoginLimiter(new MemoryCache());
    for (let i = 0; i < 20; i += 1)
      await limiter.fail([addressFailures(`2001:db8:1:${(i % 4).toString(16)}::${i.toString(16)}`)]);
    // Every /64 of that /56 is blocked; the next /56 is not.
    assert.equal(await limiter.blocked([addressFailures('2001:db8:1:ff:ffff::1')]), true);
    assert.equal(await limiter.blocked([addressFailures('2001:db8:1:100::1')]), false);
  });

  it('keeps at most what the cache holds, forgetting the addresses that failed longest ago', async () => {
    const limiter = new LoginLimiter(new MemoryCache({ capacity: 3 }), { limit: 2 });
    await limiter.fail([addressFailures('10.0.0.1')]);
    await limiter.fail([addressFailures('10.0.0.1')]);
    assert.equal(await limiter.blocked([addressFailures('10.0.0.1')]), true);
    for (const address of ['10.0.0.2', '10.0.0.3', '10.0.0.4']) await limiter.fail([addressFailures(address)]);
    // The first address was pushed out by three newer ones.
    assert.equal(await limiter.blocked([addressFailures('10.0.0.1')]), false);
  });

  it('keeps one counter for an address however often it fails', async () => {
    const cache = new MemoryCache();
    const limiter = new LoginLimiter(cache, { limit: 20 });
    for (let i = 0; i < 5000; i += 1) await limiter.fail([addressFailures('10.0.0.9')]);
    assert.equal(cache.size, 1);
    assert.equal(await limiter.blocked([addressFailures('10.0.0.9')]), true);
  });
});

describe('safeNext', () => {
  it('keeps paths on this site and turns everything else into /', () => {
    assert.equal(safeNext('/stats?days=7#top'), '/stats?days=7#top');
    for (const next of [
      '//evil.example',
      '/\t/evil.example',
      '/\\evil.example',
      'https://evil.example/',
      'stats',
      '',
      // Dot segments that rebuild into "//evil.example".
      '/.//evil.example',
      '/%2e%2e//evil.example',
      '/./\\evil.example',
    ]) {
      assert.equal(safeNext(next), '/', JSON.stringify(next));
    }
  });
});
