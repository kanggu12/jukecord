/**
 * The login's operations in the API and the CLI: what the login page shows (auth methods), and the tests of the
 * login settings, as they are or with values not saved yet, for the host only.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { InjectOptions } from 'fastify';
import { LoginChecks } from '../../src/auth/check.ts';
import { COMMANDS } from '../../src/cli/commands.ts';
import { createLogger } from '../../src/log.ts';
import { API_PREFIX } from '../../src/web/api.ts';
import { CSRF_HEADER, memberKey } from '../../src/web/auth.ts';
import { FakeDirectoryServer } from '../support/directory.ts';
import { CLIENT_ID, CLIENT_SECRET, FakeProvider, ISSUER } from '../support/oidc.ts';
import { asHost, type TestServer, testServer } from '../support/web.ts';

const api = (path: string) => `${API_PREFIX}${path}`;
const log = createLogger({ level: 'error', sinks: [] });

// The environment a jukecord with both ways of logging in starts with.
const ENV = {
  JUKECORD_OIDC_ISSUER: ISSUER,
  JUKECORD_OIDC_CLIENT_ID: CLIENT_ID,
  JUKECORD_OIDC_CLIENT_SECRET: CLIENT_SECRET,
  JUKECORD_OIDC_READ_GROUPS: '*',
  JUKECORD_OIDC_LABEL: 'Log in with Keycloak',
  JUKECORD_LDAP_URL: 'ldap://ldap.example.test',
  JUKECORD_LDAP_BIND_DN: 'cn=jukecord,ou=services,dc=example,dc=org',
  JUKECORD_LDAP_BIND_PASSWORD: 'service-secret',
  JUKECORD_LDAP_BASE_DN: 'dc=example,dc=org',
  JUKECORD_LDAP_CONTROL_GROUPS: 'djs',
};

describe('the login operations', () => {
  let server: TestServer;
  const provider = new FakeProvider();
  const directory = new FakeDirectoryServer();
  const inject = (options: InjectOptions) => server.web.app.inject(options);

  before(async () => {
    directory.people.push({
      dn: 'uid=alice,ou=people,dc=example,dc=org',
      password: 'alice-password',
      attributes: { uid: 'alice', cn: 'Alice', memberOf: ['cn=djs,ou=groups,dc=example,dc=org'] },
    });
    const checks = new LoginChecks({
      env: ENV,
      cwd: '/srv',
      redirectUri: 'http://localhost:8795/auth/sso/callback',
      afterLogout: 'http://localhost:8795/login',
      log,
      fetch: provider.fetch,
      connect: directory.connect,
    });
    const settings = checks.settingsWith().settings;
    if (!settings.oidc || !settings.ldap) throw new Error('the test settings do not read');
    server = await testServer({
      oidc: { settings: settings.oidc, fetch: provider.fetch },
      ldap: { settings: settings.ldap, connect: directory.connect },
      loginChecks: checks,
    });
  });
  after(() => server.close());

  it('tells anyone which ways of logging in are set up, with the words of their keys', async () => {
    const methods = await inject({ method: 'GET', url: api('/auth/methods') });
    assert.equal(methods.statusCode, 200);
    assert.deepEqual(methods.json(), {
      discord: false,
      sso: { label: 'Log in with Keycloak' },
      directory: { label: null },
    });
    const plain = await testServer();
    try {
      const none = await plain.web.app.inject({ method: 'GET', url: api('/auth/methods') });
      assert.deepEqual(none.json(), { discord: false, sso: null, directory: null });
    } finally {
      await plain.close();
    }
  });

  it('tests the identity provider as set up, and with a value not saved yet', async () => {
    const test = await inject({ method: 'POST', url: api('/auth/test-oidc'), headers: asHost, payload: {} });
    assert.equal(test.statusCode, 200);
    assert.equal(test.json().ok, true);
    const wrong = await inject({
      method: 'POST',
      url: api('/auth/test-oidc'),
      headers: asHost,
      payload: { settings: { JUKECORD_OIDC_CLIENT_SECRET: 'not-the-secret' } },
    });
    assert.equal(wrong.json().ok, false);
    assert.equal(
      (wrong.json().checks as { name: string; status: string }[]).find((check) => check.name === 'client')?.status,
      'fail',
    );
    // A secret never comes back, whether in use or brought.
    assert.ok(!wrong.body.includes('not-the-secret') && !wrong.body.includes(CLIENT_SECRET));
    // Settings that do not read are said as the start would say them; a name that is no login setting is refused.
    const broken = await inject({
      method: 'POST',
      url: api('/auth/test-oidc'),
      headers: asHost,
      payload: { settings: { JUKECORD_OIDC_ISSUER: 'not a url', JUKECORD_OIDC_CLIENT_SECRET_FILE: '/etc/passwd' } },
    });
    const details = (broken.json().checks as { detail: string }[]).map((check) => check.detail);
    assert.ok(details.includes('JUKECORD_OIDC_CLIENT_SECRET_FILE is not a login setting a test can take'));
    assert.ok(details.some((detail) => detail.startsWith('JUKECORD_OIDC_ISSUER: "not a url"')));
    // A misspelt login setting is said, and so is a setting of anything else.
    const misspelt = await inject({
      method: 'POST',
      url: api('/auth/test-oidc'),
      headers: asHost,
      payload: { settings: { JUKECORD_OIDC_ISUER: ISSUER } },
    });
    assert.deepEqual(misspelt.json().checks, [
      { name: 'settings', status: 'fail', detail: 'JUKECORD_OIDC_ISUER is not a login setting a test can take' },
    ]);
    const other = await inject({
      method: 'POST',
      url: api('/auth/test-oidc'),
      headers: asHost,
      payload: { settings: { JUKECORD_PORT: '1' } },
    });
    assert.deepEqual(other.json().checks, [
      { name: 'settings', status: 'fail', detail: 'JUKECORD_PORT is not a login setting a test can take' },
    ]);
  });

  it('tests the directory and looks a name up, with the level it would log in at, and no password', async () => {
    const test = await inject({
      method: 'POST',
      url: api('/auth/test-ldap'),
      headers: asHost,
      payload: { username: 'alice' },
    });
    assert.equal(test.statusCode, 200);
    assert.deepEqual(
      { ok: test.json().ok, groups: test.json().groups, level: test.json().level },
      { ok: true, groups: ['cn=djs,ou=groups,dc=example,dc=org'], level: 'control' },
    );
    assert.ok(!directory.log.includes('bind uid=alice,ou=people,dc=example,dc=org'));
    const nobody = await inject({
      method: 'POST',
      url: api('/auth/test-ldap'),
      headers: asHost,
      payload: { username: 'zed' },
    });
    assert.equal(nobody.json().ok, false);
  });

  it('keeps the tests to the host and to admin members', async () => {
    assert.equal((await inject({ method: 'POST', url: api('/auth/test-ldap'), payload: {} })).statusCode, 401);
    const memberId = memberKey('ldap', 'entryUUID:x');
    for (const level of ['control', 'admin'] as const) {
      const cookie = (await server.auth.startSession({ kind: 'member', memberId, provider: 'ldap', level })).split(
        ';',
      )[0];
      const caller = await server.auth.identify({ cookie });
      const answer = await inject({
        method: 'POST',
        url: api('/auth/test-ldap'),
        headers: { cookie: cookie ?? '', [CSRF_HEADER]: caller?.csrf ?? '' },
        payload: {},
      });
      assert.equal(answer.statusCode, level === 'admin' ? 200 : 403, level);
    }
  });

  it('has CLI commands for each, the name of test-ldap from its words', async () => {
    assert.equal(COMMANDS['auth-methods'].name, 'auth methods');
    assert.equal(COMMANDS['auth-test-oidc'].name, 'auth test-oidc');
    const ldap = COMMANDS['auth-test-ldap'];
    const lookups = {} as Parameters<typeof ldap.request>[1];
    assert.deepEqual(await ldap.request({ args: ['alice'], flags: new Map() }, lookups), {
      body: { username: 'alice' },
    });
    assert.deepEqual(await ldap.request({ args: [], flags: new Map() }, lookups), { body: {} });
    assert.equal(
      ldap.show({ checks: [{ name: 'person', status: 'fail', detail: 'no one is found by zed' }] }),
      'FAIL  person: no one is found by zed',
    );
    assert.equal(
      COMMANDS['auth-methods'].show({ discord: true, sso: { label: null }, directory: null }),
      'Discord: on\nSSO (OIDC): on\nDirectory (LDAP): off',
    );
  });
});
