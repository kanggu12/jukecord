/**
 * Logging in with accounts of a real OpenLDAP (tests/auth/run.sh starts one and loads tests/auth/openldap.ldif):
 * through jukecord's form as the login page sends it, over plain LDAP, StartTLS and LDAPS with the test's own CA,
 * groups from memberOf and from a group search, names made of filter syntax, the limiter, and the settings test.
 * Skipped unless JUKECORD_E2E_LDAP names the directory (ldap://localhost:1389).
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { LdapError, LdapLogin } from '../../src/auth/ldap.ts';
import { readAuthSettings } from '../../src/auth/settings.ts';
import { diskFiles } from '../../src/config.ts';
import { createLogger } from '../../src/log.ts';
import { type RunningJukecord, startJukecord } from './jukecord.ts';

const LDAP = process.env.JUKECORD_E2E_LDAP ?? '';
const LDAPS = process.env.JUKECORD_E2E_LDAPS ?? '';
const CA = process.env.JUKECORD_E2E_LDAP_CA ?? '';
const skip = LDAP === '' ? 'JUKECORD_E2E_LDAP is not set (tests/auth/run.sh sets it)' : false;
const log = createLogger({ level: 'error', sinks: [] });

// The directory as jukecord is told of it, with the levels by group name and by DN.
const DIRECTORY = {
  JUKECORD_LDAP_URL: LDAP,
  JUKECORD_LDAP_BIND_DN: 'cn=jukecord,ou=services,dc=example,dc=org',
  JUKECORD_LDAP_BIND_PASSWORD: 'jukecord-e2e-service-password',
  JUKECORD_LDAP_BASE_DN: 'ou=people,dc=example,dc=org',
  JUKECORD_LDAP_ADMIN_GROUPS: 'jukecord-admins',
  JUKECORD_LDAP_CONTROL_GROUPS: 'cn=jukecord-djs,ou=groups,dc=example,dc=org',
  JUKECORD_LDAP_READ_GROUPS: 'jukecord-listeners',
};

// A directory login of jukecord's own, with some settings changed.
function login(settings: Record<string, string> = {}): LdapLogin {
  const read = readAuthSettings({ ...DIRECTORY, ...settings }, '/', diskFiles);
  assert.deepEqual(read.problems, []);
  if (!read.settings.ldap) throw new Error('no directory in the settings');
  return new LdapLogin({ settings: read.settings.ldap, log });
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'none';
  } catch (error) {
    return error instanceof LdapError ? error.code : String(error);
  }
}

describe('logging in with an OpenLDAP account', { skip }, () => {
  let jukecord: RunningJukecord;

  // The login page's form, sent as the panel sends it: JSON, from the panel's own origin.
  const form = (username: string, password: string) =>
    fetch(`${jukecord.url}/auth/directory`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: jukecord.url },
      body: JSON.stringify({ username, password, next: '/' }),
    });

  before(async () => {
    jukecord = await startJukecord(18903, DIRECTORY);
  });
  after(async () => {
    await jukecord?.stop();
  });

  it('lets each group in at its level through the form, by the name the directory gives', async () => {
    for (const [name, password, level, shown] of [
      ['ada', 'ada-e2e-password', 'admin', 'Ada'],
      ['dan', 'dan-e2e-password', 'control', 'Dan Deejay'],
      ['lee', 'lee-e2e-password', 'read', 'Lee'],
    ] as const) {
      const answer = await form(name, password);
      assert.equal(answer.status, 200, name);
      const cookie = String(answer.headers.get('set-cookie')).split(';')[0] ?? '';
      assert.match(String(answer.headers.get('set-cookie')), /HttpOnly; SameSite=Lax/);
      const me = (await (await fetch(`${jukecord.url}/api/v1/me`, { headers: { cookie } })).json()) as {
        name: string;
        member: unknown;
      };
      assert.equal(me.name, shown);
      assert.deepEqual(me.member, { provider: 'ldap', level });
    }
  });

  it('refuses in words: a wrong password, no group of jukecord, an empty password', async () => {
    const wrong = await form('lee', 'not-it');
    assert.equal(wrong.status, 401);
    assert.equal(((await wrong.json()) as { error: { code: string } }).error.code, 'wrong-password');
    const stranger = await form('sam', 'sam-e2e-password');
    assert.equal(stranger.status, 403);
    assert.equal(((await stranger.json()) as { error: { code: string } }).error.code, 'no-group');
    // Nia is in a group inside a group of jukecord's: memberOf names only the one she is in directly.
    assert.equal((await form('nia', 'nia-e2e-password')).status, 403);
    assert.equal((await form('lee', '')).status, 400);
  });

  it('takes a name made of filter syntax as a name: it finds that one person, and no one with a star', async () => {
    assert.equal((await form('sta*r', 'star-e2e-password')).status, 200);
    assert.equal((await form('sta*', 'star-e2e-password')).status, 401);
    assert.equal((await form('*', 'star-e2e-password')).status, 401);
    assert.equal((await form('*)(uid=*', 'star-e2e-password')).status, 401);
  });

  it('holds a name back after twenty wrong passwords, whatever the case it is typed in', async () => {
    for (let i = 0; i < 20; i += 1) await form(i % 2 === 0 ? 'dan' : 'DAN', `guess-${i}`);
    const blocked = await form('Dan', 'dan-e2e-password');
    assert.equal(blocked.status, 429);
  });

  it('tests the settings and a name, with the level it would log in at', async () => {
    const answer = await fetch(`${jukecord.url}/api/v1/auth/test-ldap`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jukecord.hostToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'lee' }),
    });
    const test = (await answer.json()) as { ok: boolean; groups: string[]; level: string };
    assert.equal(test.ok, true, JSON.stringify(test));
    assert.deepEqual(test.groups, ['cn=jukecord-listeners,ou=groups,dc=example,dc=org']);
    assert.equal(test.level, 'read');
    const wrong = await fetch(`${jukecord.url}/api/v1/auth/test-ldap`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jukecord.hostToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { JUKECORD_LDAP_BIND_PASSWORD: 'not-it' } }),
    });
    const refused = (await wrong.json()) as { ok: boolean; checks: { name: string; status: string }[] };
    assert.equal(refused.ok, false);
    assert.equal(refused.checks.find((check) => check.name === 'service account')?.status, 'fail');
  });
});

describe('an OpenLDAP account over TLS, and its groups by a search', { skip }, () => {
  it('logs in over StartTLS and over LDAPS with the CA file, and refuses a certificate it was not told to trust', async () => {
    const started = await login({ JUKECORD_LDAP_STARTTLS: 'yes', JUKECORD_LDAP_CA_FILE: CA }).login(
      'dan',
      'dan-e2e-password',
    );
    assert.equal(started.name, 'Dan Deejay');
    const secure = await login({ JUKECORD_LDAP_URL: LDAPS, JUKECORD_LDAP_CA_FILE: CA }).login(
      'dan',
      'dan-e2e-password',
    );
    assert.match(secure.subject, /^entryUUID:[0-9a-f-]{36}$/);
    assert.equal(await refusal(login({ JUKECORD_LDAP_URL: LDAPS }).login('dan', 'dan-e2e-password')), 'unavailable');
  });

  it('finds the groups by a search with the person in it, and the nested rule finds none on OpenLDAP', async () => {
    const searched = await login({
      JUKECORD_LDAP_GROUP_FILTER: '(uniqueMember={dn})',
      JUKECORD_LDAP_GROUP_BASE_DN: 'ou=groups,dc=example,dc=org',
    }).login('lee', 'lee-e2e-password');
    assert.deepEqual(searched.groups, ['cn=jukecord-listeners,ou=groups,dc=example,dc=org']);
    // Active Directory's rule (LDAP_MATCHING_RULE_IN_CHAIN) is Active Directory's: OpenLDAP answers it with nothing.
    const nested = await login({
      JUKECORD_LDAP_NESTED_GROUPS: 'yes',
      JUKECORD_LDAP_GROUP_BASE_DN: 'ou=groups,dc=example,dc=org',
    }).login('nia', 'nia-e2e-password');
    assert.deepEqual(nested.groups, []);
  });
});
