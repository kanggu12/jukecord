/**
 * Logging in with a directory account, against a made-up directory (tests/support/directory.ts): the name escaped
 * into the filter, an empty password refused before anything is sent, the service account first, groups from
 * memberOf, a group search or Active Directory's nested rule, the directory's refusals in their own words, and the
 * server's form route with its limiter per address and per name.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { InjectOptions } from 'fastify';
import { bindRefusal, escapeFilterValue, fillFilter, IN_CHAIN, LdapError, LdapLogin } from '../../src/auth/ldap.ts';
import type { LdapSettings } from '../../src/auth/settings.ts';
import { createLogger } from '../../src/log.ts';
import { API_PREFIX } from '../../src/web/api.ts';
import { memberKey, SESSION_COOKIE } from '../../src/web/auth.ts';
import { FakeDirectoryServer } from '../support/directory.ts';
import { type TestServer, testServer } from '../support/web.ts';

const log = createLogger({ level: 'error', sinks: [] });

const SETTINGS: LdapSettings = {
  url: 'ldap://ldap.example.test',
  startTls: false,
  ca: null,
  bindDn: 'cn=jukecord,ou=services,dc=example,dc=org',
  bindPassword: 'service-secret',
  baseDn: 'dc=example,dc=org',
  userFilter: '(uid={username})',
  groupFilter: null,
  groupBaseDn: null,
  nestedGroups: false,
  groups: { admin: ['admins'], control: ['cn=djs,ou=groups,dc=example,dc=org'], read: ['listeners'] },
  timeoutMs: 5000,
  label: null,
};

const ALICE_DN = 'uid=alice,ou=people,dc=example,dc=org';

// A directory with Alice (a DJ), Bob (in no group of jukecord's) and the groups; Active Directory's groups nest.
function directory(): FakeDirectoryServer {
  const server = new FakeDirectoryServer();
  server.people.push(
    {
      dn: ALICE_DN,
      password: 'alice-password',
      attributes: {
        uid: 'alice',
        cn: 'Alice Kim',
        displayName: 'Alice',
        entryUUID: 'F3A9E0B2-2C1D-4A7B-9E55-0D6C1B7E8A41',
        memberOf: ['cn=djs,ou=groups,dc=example,dc=org', 'cn=staff,ou=groups,dc=example,dc=org'],
      },
    },
    {
      dn: 'uid=bob,ou=people,dc=example,dc=org',
      password: 'bob-password',
      attributes: { uid: 'bob', cn: 'Bob', memberOf: ['cn=visitors,ou=groups,dc=example,dc=org'] },
    },
  );
  server.groups.push(
    { dn: 'cn=djs,ou=groups,dc=example,dc=org', members: [ALICE_DN] },
    { dn: 'cn=staff,ou=groups,dc=example,dc=org', members: [ALICE_DN] },
    { dn: 'cn=admins,ou=groups,dc=example,dc=org', members: ['cn=staff,ou=groups,dc=example,dc=org'] },
  );
  return server;
}

function login(server: FakeDirectoryServer, settings: Partial<LdapSettings> = {}) {
  return new LdapLogin({ settings: { ...SETTINGS, ...settings }, log, connect: server.connect });
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'none';
  } catch (error) {
    return error instanceof LdapError ? error.code : String(error);
  }
}

describe('filters', () => {
  it('escapes a value by RFC 4515: the backslash, the star, the parentheses and NUL', () => {
    assert.equal(escapeFilterValue('*)(uid=*'), '\\2a\\29\\28uid=\\2a');
    assert.equal(escapeFilterValue('a\\b'), 'a\\5cb');
    assert.equal(escapeFilterValue('nul\0'), 'nul\\00');
    // Letters of any script, spaces and the rest stay as they are.
    assert.equal(escapeFilterValue("김 진구 o'neil"), "김 진구 o'neil");
  });

  it('fills the placeholders with escaped values, and a "$" in a value is no pattern', () => {
    assert.equal(fillFilter('(uid={username})', { username: 'x)(cn=*' }), '(uid=x\\29\\28cn=\\2a)');
    assert.equal(
      fillFilter('(|(member={dn})(memberUid={username}))', { username: 'a$&b', dn: 'cn=a (b),dc=x' }),
      '(|(member=cn=a \\28b\\29,dc=x)(memberUid=a$&b))',
    );
  });

  it("reads Active Directory's reason in its refusal of a bind", () => {
    const ad = (data: string) =>
      `80090308: LdapErr: DSID-0C09042A, comment: AcceptSecurityContext error, data ${data}, v4563`;
    assert.equal(bindRefusal(ad('52e')), 'wrong');
    assert.equal(bindRefusal(ad('525')), 'wrong');
    assert.equal(bindRefusal(ad('532')), 'expired');
    assert.equal(bindRefusal(ad('773')), 'expired');
    assert.equal(bindRefusal(ad('533')), 'disabled');
    assert.equal(bindRefusal(ad('775')), 'disabled');
    assert.equal(bindRefusal('Invalid Credentials'), 'wrong');
  });
});

describe('LdapLogin', () => {
  it('finds the person with the service account, reads their groups, then lets the directory check the password', async () => {
    const server = directory();
    const identity = await login(server).login(' alice ', 'alice-password');
    assert.deepEqual(identity, {
      subject: 'entryUUID:f3a9e0b2-2c1d-4a7b-9e55-0d6c1b7e8a41',
      dn: ALICE_DN,
      name: 'Alice',
      groups: ['cn=djs,ou=groups,dc=example,dc=org', 'cn=staff,ou=groups,dc=example,dc=org'],
    });
    assert.deepEqual(server.log, [
      'open',
      `bind ${SETTINGS.bindDn}`,
      'search dc=example,dc=org (uid=alice)',
      `bind ${ALICE_DN}`,
      'unbind',
    ]);
  });

  it('refuses an empty name or password before anything is sent to the directory', async () => {
    const server = directory();
    assert.equal(await refusal(login(server).login('alice', '')), 'invalid');
    assert.equal(await refusal(login(server).login('   ', 'x')), 'invalid');
    assert.deepEqual(server.log, []);
  });

  it('finds nobody for a name made of filter syntax, and says only that the name or password is wrong', async () => {
    const server = directory();
    assert.equal(await refusal(login(server).login('*', 'alice-password')), 'wrong');
    assert.equal(await refusal(login(server).login('*)(uid=*', 'x')), 'wrong');
    assert.ok(server.log.includes('search dc=example,dc=org (uid=\\2a)'));
    // No bind as anyone but the service account: nobody was found.
    assert.ok(!server.log.some((line) => line.startsWith('bind uid=')));
    assert.equal(await refusal(login(server).login('alice', 'not-hers')), 'wrong');
    assert.equal(await refusal(login(server).login('carol', 'x')), 'wrong');
  });

  it('says when Active Directory refuses a right password: expired, or the account turned off', async () => {
    const server = directory();
    server.people.push(
      { dn: 'uid=old,ou=people,dc=example,dc=org', password: 'p', attributes: { uid: 'old' }, refuse: '532' },
      { dn: 'uid=off,ou=people,dc=example,dc=org', password: 'p', attributes: { uid: 'off' }, refuse: '533' },
    );
    assert.equal(await refusal(login(server).login('old', 'p')), 'expired');
    assert.equal(await refusal(login(server).login('off', 'p')), 'disabled');
  });

  it("calls a refused service account, an unreachable directory and a missing base the directory's trouble", async () => {
    const server = directory();
    assert.equal(
      await refusal(login(server, { bindPassword: 'wrong' }).login('alice', 'alice-password')),
      'unavailable',
    );
    server.down = true;
    assert.equal(await refusal(login(server).login('alice', 'alice-password')), 'unavailable');
  });

  it('tells a directory that cannot be reached from one that refused the service account', async () => {
    const server = directory();
    const message = async (settings: Partial<LdapSettings>) => {
      try {
        await login(server, settings).login('alice', 'alice-password');
        return 'none';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    assert.match(await message({ bindPassword: 'wrong' }), /^the directory refused jukecord's service account/);
    // ldapts connects at the first request: there the socket's error shows, and it is no refusal.
    server.unreachable = true;
    assert.match(await message({}), /^the directory could not be reached: connect ECONNREFUSED/);
    const { checks } = await login(server).test();
    assert.deepEqual(
      checks.map((check) => [check.name, check.status]),
      [['connection', 'fail']],
    );
  });

  it('says to encrypt when the directory takes no password in the clear, and StartTLS gets through', async () => {
    const server = directory();
    server.encryptedOnly = true;
    await assert.rejects(
      login(server).login('alice', 'alice-password'),
      (error: unknown) =>
        error instanceof LdapError &&
        error.code === 'unavailable' &&
        /encrypted connection only: use ldaps:\/\/ or JUKECORD_LDAP_STARTTLS=yes/.test(error.message),
    );
    assert.equal((await login(server, { startTls: true }).login('alice', 'alice-password')).name, 'Alice');
  });

  it('refuses a filter that finds two people', async () => {
    const server = directory();
    assert.equal(
      await refusal(login(server, { userFilter: '(|(uid={username})(uid=bob))' }).login('alice', 'x')),
      'ambiguous',
    );
  });

  it('searches anonymously without a service account, and upgrades with StartTLS before anything else', async () => {
    const server = directory();
    await login(server, { bindDn: null, bindPassword: null, startTls: true }).login('alice', 'alice-password');
    assert.deepEqual(server.log.slice(0, 3), ['open', 'starttls', 'search dc=example,dc=org (uid=alice)']);
  });

  it("reads the groups by a search with the person's DN, or by Active Directory's nested rule", async () => {
    const server = directory();
    const searched = await login(server, {
      groupFilter: '(member={dn})',
      groupBaseDn: 'ou=groups,dc=example,dc=org',
    }).login('alice', 'alice-password');
    assert.deepEqual(searched.groups, ['cn=djs,ou=groups,dc=example,dc=org', 'cn=staff,ou=groups,dc=example,dc=org']);
    assert.ok(server.log.includes(`search ou=groups,dc=example,dc=org (member=${ALICE_DN})`));
    const nested = await login(server, { nestedGroups: true }).login('alice', 'alice-password');
    // Admins holds Staff, which holds Alice: found through the rule, as Active Directory finds it.
    assert.ok(nested.groups.includes('cn=admins,ou=groups,dc=example,dc=org'));
    assert.ok(server.log.includes(`search dc=example,dc=org (member:${IN_CHAIN}:=${ALICE_DN})`));
  });

  it('tests the settings and a name without a password: the connection, the account, the base, the person, the groups', async () => {
    const server = directory();
    const { checks, groups } = await login(server).test('alice');
    assert.deepEqual(
      checks.map((check) => [check.name, check.status]),
      [
        ['connection', 'ok'],
        ['service account', 'ok'],
        ['base DN', 'ok'],
        ['person', 'ok'],
        ['groups', 'ok'],
      ],
    );
    assert.equal(groups?.length, 2);
    // It never binds as the person.
    assert.ok(!server.log.includes(`bind ${ALICE_DN}`));
    const wrong = await login(server, { bindPassword: 'nope' }).test();
    assert.deepEqual(
      wrong.checks.map((check) => [check.name, check.status]),
      [
        ['connection', 'ok'],
        ['service account', 'fail'],
      ],
    );
    assert.ok(!JSON.stringify(wrong).includes('nope'));
  });
});

describe('logging in with a directory account through the server', () => {
  let server: TestServer;
  const fake = directory();
  const inject = (options: InjectOptions) => server.web.app.inject(options);
  const form = (username: string, password: string, address = '10.2.0.1', origin = 'http://localhost:8795') =>
    inject({
      method: 'POST',
      url: '/auth/directory',
      remoteAddress: address,
      headers: { origin, host: 'localhost:8795' },
      payload: { username, password, next: '/stats' },
    });

  before(async () => {
    server = await testServer({ ldap: { settings: SETTINGS, connect: fake.connect } });
  });
  after(() => server.close());

  it('lets a person in at the level of their groups, by their name, and says where to go', async () => {
    const answer = await form('alice', 'alice-password');
    assert.equal(answer.statusCode, 200);
    assert.deepEqual(answer.json(), { ok: true, next: '/stats' });
    const cookie = String(answer.headers['set-cookie']).split(';')[0] ?? '';
    assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=`));
    const me = (await inject({ method: 'GET', url: `${API_PREFIX}/me`, headers: { cookie } })).json();
    assert.equal(me.kind, 'member');
    assert.equal(me.id, memberKey('ldap', 'entryUUID:f3a9e0b2-2c1d-4a7b-9e55-0d6c1b7e8a41'));
    assert.equal(me.name, 'Alice');
    assert.deepEqual(me.member, { provider: 'ldap', level: 'control' });
  });

  it('refuses in words: a wrong password, no group of jukecord, an empty password, another site', async () => {
    const wrong = await form('alice', 'nope', '10.2.0.2');
    assert.equal(wrong.statusCode, 401);
    assert.deepEqual(wrong.json(), { error: { code: 'wrong-password', message: 'wrong name or password' } });
    const stranger = await form('bob', 'bob-password', '10.2.0.2');
    assert.equal(stranger.statusCode, 403);
    assert.equal(stranger.json().error.code, 'no-group');
    const empty = await form('alice', '', '10.2.0.2');
    assert.equal(empty.statusCode, 400);
    const elsewhere = await form('alice', 'alice-password', '10.2.0.2', 'https://evil.example');
    assert.equal(elsewhere.statusCode, 403);
  });

  it('holds back one name tried from many addresses, and one address trying many names', async () => {
    // Twenty wrong passwords for Carol's name, each from an address of its own.
    for (let i = 0; i < 20; i += 1) assert.equal((await form('carol', 'guess', `10.3.0.${i}`)).statusCode, 401);
    const blocked = await form('Carol', 'guess', '10.3.1.1');
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.json().error.code, 'too-many');
    // The directory was not asked for the refused try.
    const asked = fake.log.filter((line) => line.includes('(uid=Carol)')).length;
    assert.equal(asked, 0);
    // Twenty failures from one address, with names that differ.
    for (let i = 0; i < 20; i += 1) await form(`nobody${i}`, 'guess', '10.4.0.1');
    assert.equal((await form('alice', 'alice-password', '10.4.0.1')).statusCode, 429);
    // Others are not held back.
    assert.equal((await form('alice', 'alice-password', '10.4.0.2')).statusCode, 200);
  });

  it('says the directory did not answer, and does not count that as a failed login', async () => {
    fake.down = true;
    try {
      const answer = await form('alice', 'alice-password', '10.5.0.1');
      assert.equal(answer.statusCode, 503);
      assert.equal(answer.json().error.code, 'directory-down');
    } finally {
      fake.down = false;
    }
    assert.equal(await server.auth.limiter.blocked(['address:10.5.0.1']), false);
  });
});
