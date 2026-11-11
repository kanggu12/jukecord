import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createLogger } from '../../src/log.ts';
import {
  Auth,
  addressKey,
  cookie,
  ensureHostToken,
  FailureLimiter,
  hashSecret,
  parseCookies,
  SESSION_COOKIE,
  safeNext,
} from '../../src/web/auth.ts';
import { memoryStore } from '../support/store.ts';
import { ALICE, HOST_TOKEN } from '../support/web.ts';

const log = createLogger({ level: 'error', sinks: [] });

function setup(options: { fetch?: typeof fetch; now?: () => number } = {}) {
  let now = Date.UTC(2026, 10, 11);
  const clock = options.now ?? (() => now);
  const store = memoryStore(clock);
  const auth = new Auth({
    store,
    hostToken: HOST_TOKEN,
    secureCookies: false,
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
  return { store, auth, advance: (ms: number) => (now += ms) };
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
      assert.equal(fs.statSync(path.join(dir, 'host-token')).mode & 0o777, 0o600);
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
  it('knows the host token, stores other tokens as hashes, and narrows what each may do', () => {
    const { store, auth } = setup();
    const host = auth.identify({ authorization: `Bearer ${HOST_TOKEN}` });
    assert.deepEqual([host?.principal.kind, host?.scope, host?.via], ['host', 'admin', 'token']);
    assert.ok(host);
    const made = auth.createToken(host, 'script', 'read');
    // Only the hash is in the database.
    const row = store.db.prepare('SELECT hash FROM api_tokens').get() as { hash: string };
    assert.equal(row.hash, hashSecret(made.token));
    assert.ok(!JSON.stringify(store.db.prepare('SELECT * FROM api_tokens').all()).includes(made.token));
    const reader = auth.identify({ authorization: `Bearer ${made.token}` });
    assert.equal(reader?.scope, 'read');
    // A read token cannot make a wider one.
    assert.ok(reader);
    assert.throws(() => auth.createToken(reader, 'wider', 'admin'), /cannot make/);
    assert.equal(auth.identify({ authorization: 'Bearer jkc_not-a-real-token' }), null);
    assert.equal(auth.identify({ authorization: 'Basic abc' }), null);
  });

  it("lets a user list and revoke only their own tokens, and the host anyone's", () => {
    const { auth } = setup();
    const host = auth.identify({ authorization: `Bearer ${HOST_TOKEN}` });
    assert.ok(host);
    const alice = { ...host, principal: { kind: 'user' as const, userId: ALICE } };
    const hosts = auth.createToken(host, 'host script', 'admin');
    const alices = auth.createToken(alice, 'my phone', 'control');
    assert.deepEqual(
      auth.listTokens(alice).map((token) => token.name),
      ['my phone'],
    );
    assert.equal(auth.listTokens(host).length, 2);
    assert.equal(auth.revokeToken(alice, hosts.info.id), false);
    assert.equal(auth.revokeToken(alice, alices.info.id), true);
    assert.equal(auth.identify({ authorization: `Bearer ${alices.token}` }), null);
    assert.equal(auth.revokeToken(host, hosts.info.id), true);
  });
});

describe('Auth sessions', () => {
  it('logs a browser in with a cookie, needs the CSRF token for changes, and ends on logout or after 30 days', () => {
    const { auth, advance } = setup();
    const set = auth.startSession({ kind: 'user', userId: ALICE });
    assert.match(
      set,
      new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000$`),
    );
    const header = set.split(';')[0];
    const caller = auth.identify({ cookie: `other=1; ${header}` });
    assert.equal(caller?.via, 'session');
    assert.ok(caller?.csrf);
    assert.equal(auth.csrfOk(caller, caller.csrf), true);
    assert.equal(auth.csrfOk(caller, undefined), false);
    assert.equal(auth.csrfOk(caller, `${caller.csrf}x`), false);
    // A bearer token wins over a cookie in the same request.
    assert.equal(auth.identify({ cookie: header, authorization: `Bearer ${HOST_TOKEN}` })?.via, 'token');
    advance(30 * 86_400_000);
    assert.equal(auth.identify({ cookie: header }), null);
    const again = auth.startSession({ kind: 'host' }).split(';')[0];
    const host = auth.identify({ cookie: again });
    assert.equal(host?.principal.kind, 'host');
    assert.match(auth.endSession(host), /Max-Age=0/);
    assert.equal(auth.identify({ cookie: again }), null);
  });

  it('turns a login link into one login within ten minutes', () => {
    const { auth, advance } = setup();
    const first = auth.createLink();
    assert.equal(auth.useLink(first.code), true);
    assert.equal(auth.useLink(first.code), false);
    const second = auth.createLink();
    advance(10 * 60_000);
    assert.equal(auth.useLink(second.code), false);
  });
});

describe('FailureLimiter', () => {
  it('blocks an address after 20 failures in 10 minutes and lets it in again after', () => {
    let now = 0;
    const limiter = new FailureLimiter({ now: () => now });
    for (let i = 0; i < 19; i += 1) limiter.fail('10.0.0.1');
    assert.equal(limiter.blocked('10.0.0.1'), false);
    limiter.fail('10.0.0.1');
    assert.equal(limiter.blocked('10.0.0.1'), true);
    assert.equal(limiter.blocked('10.0.0.2'), false);
    now += 10 * 60_000 + 1;
    assert.equal(limiter.blocked('10.0.0.1'), false);
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
    const { auth } = setup({ fetch: discord.fetcher });
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
    const { auth } = setup({ fetch: discord.fetcher });
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
    const { auth } = setup({ fetch: discord.fetcher });
    const started = auth.oauthStart('/');
    const state = new URL(started.location).searchParams.get('state') ?? '';
    await assert.rejects(auth.oauthFinish('c', state, started.cookie.split(';')[0]), /without an ID/);
  });
});

describe('addressKey and the limiter under a scan', () => {
  it('counts an IPv6 /56 as one address, IPv4 written as IPv6 as the IPv4 address, and no address as one', () => {
    assert.equal(addressKey('2001:db8:1:2:3:4:5:6'), '2001:db8:1:0::/56');
    assert.equal(addressKey('2001:db8:1:2::9'), '2001:db8:1:0::/56');
    assert.equal(addressKey('2001:db8:1:1ff::9'), '2001:db8:1:100::/56');
    assert.equal(addressKey('2001:db8::1'), '2001:db8:0:0::/56');
    assert.equal(addressKey('::ffff:192.0.2.7'), '192.0.2.7');
    assert.equal(addressKey('192.0.2.7'), '192.0.2.7');
    assert.equal(addressKey(undefined), 'unknown');
    const limiter = new FailureLimiter();
    for (let i = 0; i < 20; i += 1) limiter.fail(`2001:db8:1:${(i % 4).toString(16)}::${i.toString(16)}`);
    // Every /64 of that /56 is blocked; the next /56 is not.
    assert.equal(limiter.blocked('2001:db8:1:ff:ffff::1'), true);
    assert.equal(limiter.blocked('2001:db8:1:100::1'), false);
  });

  it('keeps at most its capacity, forgetting the addresses that failed longest ago', () => {
    const limiter = new FailureLimiter({ capacity: 3, limit: 2 });
    limiter.fail('10.0.0.1');
    limiter.fail('10.0.0.1');
    assert.equal(limiter.blocked('10.0.0.1'), true);
    for (const address of ['10.0.0.2', '10.0.0.3', '10.0.0.4']) limiter.fail(address);
    // The first address was pushed out by three newer ones.
    assert.equal(limiter.blocked('10.0.0.1'), false);
  });

  it('keeps no more failures for one address than it takes to block it', () => {
    const limiter = new FailureLimiter({ limit: 20 });
    for (let i = 0; i < 5000; i += 1) limiter.fail('10.0.0.9');
    const kept = (limiter as unknown as { failures: Map<string, number[]> }).failures.get('10.0.0.9');
    assert.equal(kept?.length, 20);
    assert.equal(limiter.blocked('10.0.0.9'), true);
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
