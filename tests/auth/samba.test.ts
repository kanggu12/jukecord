/**
 * Logging in with Active Directory accounts, against a Samba domain controller (tests/auth/run-ad.sh builds and
 * starts one from tests/auth/samba): sAMAccountName, the service account by its user principal name and its down-level
 * name, objectGUID, memberOf, the nested-group rule, the refusals of a right password (one to change first, an account
 * turned off), and a directory that takes passwords over an encrypted connection only. Skipped unless JUKECORD_E2E_AD
 * names the domain controller (ldap://localhost:1389).
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { LdapError, LdapLogin } from '../../src/auth/ldap.ts';
import { readAuthSettings } from '../../src/auth/settings.ts';
import { diskFiles } from '../../src/config.ts';
import { createLogger } from '../../src/log.ts';
import { type RunningJukecord, startJukecord } from './jukecord.ts';

const AD = process.env.JUKECORD_E2E_AD ?? '';
const ADS = process.env.JUKECORD_E2E_ADS ?? '';
const CA = process.env.JUKECORD_E2E_AD_CA ?? '';
const skip = AD === '' ? 'JUKECORD_E2E_AD is not set (tests/auth/run-ad.sh sets it)' : false;
const log = createLogger({ level: 'error', sinks: [] });

// The domain as a host would set jukecord up for it: StartTLS with the domain's CA, people by sAMAccountName.
const DOMAIN = {
  JUKECORD_LDAP_URL: AD,
  JUKECORD_LDAP_STARTTLS: 'yes',
  JUKECORD_LDAP_CA_FILE: CA,
  JUKECORD_LDAP_BIND_DN: 'jukecord@corp.example.test',
  JUKECORD_LDAP_BIND_PASSWORD: 'Service-e2e-Passw0rd',
  JUKECORD_LDAP_BASE_DN: 'DC=corp,DC=example,DC=test',
  JUKECORD_LDAP_USER_FILTER: '(&(objectClass=user)(sAMAccountName={username}))',
  JUKECORD_LDAP_ADMIN_GROUPS: 'jukecord-admins',
  JUKECORD_LDAP_CONTROL_GROUPS: 'CN=jukecord-djs,CN=Users,DC=corp,DC=example,DC=test',
  JUKECORD_LDAP_READ_GROUPS: 'jukecord-listeners',
};

function login(settings: Record<string, string> = {}): LdapLogin {
  const read = readAuthSettings({ ...DOMAIN, ...settings }, '/', diskFiles);
  assert.deepEqual(read.problems, []);
  if (!read.settings.ldap) throw new Error('no directory in the settings');
  return new LdapLogin({ settings: read.settings.ldap, log });
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'none';
  } catch (error) {
    return error instanceof LdapError ? `${error.code}: ${error.message}` : String(error);
  }
}

describe('logging in with an Active Directory account', { skip }, () => {
  let jukecord: RunningJukecord;
  const form = (username: string, password: string) =>
    fetch(`${jukecord.url}/auth/directory`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: jukecord.url },
      body: JSON.stringify({ username, password }),
    });

  before(async () => {
    // With the nested rule on: Lee is in Night Shift, which is in jukecord-listeners.
    jukecord = await startJukecord(18903, { ...DOMAIN, JUKECORD_LDAP_NESTED_GROUPS: 'yes' });
  });
  after(async () => {
    await jukecord?.stop();
  });

  it('lets each group in at its level, Lee through a group inside a group', async () => {
    for (const [name, password, level] of [
      ['ada', 'Ada-e2e-Passw0rd', 'admin'],
      ['DAN', 'Dan-e2e-Passw0rd', 'control'],
      ['lee', 'Lee-e2e-Passw0rd', 'read'],
    ] as const) {
      const answer = await form(name, password);
      assert.equal(answer.status, 200, name);
      const cookie = String(answer.headers.get('set-cookie')).split(';')[0] ?? '';
      const me = (await (await fetch(`${jukecord.url}/api/v1/me`, { headers: { cookie } })).json()) as {
        member: unknown;
      };
      assert.deepEqual(me.member, { provider: 'ldap', level }, name);
    }
  });

  it('answers a right password Active Directory refuses as a wrong one, and logs why', async () => {
    const wrong = await form('dan', 'not-it');
    assert.equal(wrong.status, 401);
    const said = await wrong.json();
    // Active Directory says "expired" and "turned off" only for the right password: telling them apart would tell a
    // guesser the guess was right.
    for (const [name, password] of [
      ['old', 'Old-e2e-Passw0rd'],
      ['off', 'Off-e2e-Passw0rd'],
    ] as const) {
      const right = await form(name, password);
      assert.equal(right.status, 401, name);
      assert.deepEqual(await right.json(), said, name);
    }
    // The reasons are in jukecord's log, for the host.
    assert.match(jukecord.output(), /a directory login did not go through reason=expired /);
    assert.match(jukecord.output(), /a directory login did not go through reason=disabled /);
    assert.equal((await form('sam', 'Sam-e2e-Passw0rd')).status, 403);
  });
});

describe('the directory part of an Active Directory domain', { skip }, () => {
  it('reads objectGUID as the lasting ID, and the groups from memberOf without the nested rule', async () => {
    const lee = await login().login('lee', 'Lee-e2e-Passw0rd');
    assert.match(lee.subject, /^guid:[0-9a-f]{32}$/);
    assert.equal(lee.name, 'Lee Listener');
    assert.deepEqual(lee.groups, ['CN=Night Shift,CN=Users,DC=corp,DC=example,DC=test']);
    const nested = await login({ JUKECORD_LDAP_NESTED_GROUPS: 'yes' }).login('lee', 'Lee-e2e-Passw0rd');
    assert.ok(nested.groups.includes('CN=jukecord-listeners,CN=Users,DC=corp,DC=example,DC=test'));
  });

  it('binds as the service account by its down-level name too, and over LDAPS', async () => {
    assert.equal(
      (await login({ JUKECORD_LDAP_BIND_DN: 'CORP\\jukecord' }).login('ada', 'Ada-e2e-Passw0rd')).name,
      'Ada Admin',
    );
    const secure = login({ JUKECORD_LDAP_URL: ADS, JUKECORD_LDAP_STARTTLS: 'no' });
    assert.equal((await secure.login('ada', 'Ada-e2e-Passw0rd')).name, 'Ada Admin');
  });

  it('says to encrypt when it is asked in the clear', async () => {
    assert.equal(
      await refusal(
        login({ JUKECORD_LDAP_STARTTLS: 'no', JUKECORD_LDAP_CA_FILE: '' }).login('ada', 'Ada-e2e-Passw0rd'),
      ),
      'unavailable: the directory takes names and passwords over an encrypted connection only: use ldaps:// or JUKECORD_LDAP_STARTTLS=yes',
    );
  });
});
