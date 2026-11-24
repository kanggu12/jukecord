/**
 * The settings of logging in through OIDC and LDAP: off unless asked for, every mistake named at once, the secrets
 * from their variable or a file, and never shown.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { readAuthSettings, splitGroups } from '../../src/auth/settings.ts';
import { ConfigError, type ConfigFiles, describeConfig, loadConfig } from '../../src/config.ts';

// Files as a table: what a test puts there can be read, nothing else.
function filesOf(table: Record<string, string>): ConfigFiles {
  const full = (file: string) => path.resolve(file);
  const known = new Map(Object.entries(table).map(([file, text]) => [full(file), text]));
  return {
    read: (file) => {
      const text = known.get(full(file));
      if (text === undefined) throw new Error(`no file ${file}`);
      return text;
    },
    readable: (file) => known.has(full(file)),
  };
}

const NO_FILES = filesOf({});

// The problems a set of variables gives, one string per problem.
function problems(env: NodeJS.ProcessEnv, files = NO_FILES): string[] {
  return readAuthSettings(env, '/srv', files).problems;
}

const KEYCLOAK = {
  JUKECORD_OIDC_ISSUER: 'https://sso.example.com/realms/home',
  JUKECORD_OIDC_CLIENT_ID: 'jukecord',
  JUKECORD_OIDC_CLIENT_SECRET: 'oidc-secret-value',
  JUKECORD_OIDC_ADMIN_GROUPS: 'jukecord-admins',
};

const OPENLDAP = {
  JUKECORD_LDAP_URL: 'ldap://ldap.example.com:389',
  JUKECORD_LDAP_BIND_DN: 'cn=jukecord,ou=services,dc=example,dc=org',
  JUKECORD_LDAP_BIND_PASSWORD: 'service-password-value',
  JUKECORD_LDAP_BASE_DN: 'ou=people,dc=example,dc=org',
  JUKECORD_LDAP_READ_GROUPS: 'cn=listeners,ou=groups,dc=example,dc=org; cn=staff,ou=groups,dc=example,dc=org',
};

describe('login settings', () => {
  it('leaves both off when nothing is set, and changes nothing else', () => {
    const { settings } = readAuthSettings({}, '/srv', NO_FILES);
    assert.deepEqual(settings, { oidc: null, ldap: null });
    const config = loadConfig({}, '/srv');
    assert.deepEqual(config.auth, { oidc: null, ldap: null });
    assert.equal(describeConfig(config)['sso (oidc)'], 'off');
    assert.equal(describeConfig(config)['directory (ldap)'], 'off');
  });

  it('reads an OIDC provider with its defaults', () => {
    const { settings, problems: found } = readAuthSettings(KEYCLOAK, '/srv', NO_FILES);
    assert.deepEqual(found, []);
    assert.deepEqual(settings.oidc, {
      issuer: 'https://sso.example.com/realms/home',
      clientId: 'jukecord',
      clientSecret: 'oidc-secret-value',
      scopes: ['openid', 'profile'],
      groupsClaim: 'groups',
      groups: { admin: ['jukecord-admins'], control: [], read: [] },
      label: null,
      discordClaim: null,
    });
  });

  it('keeps the issuer exactly as written, puts openid first, and reads a dotted claim path', () => {
    const { settings } = readAuthSettings(
      {
        ...KEYCLOAK,
        // Authentik's issuers end with a slash, which the provider's own document repeats.
        JUKECORD_OIDC_ISSUER: 'https://auth.example.com/application/o/jukecord/',
        JUKECORD_OIDC_SCOPES: 'profile, groups openid',
        JUKECORD_OIDC_GROUPS_CLAIM: 'realm_access.roles',
        JUKECORD_OIDC_CONTROL_GROUPS: 'dj, /jukecord/djs; night shift',
        JUKECORD_OIDC_READ_GROUPS: '*',
        JUKECORD_OIDC_DISCORD_CLAIM: 'discord_id',
        JUKECORD_OIDC_LABEL: 'Log in with Keycloak',
      },
      '/srv',
      NO_FILES,
    );
    assert.equal(settings.oidc?.issuer, 'https://auth.example.com/application/o/jukecord/');
    assert.deepEqual(settings.oidc?.scopes, ['openid', 'profile', 'groups']);
    assert.equal(settings.oidc?.groupsClaim, 'realm_access.roles');
    assert.deepEqual(settings.oidc?.groups.control, ['dj', '/jukecord/djs', 'night shift']);
    assert.deepEqual(settings.oidc?.groups.read, ['*']);
    assert.equal(settings.oidc?.discordClaim, 'discord_id');
    assert.equal(settings.oidc?.label, 'Log in with Keycloak');
  });

  it('takes a public client without a secret, and a secret from a file', () => {
    const { JUKECORD_OIDC_CLIENT_SECRET: _secret, ...publicClient } = KEYCLOAK;
    assert.equal(readAuthSettings(publicClient, '/srv', NO_FILES).settings.oidc?.clientSecret, null);
    const files = filesOf({ '/run/secrets/oidc': 'from-the-file\n' });
    const fromFile = readAuthSettings(
      { ...publicClient, JUKECORD_OIDC_CLIENT_SECRET_FILE: '/run/secrets/oidc' },
      '/srv',
      files,
    );
    assert.deepEqual(fromFile.problems, []);
    assert.equal(fromFile.settings.oidc?.clientSecret, 'from-the-file');
    assert.deepEqual(problems({ ...KEYCLOAK, JUKECORD_OIDC_CLIENT_SECRET_FILE: '/run/secrets/oidc' }, files), [
      'set JUKECORD_OIDC_CLIENT_SECRET or JUKECORD_OIDC_CLIENT_SECRET_FILE, not both',
    ]);
  });

  it('names every OIDC mistake at once', () => {
    assert.deepEqual(problems({ JUKECORD_OIDC_ISSUER: 'sso.example.com', JUKECORD_OIDC_GROUPS_CLAIM: 'a..b' }), [
      'JUKECORD_OIDC_ISSUER: "sso.example.com" is not an issuer\'s address (example: https://sso.example.com/realms/home)',
      'JUKECORD_OIDC_ISSUER is set but JUKECORD_OIDC_CLIENT_ID is not',
      'JUKECORD_OIDC_GROUPS_CLAIM: "a..b" is not a claim name or a dotted path like realm_access.roles',
      'set who may log in: JUKECORD_OIDC_ADMIN_GROUPS, JUKECORD_OIDC_CONTROL_GROUPS or JUKECORD_OIDC_READ_GROUPS (a * lets in everyone the provider knows)',
    ]);
    // A query or a fragment is no issuer's.
    assert.match(
      problems({ ...KEYCLOAK, JUKECORD_OIDC_ISSUER: 'https://sso.example.com/?realm=home' })[0] ?? '',
      /not an issuer/,
    );
    // Settings of OIDC without its issuer would do nothing at all.
    assert.deepEqual(problems({ JUKECORD_OIDC_CLIENT_ID: 'jukecord' }), [
      'JUKECORD_OIDC_CLIENT_ID is set but JUKECORD_OIDC_ISSUER is not',
    ]);
    assert.match(problems({ ...KEYCLOAK, JUKECORD_OIDC_LABEL: 'x'.repeat(41) })[0] ?? '', /at most 40 characters/);
  });

  it('reads a directory with its defaults, groups by DN separated by semicolons', () => {
    const { settings, problems: found } = readAuthSettings(OPENLDAP, '/srv', NO_FILES);
    assert.deepEqual(found, []);
    assert.deepEqual(settings.ldap, {
      url: 'ldap://ldap.example.com:389',
      startTls: false,
      ca: null,
      bindDn: 'cn=jukecord,ou=services,dc=example,dc=org',
      bindPassword: 'service-password-value',
      baseDn: 'ou=people,dc=example,dc=org',
      userFilter: '(uid={username})',
      groupFilter: null,
      groupBaseDn: null,
      nestedGroups: false,
      groups: {
        admin: [],
        control: [],
        read: ['cn=listeners,ou=groups,dc=example,dc=org', 'cn=staff,ou=groups,dc=example,dc=org'],
      },
      timeoutMs: 10_000,
      label: null,
    });
  });

  it("reads Active Directory's settings: its filter, StartTLS with a CA, nested groups, names with commas", () => {
    const files = filesOf({
      '/etc/jukecord/ad-ca.pem': '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
    });
    const { settings, problems: found } = readAuthSettings(
      {
        JUKECORD_LDAP_URL: 'ldap://dc1.corp.example.com',
        JUKECORD_LDAP_STARTTLS: 'yes',
        JUKECORD_LDAP_CA_FILE: '/etc/jukecord/ad-ca.pem',
        JUKECORD_LDAP_BIND_DN: 'CN=jukecord,OU=Service Accounts,DC=corp,DC=example,DC=com',
        JUKECORD_LDAP_BIND_PASSWORD_FILE: '/run/secrets/ldap',
        JUKECORD_LDAP_BASE_DN: 'DC=corp,DC=example,DC=com',
        JUKECORD_LDAP_USER_FILTER: '(&(objectClass=user)(sAMAccountName={username}))',
        JUKECORD_LDAP_NESTED_GROUPS: 'yes',
        JUKECORD_LDAP_GROUP_BASE_DN: 'OU=Groups,DC=corp,DC=example,DC=com',
        JUKECORD_LDAP_ADMIN_GROUPS: 'Domain Admins',
        JUKECORD_LDAP_CONTROL_GROUPS: 'DJs, Night Shift',
        JUKECORD_LDAP_TIMEOUT: '5s',
      },
      '/srv',
      filesOf({ '/etc/jukecord/ad-ca.pem': files.read('/etc/jukecord/ad-ca.pem'), '/run/secrets/ldap': 'p4ss word\n' }),
    );
    assert.deepEqual(found, []);
    assert.equal(settings.ldap?.startTls, true);
    assert.match(settings.ldap?.ca ?? '', /BEGIN CERTIFICATE/);
    // A password from a file keeps its spaces inside; only the file's newline goes.
    assert.equal(settings.ldap?.bindPassword, 'p4ss word');
    assert.equal(settings.ldap?.nestedGroups, true);
    assert.deepEqual(settings.ldap?.groups.control, ['DJs', 'Night Shift']);
    assert.equal(settings.ldap?.timeoutMs, 5000);
  });

  it('names every LDAP mistake at once', () => {
    assert.deepEqual(
      problems({
        JUKECORD_LDAP_URL: 'ldaps://ldap.example.com',
        JUKECORD_LDAP_STARTTLS: 'yes',
        JUKECORD_LDAP_BIND_DN: 'jukecord',
        JUKECORD_LDAP_USER_FILTER: 'uid=alice',
        JUKECORD_LDAP_GROUP_FILTER: '(member={dn})',
        JUKECORD_LDAP_NESTED_GROUPS: 'maybe',
        JUKECORD_LDAP_TIMEOUT: '5m',
      }),
      [
        'JUKECORD_LDAP_STARTTLS is for ldap://; ldaps:// is encrypted already',
        'set both JUKECORD_LDAP_BIND_DN and JUKECORD_LDAP_BIND_PASSWORD, or neither',
        'JUKECORD_LDAP_BIND_DN: "jukecord" is not a DN (example: cn=jukecord,ou=services,dc=example,dc=org)',
        'JUKECORD_LDAP_URL is set but JUKECORD_LDAP_BASE_DN is not',
        'JUKECORD_LDAP_USER_FILTER: put {username} where the name typed goes, as in (uid={username})',
        'JUKECORD_LDAP_NESTED_GROUPS: "maybe" is not yes or no',
        'JUKECORD_LDAP_TIMEOUT: 5m is outside 1s-60s',
        'set who may log in: JUKECORD_LDAP_ADMIN_GROUPS, JUKECORD_LDAP_CONTROL_GROUPS or JUKECORD_LDAP_READ_GROUPS (a * lets in everyone the directory knows)',
      ],
    );
    assert.match(
      problems({ ...OPENLDAP, JUKECORD_LDAP_URL: 'https://ldap.example.com' })[0] ?? '',
      /not ldap:\/\/host/,
    );
    assert.match(
      problems({ ...OPENLDAP, JUKECORD_LDAP_URL: 'ldap://ldap.example.com/dc=example' })[0] ?? '',
      /not ldap/,
    );
    assert.match(problems({ ...OPENLDAP, JUKECORD_LDAP_USER_FILTER: '(uid={username}' })[0] ?? '', /not one filter/);
    assert.match(
      problems({ ...OPENLDAP, JUKECORD_LDAP_USER_FILTER: '(a={username})(b=1)' })[0] ?? '',
      /not one filter/,
    );
    assert.match(problems({ ...OPENLDAP, JUKECORD_LDAP_GROUP_FILTER: '(member=x)' })[0] ?? '', /put \{dn\}/);
    assert.match(
      problems({ ...OPENLDAP, JUKECORD_LDAP_GROUP_BASE_DN: 'ou=groups,dc=example,dc=org' })[0] ?? '',
      /where groups are searched/,
    );
    assert.match(problems({ ...OPENLDAP, JUKECORD_LDAP_CA_FILE: '/nowhere.pem' })[0] ?? '', /cannot be read/);
    assert.match(
      problems({ ...OPENLDAP, JUKECORD_LDAP_CA_FILE: '/ca.pem' }, filesOf({ '/ca.pem': 'not a certificate' }))[0] ?? '',
      /no certificate in PEM form/,
    );
    assert.deepEqual(problems({ JUKECORD_LDAP_BASE_DN: 'dc=example,dc=org' }), [
      'JUKECORD_LDAP_BASE_DN is set but JUKECORD_LDAP_URL is not',
    ]);
  });

  it('starts with the settings examples as they come: every login setting empty or at its default', () => {
    for (const file of ['.env.example', 'deploy/bundle/env.example']) {
      const env = Object.fromEntries(
        [...fs.readFileSync(file, 'utf8').matchAll(/^(JUKECORD_[A-Z_]+)=(.*)$/gm)].map((match) => [match[1], match[2]]),
      );
      assert.deepEqual(readAuthSettings(env, '/srv', NO_FILES), { settings: { oidc: null, ldap: null }, problems: [] });
    }
    // A switch written out at its default with its way off is no mistake.
    assert.deepEqual(problems({ JUKECORD_LDAP_STARTTLS: 'no', JUKECORD_OIDC_SCOPES: 'openid profile' }), []);
  });

  it('stops jukecord with the login problems among the others, and knows every variable', () => {
    assert.throws(
      () => loadConfig({ JUKECORD_PORT: 'x', JUKECORD_OIDC_ISSUER: 'https://sso.example.com' }, '/srv'),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.problems.some((problem) => problem.startsWith('JUKECORD_PORT')) &&
        error.problems.some((problem) => problem.includes('JUKECORD_OIDC_CLIENT_ID is not')),
    );
    // No "is not a jukecord setting" warning for any of them.
    const config = loadConfig({ ...KEYCLOAK, ...OPENLDAP }, '/srv');
    assert.deepEqual(config.warnings, []);
  });

  it('shows the settings with the secrets as set, never their value', () => {
    const shown = describeConfig(loadConfig({ ...KEYCLOAK, ...OPENLDAP }, '/srv'));
    const text = JSON.stringify(shown);
    assert.ok(!text.includes('oidc-secret-value'));
    assert.ok(!text.includes('service-password-value'));
    assert.equal(shown['sso (oidc)'], 'https://sso.example.com/realms/home');
    assert.equal(shown['sso client secret'], 'set');
    assert.equal(shown['sso levels'], 'admin: jukecord-admins');
    assert.equal(shown['directory service password'], 'set');
    assert.equal(
      shown['directory levels'],
      'read: cn=listeners,ou=groups,dc=example,dc=org | cn=staff,ou=groups,dc=example,dc=org',
    );
    assert.equal(shown['directory groups'], 'memberOf');
  });
});

describe('splitGroups', () => {
  it("splits OIDC's at commas and semicolons, LDAP's at semicolons and between plain names", () => {
    assert.deepEqual(splitGroups(' a, b ;c,, ', 'oidc'), ['a', 'b', 'c']);
    assert.deepEqual(splitGroups('cn=a,ou=g,dc=x;cn=b,ou=g,dc=x', 'ldap'), ['cn=a,ou=g,dc=x', 'cn=b,ou=g,dc=x']);
    assert.deepEqual(splitGroups('admins, djs; cn=x,dc=y', 'ldap'), ['admins', 'djs', 'cn=x,dc=y']);
    assert.deepEqual(splitGroups('*', 'ldap'), ['*']);
  });
});
