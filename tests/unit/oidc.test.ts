/**
 * Logging in through an OpenID Connect provider, against a made-up one (tests/support/oidc.ts): the code flow with
 * PKCE, the state tied to its browser, the ID token's signature and claims checked, the groups read where the
 * settings say, the level they give, and the server's routes around it.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { InjectOptions } from 'fastify';
import { claimAt, claimValues, levelOf, sameLdapGroup, sameOidcGroup } from '../../src/auth/levels.ts';
import { OidcError, OidcLogin, SSO_COOKIE } from '../../src/auth/oidc.ts';
import type { OidcSettings } from '../../src/auth/settings.ts';
import { MemoryCache } from '../../src/cache/memory.ts';
import { createLogger } from '../../src/log.ts';
import { API_PREFIX } from '../../src/web/api.ts';
import { CSRF_HEADER, memberKey, SESSION_COOKIE } from '../../src/web/auth.ts';
import { CLIENT_ID, CLIENT_SECRET, FakeProvider, ISSUER, type ProviderPerson } from '../support/oidc.ts';
import { ALICE, GUILD, type TestServer, testServer } from '../support/web.ts';

const log = createLogger({ level: 'error', sinks: [] });
const REDIRECT = 'http://localhost:8795/auth/sso/callback';

const SETTINGS: OidcSettings = {
  issuer: ISSUER,
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  scopes: ['openid', 'profile', 'groups'],
  groupsClaim: 'groups',
  groups: { admin: ['jukecord-admins'], control: ['djs'], read: ['listeners'] },
  label: null,
  discordClaim: null,
};

function login(provider: FakeProvider, settings: Partial<OidcSettings> = {}, cache = new MemoryCache()) {
  return new OidcLogin({
    settings: { ...SETTINGS, ...settings },
    redirectUri: REDIRECT,
    afterLogout: 'http://localhost:8795/login',
    cache,
    log,
    fetch: provider.fetch,
  });
}

const MINA = { sub: 'f2a1-mina', idClaims: { name: 'Mina', groups: ['/djs', 'other'] } };

// What a browser does: start, visit the provider (which logs the person in and sends it back), finish.
async function through(oidc: OidcLogin, provider: FakeProvider, person: ProviderPerson = MINA, next = '/stats') {
  const started = await oidc.start(next);
  const back = provider.authorize(started.location, person);
  return oidc.finish(back, started.cookie.value);
}

// The code of an OidcError, or what else went wrong.
async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'none';
  } catch (error) {
    return error instanceof OidcError ? error.code : String(error);
  }
}

describe('claims and groups', () => {
  it('reads a claim by its dotted path, with dots inside a name taken whole', () => {
    const claims = {
      groups: ['a'],
      realm_access: { roles: ['dj', 'offline_access'] },
      resource_access: { 'jukecord.web': { roles: ['admin'] } },
      'https://example.com/roles': ['owner'],
      hd: 'example.com',
    };
    assert.deepEqual(claimAt(claims, 'realm_access.roles'), ['dj', 'offline_access']);
    assert.deepEqual(claimAt(claims, 'resource_access.jukecord.web.roles'), ['admin']);
    assert.deepEqual(claimAt(claims, 'https://example.com/roles'), ['owner']);
    assert.equal(claimAt(claims, 'realm_access.missing'), undefined);
    assert.equal(claimAt(claims, 'groups.0'), undefined);
    assert.deepEqual(claimValues(claimAt(claims, 'hd')), ['example.com']);
    assert.deepEqual(claimValues(['x', 3, true, { no: 1 }]), ['x', '3', 'true']);
    assert.deepEqual(claimValues({ no: 1 }), []);
  });

  it('gives the widest level the groups reach, comparing names as each provider writes them', () => {
    const groups = { admin: ['Admins'], control: ['/jukecord/djs'], read: ['*'] };
    assert.equal(levelOf(['admins'], groups, sameOidcGroup), 'admin');
    // Keycloak's full path and a plain name are one group; a leading slash makes no difference.
    assert.equal(levelOf(['jukecord/djs'], groups, sameOidcGroup), 'control');
    // A star gives its level to anyone the provider lets in, with no groups at all.
    assert.equal(levelOf([], groups, sameOidcGroup), 'read');
    assert.equal(levelOf(['x'], { admin: [], control: [], read: ['y'] }, sameOidcGroup), null);
    // A directory's groups: by DN (spaces and case aside) or by the group's own name.
    const ldap = { admin: ['CN=Domain Admins, CN=Users, DC=corp, DC=example'], control: ['djs'], read: [] };
    assert.equal(levelOf(['cn=domain admins,cn=users,dc=corp,dc=example'], ldap, sameLdapGroup), 'admin');
    assert.equal(levelOf(['cn=DJs,ou=groups,dc=example,dc=org'], ldap, sameLdapGroup), 'control');
    assert.equal(levelOf(['cn=djs-old,ou=groups,dc=example,dc=org'], ldap, sameLdapGroup), null);
    // An escaped comma is part of the name, not a step of the DN.
    assert.equal(sameLdapGroup('Night\\, Late', 'cn=Night\\, Late,ou=groups,dc=x'), false);
    assert.equal(sameLdapGroup('Night, Late', 'cn=Night\\, Late,ou=groups,dc=x'), true);
  });
});

describe('OidcLogin', () => {
  it('sends the browser with the code flow, PKCE, a state and a nonce, and brings back who logged in', async () => {
    const provider = new FakeProvider();
    const cache = new MemoryCache();
    const oidc = login(provider, {}, cache);
    const started = await oidc.start('/stats');
    const location = new URL(started.location);
    assert.equal(`${location.origin}${location.pathname}`, `${ISSUER}/protocol/openid-connect/auth`);
    assert.equal(location.searchParams.get('response_type'), 'code');
    assert.equal(location.searchParams.get('client_id'), CLIENT_ID);
    assert.equal(location.searchParams.get('redirect_uri'), REDIRECT);
    assert.equal(location.searchParams.get('scope'), 'openid profile groups');
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
    const state = location.searchParams.get('state') ?? '';
    assert.ok(state.length >= 32 && (location.searchParams.get('nonce') ?? '').length >= 32);
    assert.equal(started.cookie.name, SSO_COOKIE);
    // The cache holds the state's hash, not the state.
    assert.equal(await cache.get(`auth:oidc:${state}`), null);
    const back = provider.authorize(started.location, MINA);
    const done = await oidc.finish(back, started.cookie.value);
    assert.deepEqual(done, {
      identity: { subject: 'f2a1-mina', name: 'Mina', groups: ['/djs', 'other'], discordId: null },
      next: '/stats',
    });
    // The secret went as HTTP Basic, and the verifier was the one behind the challenge.
    const token = provider.tokenRequests[0];
    assert.match(token?.authorization ?? '', /^Basic /);
    assert.equal(token?.body.get('client_secret'), null);
    const verifier = token?.body.get('code_verifier') ?? '';
    assert.equal(
      createHash('sha256').update(verifier).digest('base64url'),
      location.searchParams.get('code_challenge'),
    );
  });

  it('refuses an ID token signed by another key, for another client, from another issuer, expired or with another nonce', async () => {
    for (const bent of [
      { otherKey: true },
      { audience: 'someone-else' },
      { issuer: 'https://evil.example.test' },
      { expired: true },
      { nonce: 'not-the-one' },
    ]) {
      const provider = new FakeProvider();
      provider.bent = bent;
      assert.equal(await refusal(through(login(provider), provider)), 'failed', JSON.stringify(bent));
    }
  });

  it('ties the login to its browser, for ten minutes and once', async () => {
    const provider = new FakeProvider();
    let now = 0;
    const cache = new MemoryCache({ now: () => now });
    const oidc = login(provider, {}, cache);
    // No cookie, or another browser's: not this browser's login.
    const first = await oidc.start('/');
    assert.equal(await refusal(oidc.finish(provider.authorize(first.location, MINA), undefined)), 'expired');
    const second = await oidc.start('/');
    assert.equal(await refusal(oidc.finish(provider.authorize(second.location, MINA), first.cookie.value)), 'expired');
    // Once: the same way back a second time finds nothing.
    const third = await oidc.start('/');
    const back = provider.authorize(third.location, MINA);
    await oidc.finish(back, third.cookie.value);
    assert.equal(await refusal(oidc.finish(back, third.cookie.value)), 'expired');
    // Ten minutes at most.
    const late = await oidc.start('/');
    now += 10 * 60_000;
    assert.equal(await refusal(oidc.finish(provider.authorize(late.location, MINA), late.cookie.value)), 'expired');
    // The provider sending the person back without a login (they turned back there).
    const cancelled = await oidc.start('/');
    assert.equal(
      await refusal(
        oidc.finish(provider.authorize(cancelled.location, { error: 'access_denied' }), cancelled.cookie.value),
      ),
      'cancelled',
    );
  });

  it("asks the provider's userinfo for the groups when the ID token does not carry them, and reads a dotted path", async () => {
    const provider = new FakeProvider();
    const oidc = login(provider, { groupsClaim: 'realm_access.roles', discordClaim: 'discord_id' });
    const person = {
      sub: 'u-7',
      idClaims: { preferred_username: 'joon' },
      userinfo: { realm_access: { roles: ['dj'] }, discord_id: ALICE },
    };
    const { identity } = await through(oidc, provider, person);
    assert.deepEqual(identity, { subject: 'u-7', name: 'joon', groups: ['dj'], discordId: ALICE });
    assert.ok(provider.requests.includes('GET /realms/home/protocol/openid-connect/userinfo'));
    // A Discord ID as a JSON number has lost its last digits: not taken.
    const numeric = { ...person, userinfo: { ...person.userinfo, discord_id: Number(ALICE) } };
    assert.equal((await through(oidc, provider, numeric)).identity.discordId, null);
  });

  it('takes a provider on plain http when the host wrote http://', async () => {
    const plain = new FakeProvider('http://sso.example.test/realms/home');
    const { identity } = await through(login(plain, { issuer: plain.issuer }), plain);
    assert.equal(identity.subject, 'f2a1-mina');
  });

  it('says the provider is unavailable when its document cannot be read, and asks again at the next login', async () => {
    const provider = new FakeProvider();
    provider.bent = { down: true };
    const oidc = login(provider);
    assert.equal(await refusal(oidc.start('/')), 'unavailable');
    provider.bent = {};
    const started = await oidc.start('/');
    assert.ok(started.location.startsWith(ISSUER));
  });

  it('sends the secret in the form to a provider that takes only that, and none for a public client', async () => {
    const post = new FakeProvider();
    post.bent = { postOnly: true };
    await through(login(post), post);
    assert.equal(post.tokenRequests[0]?.authorization, null);
    assert.equal(post.tokenRequests[0]?.body.get('client_secret'), CLIENT_SECRET);
    const open = new FakeProvider();
    // A public client is refused by this provider (it wants the secret), but sends no secret at all.
    await refusal(through(login(open, { clientSecret: null }), open));
    assert.equal(open.tokenRequests[0]?.authorization, null);
    assert.equal(open.tokenRequests[0]?.body.get('client_secret'), null);
    assert.equal(open.tokenRequests[0]?.body.get('client_id'), CLIENT_ID);
  });

  it('logs out at the provider when it offers that, back to the login page', async () => {
    const provider = new FakeProvider();
    const url = new URL((await login(provider).logoutUrl()) ?? '');
    assert.equal(`${url.origin}${url.pathname}`, `${ISSUER}/protocol/openid-connect/logout`);
    assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
    assert.equal(url.searchParams.get('post_logout_redirect_uri'), 'http://localhost:8795/login');
    const without = new FakeProvider();
    without.bent = { noLogout: true };
    assert.equal(await login(without).logoutUrl(), null);
  });

  it('tests the settings: the document, the keys, the client and its secret, without logging anyone in', async () => {
    const provider = new FakeProvider();
    const checks = await login(provider).test();
    assert.deepEqual(
      checks.map((check) => [check.name, check.status]),
      [
        ['discovery', 'ok'],
        ['signing keys', 'ok'],
        ['client', 'ok'],
        ['redirect', 'ok'],
        ['PKCE', 'ok'],
        ['logout', 'ok'],
      ],
    );
    const wrong = await login(provider, { clientSecret: 'not-it' }).test();
    assert.equal(wrong.find((check) => check.name === 'client')?.status, 'fail');
    provider.bent = { down: true };
    assert.deepEqual(
      (await login(provider).test()).map((check) => [check.name, check.status]),
      [['discovery', 'fail']],
    );
    // No test logged anyone in, and no secret is in what it says.
    assert.ok(!JSON.stringify(checks).includes(CLIENT_SECRET));
  });
});

describe('logging in through SSO with the server', () => {
  let server: TestServer;
  const provider = new FakeProvider();
  const inject = (options: InjectOptions) => server.web.app.inject(options);

  before(async () => {
    server = await testServer({
      oidc: { settings: { ...SETTINGS, discordClaim: 'discord_id' }, fetch: provider.fetch },
    });
  });
  after(() => server.close());

  // The browser's whole way: /auth/sso, the provider, the callback; returns the callback's answer.
  async function sso(person: Parameters<FakeProvider['authorize']>[1], address = '10.1.0.1') {
    const start = await inject({ method: 'GET', url: '/auth/sso?next=/stats', remoteAddress: address });
    assert.equal(start.statusCode, 302);
    const tie = String(start.headers['set-cookie']).split(';')[0] ?? '';
    assert.match(tie, new RegExp(`^${SSO_COOKIE}=`));
    assert.match(String(start.headers['set-cookie']), /HttpOnly; SameSite=Lax/);
    const back = provider.authorize(String(start.headers.location), person);
    return inject({
      method: 'GET',
      url: `/auth/sso/callback?${back}`,
      headers: { cookie: tie },
      remoteAddress: address,
    });
  }

  it('lets a member in at the level of their groups, by their name, and logs them out at the provider', async () => {
    const back = await sso(MINA);
    assert.equal(back.statusCode, 302);
    assert.equal(back.headers.location, '/stats');
    const session = [back.headers['set-cookie']].flat().find((value) => String(value).startsWith(SESSION_COOKIE));
    const cookie = String(session).split(';')[0] ?? '';
    const me = await inject({ method: 'GET', url: `${API_PREFIX}/me`, headers: { cookie } });
    assert.equal(me.json().kind, 'member');
    assert.equal(me.json().id, memberKey('oidc', 'f2a1-mina'));
    assert.equal(me.json().name, 'Mina');
    assert.deepEqual(me.json().member, { provider: 'oidc', level: 'control' });
    const out = await inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie, [CSRF_HEADER]: me.json().csrf },
    });
    assert.equal(out.statusCode, 200);
    assert.match(out.json().next, /\/protocol\/openid-connect\/logout\?/);
    assert.equal((await inject({ method: 'GET', url: `${API_PREFIX}/me`, headers: { cookie } })).statusCode, 401);
  });

  it('refuses someone in none of the groups, with the reason, and counts it', async () => {
    const back = await sso({ sub: 'x-1', idClaims: { name: 'Stranger', groups: ['visitors'] } });
    assert.equal(back.headers.location, '/login?error=no-group');
    assert.ok(![back.headers['set-cookie']].flat().some((value) => String(value).startsWith(`${SESSION_COOKIE}=`)));
  });

  it('logs in as the Discord user the provider names, with their level on top', async () => {
    const back = await sso({ sub: 'u-alice', idClaims: { name: 'Alice', groups: ['listeners'], discord_id: ALICE } });
    const session = [back.headers['set-cookie']].flat().find((value) => String(value).startsWith(SESSION_COOKIE));
    const cookie = String(session).split(';')[0] ?? '';
    const me = await inject({ method: 'GET', url: `${API_PREFIX}/me`, headers: { cookie } });
    assert.equal(me.json().kind, 'user');
    assert.equal(me.json().id, ALICE);
    assert.deepEqual(me.json().member, { provider: 'oidc', level: 'read' });
    // Not in any Discord server here, yet the read level opens every server to look.
    const guilds = await inject({ method: 'GET', url: `${API_PREFIX}/guilds`, headers: { cookie } });
    assert.ok((guilds.json() as { id: string; mayControl: boolean }[]).some((guild) => guild.id === GUILD));
  });

  it('sends the browser back with the reason when the state is not its own, and blocks an address that keeps trying', async () => {
    const start = await inject({ method: 'GET', url: '/auth/sso', remoteAddress: '10.1.0.9' });
    const back = provider.authorize(String(start.headers.location), MINA);
    // No cookie: another browser's state.
    const forged = await inject({ method: 'GET', url: `/auth/sso/callback?${back}`, remoteAddress: '10.1.0.9' });
    assert.equal(forged.headers.location, '/login?error=sso-expired');
    for (let i = 0; i < 20; i += 1)
      await inject({ method: 'GET', url: '/auth/sso/callback?state=x&code=y', remoteAddress: '10.1.0.9' });
    const blocked = await inject({
      method: 'GET',
      url: '/auth/sso/callback?state=x&code=y',
      remoteAddress: '10.1.0.9',
    });
    assert.equal(blocked.headers.location, '/login?error=too-many');
    // A person who turned back at the provider is told so, and not counted as a failure.
    const cancelled = await sso({ error: 'access_denied' }, '10.1.0.10');
    assert.equal(cancelled.headers.location, '/login?error=sso-cancelled');
  });
});
