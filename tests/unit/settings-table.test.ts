/**
 * The settings table (src/settings/definitions.ts) against what reads it: config.ts reads every setting of the table
 * and nothing else, each default is the code's default, each limit is where the code draws it, and the guide's table is
 * the table's. A setting added in one place and forgotten in another fails here.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { withSettingsTable } from '../../scripts/settings-doc.ts';
import { AUTH_VARIABLES } from '../../src/auth/settings.ts';
import { type Config, ConfigError, loadConfig } from '../../src/config.ts';
import { sayError } from '../../src/core/say.ts';
import {
  DEPLOYMENT_VARIABLES,
  definition,
  GROUPS,
  KNOWN_VARIABLES,
  SETTINGS,
  type SettingDefinition,
  storedIn,
} from '../../src/settings/definitions.ts';
import { SPLIT } from '../../src/settings/layers.ts';
import { DESTINATIONS } from '../../src/settings/service.ts';
import { parseDuration, parseSize } from '../../src/util/units.ts';

// The least of each way of logging in that turns it on, so that one of its settings is read at all (alone, most of
// them are refused as set for a way that is off).
const SSO_ON = {
  JUKECORD_OIDC_ISSUER: 'https://sso.example.com/realms/home',
  JUKECORD_OIDC_CLIENT_ID: 'jukecord',
  JUKECORD_OIDC_READ_GROUPS: '*',
};
const DIRECTORY_ON = {
  JUKECORD_LDAP_URL: 'ldap://directory.example.org',
  JUKECORD_LDAP_BASE_DN: 'dc=example,dc=org',
  JUKECORD_LDAP_READ_GROUPS: '*',
};
// What a split's service needs beside its role: a database server, the bus, the shared secret, the core's address.
const SPLIT_ON = {
  JUKECORD_DATABASE_URL: 'postgres://jukecord@db.example/jukecord',
  JUKECORD_BUS_URL: 'redis://bus.example:6379',
  JUKECORD_INTERNAL_SECRET: 'x'.repeat(32),
  JUKECORD_CORE_URL: 'http://core:8796',
};
// What a setting needs beside it to be read.
function around(setting: SettingDefinition): Record<string, string> {
  if (setting.part === 'sso') return SSO_ON;
  if (setting.part === 'directory') return DIRECTORY_ON;
  if (setting.name === 'JUKECORD_ROLE') return SPLIT_ON;
  return {};
}

// The settings with the value given, read as jukecord reads them; the problems when they are refused.
function read(env: Record<string, string>): Config | readonly string[] {
  try {
    return loadConfig(env, '/srv/jukecord', { read: () => '', readable: () => false });
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
}
function refused(env: Record<string, string>): readonly string[] {
  const result = read(env);
  assert.ok(Array.isArray(result), `${JSON.stringify(env)} was taken`);
  return result as readonly string[];
}
function taken(env: Record<string, string>): Config {
  const result = read(env);
  assert.ok(!Array.isArray(result), `${JSON.stringify(env)} was refused: ${String(result)}`);
  return result as Config;
}

describe('the settings table', () => {
  it('names each setting once, each in a group of the page and a part of its group', () => {
    const names = SETTINGS.map((setting) => setting.name);
    assert.equal(new Set(names).size, names.length);
    for (const setting of SETTINGS) {
      assert.match(setting.name, /^JUKECORD_[A-Z_]+$/);
      const group = GROUPS.find((entry) => entry.id === setting.group);
      assert.ok(group, `${setting.name} is in no group`);
      // A group in parts has each of its settings in one of them; any other group has none.
      if (group.parts)
        assert.ok(
          group.parts.some((part) => part.id === setting.part),
          `${setting.name} has no part`,
        );
      else assert.equal(setting.part, undefined, `${setting.name} has a part in a group without parts`);
      // Words in both languages, short enough for one line of the page.
      for (const words of [setting.label, setting.help]) {
        assert.ok(words.en.trim() !== '' && words.ko.trim() !== '', `${setting.name} lacks words`);
        // The panel's rule for Korean: no em-dash.
        assert.doesNotMatch(`${words.en}${words.ko}`, /—/);
      }
    }
  });

  it('keeps out of the database every setting that steers a saved secret, or names a program or file jukecord uses', () => {
    // The database's rows can be written by another holder of its password (an edge, a copy of another jukecord's
    // data): none may send a saved secret somewhere else at the next start, or name something for jukecord to run or
    // read. Each is settings.json's, which only the host's own process writes, and in a split the environment's.
    const steering = DESTINATIONS.flatMap(({ secret, to }) => [secret, ...to]);
    // A path by its name: a file, a folder, a program (yt-dlp, FFmpeg), the cookies yt-dlp reads.
    const paths = SETTINGS.filter((setting) => /_(FILE|DIR|COOKIES|YTDLP|FFMPEG)$/.test(setting.name)).map(
      (setting) => setting.name,
    );
    assert.ok(paths.includes('JUKECORD_YTDLP') && paths.includes('JUKECORD_LDAP_CA_FILE'));
    for (const name of [...steering, ...paths]) {
      const setting = definition(name);
      assert.notEqual(storedIn(setting), 'database', `${name} is kept in the database`);
      // Saved where settings.json is, the environment's alone in a split (as every one of settings.json's).
      if (setting.layer !== 'environment') assert.equal(SPLIT.environmentOnly(setting), true, name);
    }
  });

  it('gives each kind what it needs: limits, words, items', () => {
    for (const setting of SETTINGS) {
      if (setting.kind === 'integer' || setting.kind === 'duration')
        assert.ok(setting.min !== undefined && setting.max !== undefined, setting.name);
      if (setting.kind === 'size') assert.ok(setting.min !== undefined, setting.name);
      if (setting.kind === 'choice') assert.ok((setting.choices?.length ?? 0) > 1, setting.name);
      if (setting.kind === 'boolean') assert.equal(setting.words?.length, 2, setting.name);
      if (setting.kind === 'list') assert.ok(setting.separator !== undefined, setting.name);
      // A secret is never written out where people read: either its kind says so, or it is marked (an address with a
      // password in it).
      if (setting.kind === 'secret') assert.equal(setting.secret, true, setting.name);
      // A secret mounted as a file is the usual way to hand one over in a container.
      if (setting.secret) assert.equal(setting.file, true, setting.name);
    }
  });

  it('is what config.ts reads: every setting of the table, the login ones, and nothing else', () => {
    // Every name loadConfig asks the environment for, given an environment that records them.
    const asked = new Set<string>();
    const env = new Proxy({} as Record<string, string>, {
      get: (_target, name) => {
        if (typeof name === 'string') asked.add(name);
        return undefined;
      },
    });
    loadConfig(env, '/srv/jukecord');
    // With the ways of logging in on, their settings are asked for too.
    const on = new Proxy({ ...SSO_ON, ...DIRECTORY_ON } as Record<string, string>, {
      get: (target, name) => {
        if (typeof name === 'string') asked.add(name);
        return typeof name === 'string' ? target[name] : undefined;
      },
    });
    loadConfig(on, '/srv/jukecord');
    const readNames = [...asked].filter((name) => name.startsWith('JUKECORD_')).sort();
    const known = [...KNOWN_VARIABLES, ...AUTH_VARIABLES].filter((name) => !DEPLOYMENT_VARIABLES.includes(name));
    assert.deepEqual(readNames, [...new Set(known)].sort());
  });

  it('knows every variable it reads: none of them is taken for a typo', () => {
    // A value of the right shape for each, read with the ways of logging in on (their settings refused otherwise).
    const env: Record<string, string> = { ...SSO_ON, ...DIRECTORY_ON };
    for (const name of [...KNOWN_VARIABLES, ...AUTH_VARIABLES]) env[name] ??= '';
    assert.deepEqual(taken(env).warnings, []);
  });

  it('has the defaults the code has: each written out reads as the setting left unset', () => {
    for (const setting of SETTINGS) {
      if (setting.default === null) continue;
      const unset = taken(around(setting));
      const written = taken({ ...around(setting), [setting.name]: setting.default });
      assert.deepEqual(written, unset, `${setting.name}=${setting.default} is not the default`);
    }
  });

  it('draws each limit where the code does: the smallest and largest taken, past them refused', () => {
    for (const setting of SETTINGS) {
      const base = around(setting);
      const at = (value: string) => ({ ...base, [setting.name]: value });
      if (setting.kind === 'integer') {
        const [min, max] = [Number(setting.min), Number(setting.max)];
        taken(at(String(min)));
        taken(at(String(max)));
        assert.match(refused(at(String(max + 1))).join('\n'), new RegExp(setting.name));
        if (min > 0) assert.match(refused(at(String(min - 1))).join('\n'), new RegExp(setting.name));
      }
      if (setting.kind === 'duration') {
        const [min, max] = [parseDuration(setting.min ?? ''), parseDuration(setting.max ?? '')];
        taken(at(`${min}ms`));
        taken(at(`${max}ms`));
        assert.match(refused(at(`${max + 1000}ms`)).join('\n'), new RegExp(setting.name));
        assert.match(refused(at(`${min - 1}ms`)).join('\n'), new RegExp(setting.name));
        // A duration that can be off takes its word for it.
        if (setting.off) taken(at(setting.off));
      }
      if (setting.kind === 'size') {
        const least = parseSize(setting.min ?? '');
        taken(at(String(least)));
        assert.match(refused(at(String(least - 1))).join('\n'), new RegExp(setting.name));
      }
      if (setting.kind === 'choice') {
        for (const choice of setting.choices ?? []) taken(at(choice));
        assert.match(refused(at('no-such-word')).join('\n'), new RegExp(setting.name));
      }
      if (setting.kind === 'boolean') {
        for (const word of setting.words ?? []) taken(at(word));
        assert.match(refused(at('maybe')).join('\n'), new RegExp(setting.name));
      }
      if (setting.kind === 'time') {
        taken(at('04:30'));
        if (setting.off) taken(at(setting.off));
        assert.match(refused(at('25:00')).join('\n'), new RegExp(setting.name));
      }
      if (setting.kind === 'list' && setting.choices) {
        taken(at(setting.choices.join(setting.separator)));
        if (setting.off) taken(at(setting.off));
        assert.match(refused(at('no-such-item')).join('\n'), new RegExp(setting.name));
      }
      if (setting.maxLength !== undefined) {
        taken(at('x'.repeat(setting.maxLength)));
        assert.match(refused(at('x'.repeat(setting.maxLength + 1))).join('\n'), new RegExp(setting.name));
      }
    }
  });

  it('is the guide’s table of settings (node scripts/settings-doc.ts writes it)', () => {
    const guide = fs.readFileSync('docs/README.md', 'utf8');
    assert.equal(withSettingsTable(guide), guide, 'docs/README.md is out of date: node scripts/settings-doc.ts');
    // Every variable is in it, the _FILE twins too; the deployment's are in INSTALL.md.
    for (const name of KNOWN_VARIABLES.filter((variable) => !DEPLOYMENT_VARIABLES.includes(variable))) {
      assert.ok(guide.includes(`\`${name}\``), `${name} is not in the guide`);
    }
  });

  it('has Korean for every problem the settings page can show', () => {
    // Values of every shape for every setting, alone and among the settings its checks read it with, and the pairs
    // the checks hold together: each problem they give is said in Korean too (a refused save shows them).
    const shapes = [
      'x',
      '0',
      '-1',
      '99999999',
      '1e4',
      '1.5x',
      'two words',
      'https://',
      'ftp://x',
      '25:00',
      'maybe',
      'a'.repeat(41),
    ];
    const problems = new Set<string>();
    const collect = (env: Record<string, string>) => {
      const result = read(env);
      if (Array.isArray(result)) for (const problem of result) problems.add(problem as string);
    };
    for (const setting of SETTINGS) {
      for (const value of shapes) {
        collect({ [setting.name]: value });
        collect({ ...around(setting), [setting.name]: value });
      }
      if (setting.file) {
        collect({ [setting.name]: 'x', [`${setting.name}_FILE`]: '/run/secret' });
        collect({ [`${setting.name}_FILE`]: '/run/secret' });
      }
    }
    for (const env of [
      { JUKECORD_DISCORD_CLIENT_SECRET: 's' },
      { JUKECORD_SPOTIFY_CLIENT_SECRET: 's' },
      { JUKECORD_OIDC_ISSUER: 'https://sso.example.com' },
      { JUKECORD_LDAP_URL: 'ldaps://dir.example.org', JUKECORD_LDAP_STARTTLS: 'yes' },
      { ...DIRECTORY_ON, JUKECORD_LDAP_BIND_DN: 'cn=x,dc=x' },
      { ...DIRECTORY_ON, JUKECORD_LDAP_GROUP_FILTER: '(member={dn})', JUKECORD_LDAP_NESTED_GROUPS: 'yes' },
      { ...DIRECTORY_ON, JUKECORD_LDAP_GROUP_BASE_DN: 'ou=g,dc=x' },
      { ...DIRECTORY_ON, JUKECORD_LDAP_USER_FILTER: '(cn=x)' },
      { ...DIRECTORY_ON, JUKECORD_LDAP_GROUP_FILTER: '(cn=x)' },
      { JUKECORD_DATABASE_URL: 'postgres://h/db' },
      { JUKECORD_DATABASE_URL: 'postgres://u@h/' },
      { JUKECORD_DATABASE_URL: 'postgres://u@h/db?nope=1' },
      { JUKECORD_DATABASE_URL: 'postgres://u@h/db?sslmode=prefer' },
      { JUKECORD_DATABASE_URL: 'postgres://u@h/db?ssl=maybe' },
      { JUKECORD_DATABASE_URL: 'postgres://u@h/db?connect_timeout=0' },
      { JUKECORD_DATABASE_URL: 'postgres://u@h/db?schema=a-b' },
      { JUKECORD_DATABASE_URL: 'redis://h' },
      { JUKECORD_DATABASE_URL: 'sqlite://host/x.db' },
    ])
      collect(env);
    assert.ok(problems.size > 60, `only ${problems.size} problems were made; are the shapes still right?`);
    for (const problem of problems) {
      assert.notEqual(sayError(problem, 'ko'), sayError(problem, 'en'), `no Korean for "${problem}"`);
    }
  });

  it('keeps definition() for the table’s own names: any other is a mistake in the code', () => {
    assert.equal(definition('JUKECORD_PORT').kind, 'integer');
    assert.throws(() => definition('JUKECORD_NO_SUCH'), /not in the settings table/);
  });
});
