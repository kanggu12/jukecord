/**
 * The host's settings through the HTTP API and the jukecord command: the host alone may read and change them, a change
 * refused says each problem by its setting, a setting the environment sets cannot be changed, a secret never comes
 * back, a database's address is tried without saving it, and a restart is refused where nothing would start jukecord
 * again.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { InjectOptions } from 'fastify';
import { COMMANDS, settingName } from '../../src/cli/commands.ts';
import { API_PREFIX } from '../../src/web/api.ts';
import { CSRF_HEADER, memberKey } from '../../src/web/auth.ts';
import { asHost, sessionFor, type TestServer, testServer } from '../support/web.ts';

const api = (path: string) => `${API_PREFIX}${path}`;
// A made-up Discord token, to look for in every answer (put together: a whole one in the source is what scanners stop).
const TOKEN = ['MTA4ODc2NTQzMjEwOTg3NjU0Mw', 'GaBcDe', 'abcdefghijklmnopqrstuvwxyz0123456789AB'].join('.');

// A request as the host, its answer as JSON.
async function asked(server: TestServer, options: InjectOptions) {
  const response = await server.web.app.inject({ ...options, headers: { ...asHost, ...(options.headers ?? {}) } });
  return { status: response.statusCode, json: response.json() as Record<string, unknown> };
}

describe('the host’s settings in the API', () => {
  it('shows every setting to the host alone', async () => {
    const server = await testServer({ hostSettings: {} });
    try {
      const view = await asked(server, { method: 'GET', url: api('/settings') });
      assert.equal(view.status, 200);
      const settings = view.json.settings as { name: string; source: string }[];
      assert.ok(settings.some((setting) => setting.name === 'JUKECORD_QUEUE_MAX'));
      assert.deepEqual((view.json.restart as { pending: string[] }).pending, []);
      // A Discord login, even one that manages the server, is not the host.
      const alice = await sessionFor(server, '300000000000000001');
      const refused = await server.web.app.inject({
        method: 'GET',
        url: api('/settings'),
        headers: { cookie: alice.cookie },
      });
      assert.equal(refused.statusCode, 403);
      assert.equal(refused.json().error.message, 'this needs the host');
    } finally {
      await server.close();
    }
  });

  it('keeps them from a member at the admin level: the host itself only, its token or its own session', async () => {
    const server = await testServer({ hostSettings: {} });
    try {
      // A member whose groups give the admin level may do what the host may elsewhere, but not this.
      const setCookie = await server.auth.startSession({
        kind: 'member',
        memberId: memberKey('oidc', 'made-up-subject-0001'),
        provider: 'oidc',
        level: 'admin',
      });
      const cookie = setCookie.split(';')[0] ?? '';
      const caller = await server.auth.identify({ cookie });
      const headers = { cookie, [CSRF_HEADER]: caller?.csrf ?? '' };
      for (const [method, url, payload] of [
        ['GET', '/settings', undefined],
        ['GET', '/settings/JUKECORD_QUEUE_MAX', undefined],
        ['PATCH', '/settings', { values: { JUKECORD_QUEUE_MAX: '50' } }],
        ['POST', '/settings/test-database', { url: 'sqlite:other.db' }],
        ['POST', '/settings/database-move', { url: 'sqlite:other.db' }],
        ['POST', '/restart', undefined],
      ] as const) {
        const response = await server.web.app.inject({
          method,
          url: api(url),
          headers,
          ...(payload ? { payload } : {}),
        });
        assert.equal(response.statusCode, 403, `${method} ${url}`);
        assert.equal(response.json().error.message, 'only the host itself can see and change jukecord’s settings');
      }
      // Nothing was changed by the refused ones.
      assert.equal((await server.store.hostSettings.all()).length, 0);
      // The host's own session (jukecord open's link) may.
      const host = await server.auth.startSession({ kind: 'host' } as never);
      const hostCookie = host.split(';')[0] ?? '';
      const own = await server.web.app.inject({
        method: 'GET',
        url: api('/settings'),
        headers: { cookie: hostCookie },
      });
      assert.equal(own.statusCode, 200);
    } finally {
      await server.close();
    }
  });

  it('sends no saved secret to a new place: the directory’s password is typed again for a new address', async () => {
    const server = await testServer({
      // An empty variable (Compose's VAR= for an empty line of .env) sets nothing: the page may save the address.
      hostSettings: { env: { JUKECORD_LDAP_URL: '' } },
    });
    try {
      const change = (values: Record<string, string | null>) =>
        asked(server, { method: 'PATCH', url: api('/settings'), payload: { values } });
      const directory = {
        JUKECORD_LDAP_URL: 'ldaps://directory.example.org',
        JUKECORD_LDAP_BASE_DN: 'dc=example,dc=org',
        JUKECORD_LDAP_READ_GROUPS: '*',
        JUKECORD_LDAP_BIND_DN: 'cn=jukecord,dc=example,dc=org',
        JUKECORD_LDAP_BIND_PASSWORD: 'saved-password-made-up',
      };
      assert.equal((await change(directory)).status, 200);
      // Another address, the password not given again: refused, the password and the address named.
      const moved = await change({ JUKECORD_LDAP_URL: 'ldaps://elsewhere.example.org' });
      assert.equal(moved.status, 400);
      const problems = (moved.json.error as { problems: { names: string[] }[] }).problems;
      assert.deepEqual(problems[0]?.names, ['JUKECORD_LDAP_BIND_PASSWORD', 'JUKECORD_LDAP_URL']);
      // The same with another service account, and with StartTLS turned off on a plain address.
      assert.equal((await change({ JUKECORD_LDAP_BIND_DN: 'cn=other,dc=example,dc=org' })).status, 400);
      // Typed again (or put away): taken.
      assert.equal(
        (
          await change({
            JUKECORD_LDAP_URL: 'ldaps://elsewhere.example.org',
            JUKECORD_LDAP_BIND_PASSWORD: 'typed-again',
          })
        ).status,
        200,
      );
      assert.equal(
        (await change({ JUKECORD_OIDC_ISSUER: null })).status,
        200,
        'a change of another way is not held to this one',
      );
      // The identity provider's client secret likewise: a new issuer needs it typed again.
      const sso = {
        JUKECORD_OIDC_ISSUER: 'https://sso.example.com/realms/home',
        JUKECORD_OIDC_CLIENT_ID: 'jukecord',
        JUKECORD_OIDC_CLIENT_SECRET: 'saved-secret-made-up',
        JUKECORD_OIDC_READ_GROUPS: '*',
      };
      assert.equal((await change(sso)).status, 200);
      assert.equal((await change({ JUKECORD_OIDC_ISSUER: 'https://sso.attacker.example/realms/x' })).status, 400);
      assert.equal((await change({ JUKECORD_OIDC_CLIENT_ID: 'another' })).status, 400);
      // Turned off: the secret goes nowhere, and is put away with the rest (a secret left for a way that is off is the
      // start's own refusal).
      const off = { JUKECORD_OIDC_ISSUER: null, JUKECORD_OIDC_CLIENT_ID: null, JUKECORD_OIDC_READ_GROUPS: null };
      assert.equal((await change(off)).status, 400);
      assert.equal((await change({ ...off, JUKECORD_OIDC_CLIENT_SECRET: null })).status, 200);
    } finally {
      await server.close();
    }
  });

  it('changes settings all or nothing, says each problem by its setting, and puts one back', async () => {
    const server = await testServer({ hostSettings: {} });
    try {
      const refused = await asked(server, {
        method: 'PATCH',
        url: api('/settings'),
        payload: { values: { JUKECORD_QUEUE_MAX: '5', JUKECORD_LOG_LEVEL: 'debug' } },
      });
      assert.equal(refused.status, 400);
      const error = refused.json.error as { code: string; problems: { names: string[]; message: string }[] };
      assert.equal(error.code, 'invalid');
      assert.deepEqual(error.problems, [
        { names: ['JUKECORD_QUEUE_MAX'], message: 'JUKECORD_QUEUE_MAX: 5 is outside 10-100000' },
      ]);
      const taken = await asked(server, {
        method: 'PATCH',
        url: api('/settings'),
        payload: { values: { JUKECORD_QUEUE_MAX: '50', JUKECORD_LOG_LEVEL: 'debug' } },
      });
      assert.equal(taken.status, 200);
      assert.deepEqual(taken.json.changed, [
        { name: 'JUKECORD_QUEUE_MAX', from: '1000', to: '50', applies: 'now' },
        { name: 'JUKECORD_LOG_LEVEL', from: 'info', to: 'debug', applies: 'now' },
      ]);
      // Applied at once, both.
      assert.deepEqual(server.applied, [['JUKECORD_QUEUE_MAX', 'JUKECORD_LOG_LEVEL']]);
      const one = await asked(server, { method: 'GET', url: api('/settings/JUKECORD_QUEUE_MAX') });
      assert.deepEqual([one.json.value, one.json.source, one.json.revision], ['50', 'saved', 1]);
      // A page that read revision 0 cannot write over it.
      const stale = await asked(server, { method: 'DELETE', url: api('/settings/JUKECORD_QUEUE_MAX?revision=0') });
      assert.equal(stale.status, 409);
      const reset = await asked(server, { method: 'DELETE', url: api('/settings/JUKECORD_QUEUE_MAX?revision=1') });
      assert.equal(reset.status, 200);
      const again = await asked(server, { method: 'GET', url: api('/settings/JUKECORD_QUEUE_MAX') });
      assert.deepEqual([again.json.value, again.json.source], ['1000', 'default']);
      // No such setting.
      assert.equal((await asked(server, { method: 'GET', url: api('/settings/JUKECORD_NO_SUCH') })).status, 404);
    } finally {
      await server.close();
    }
  });

  it('refuses a setting the environment sets, naming its variable', async () => {
    const server = await testServer({ hostSettings: { env: { JUKECORD_LOG_LEVEL: 'warn' } } });
    try {
      const refused = await asked(server, {
        method: 'PATCH',
        url: api('/settings'),
        payload: { values: { JUKECORD_LOG_LEVEL: 'debug' } },
      });
      assert.equal(refused.status, 409);
      assert.equal(
        (refused.json.error as { message: string }).message,
        'JUKECORD_LOG_LEVEL is set by the environment (JUKECORD_LOG_LEVEL)',
      );
    } finally {
      await server.close();
    }
  });

  it('never sends a secret back: only whether it is set', async () => {
    const server = await testServer({ hostSettings: {} });
    try {
      const changed = await asked(server, {
        method: 'PATCH',
        url: api('/settings'),
        payload: { values: { JUKECORD_DISCORD_TOKEN: TOKEN } },
      });
      const one = await asked(server, { method: 'GET', url: api('/settings/JUKECORD_DISCORD_TOKEN') });
      const all = await asked(server, { method: 'GET', url: api('/settings') });
      for (const answer of [changed, one, all]) assert.ok(!JSON.stringify(answer.json).includes(TOKEN));
      assert.deepEqual([one.json.value, one.json.set, one.json.pending], [null, true, true]);
      // Nor in the log.
      assert.ok(!JSON.stringify(server.logs.records).includes(TOKEN));
    } finally {
      await server.close();
    }
  });

  it('tries an address for the shared cache or the bus without saving it, each failure in one sentence', async () => {
    const server = await testServer({ hostSettings: {} });
    try {
      const test = async (use: 'cache' | 'bus', url: string) =>
        (await asked(server, { method: 'POST', url: api(`/settings/test-${use}`), payload: { url } })).json;
      // The cache in memory: nothing to reach. The bus has no memory to be in.
      assert.deepEqual(await test('cache', 'memory'), {
        ok: true,
        where: 'memory',
        server: null,
        roundTripMs: null,
        problem: null,
      });
      assert.equal((await test('bus', 'memory')).problem, 'that is not an address (example: redis://valkey:6379)');
      // Not a Redis address: the start's own rule, in its words.
      const web = await test('bus', 'https://valkey.example.org');
      assert.equal(web.problem, 'a Redis or Valkey address starts with redis:// or rediss:// (TLS), and names a host');
      // A server that is not there: the client's own words after the address, never its password, at once (tried once).
      const started = Date.now();
      const away = await test('cache', 'redis://:password-made-up@nowhere.invalid:6379');
      assert.equal(away.ok, false);
      assert.equal(away.where, 'redis://nowhere.invalid:6379');
      assert.match(String(away.problem), /^redis:\/\/nowhere\.invalid:6379: .*ENOTFOUND/);
      assert.ok(!JSON.stringify(away).includes('password-made-up'));
      assert.ok(Date.now() - started < 4000, 'tried again instead of saying the first failure');
    } finally {
      await server.close();
    }
  });

  it('tries a database’s address without saving it, and says plainly what it found', async () => {
    const server = await testServer({ hostSettings: {} });
    try {
      // A SQLite file not there yet: the move would make it.
      const file = await asked(server, {
        method: 'POST',
        url: api('/settings/test-database'),
        payload: { url: 'sqlite:other.db' },
      });
      assert.deepEqual([file.json.ok, file.json.newFile, file.json.kind], [true, true, 'sqlite']);
      assert.equal(fs.existsSync(path.join(server.dataDir, 'other.db')), false, 'the test made the file');
      // An address that is none: the setting's own problem.
      const wrong = await asked(server, {
        method: 'POST',
        url: api('/settings/test-database'),
        payload: { url: 'redis://cache.example' },
      });
      assert.equal(wrong.status, 400);
      assert.match((wrong.json.error as { message: string }).message, /^JUKECORD_DATABASE_URL starts with redis:\/\//);
      // A server that does not answer: why, in one sentence, never the password.
      const away = await asked(server, {
        method: 'POST',
        url: api('/settings/test-database'),
        payload: { url: 'postgres://jukecord:pass-made-up@127.0.0.1:9/jukecord?connect_timeout=1' },
      });
      assert.equal(away.status, 200);
      assert.equal(away.json.ok, false);
      assert.match(String(away.json.problem), /PostgreSQL \(127\.0\.0\.1:9, database jukecord, without TLS\)/);
      assert.ok(!JSON.stringify(away.json).includes('pass-made-up'));
    } finally {
      await server.close();
    }
  });

  it('refuses a restart where nothing would start jukecord again, and asks for one where something would', async () => {
    const alone = await testServer({ hostSettings: { supervisor: 'none' } });
    try {
      const refused = await asked(alone, { method: 'POST', url: api('/restart') });
      assert.equal(refused.status, 409);
      assert.match((refused.json.error as { message: string }).message, /^nothing would start jukecord again here/);
    } finally {
      await alone.close();
    }
    let restarted = 0;
    const docker = await testServer({ hostSettings: { supervisor: 'docker', restart: () => restarted++ } });
    try {
      const asking = await asked(docker, { method: 'POST', url: api('/restart') });
      assert.deepEqual([asking.status, asking.json], [200, { supervisor: 'docker', restarts: true }]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(restarted, 1);
    } finally {
      await docker.close();
    }
  });

  it('has no move until one is started, and no switch without a finished copy', async () => {
    const server = await testServer({ hostSettings: { supervisor: 'docker', restart: () => {} } });
    try {
      const status = await asked(server, { method: 'GET', url: api('/settings/database-move') });
      assert.deepEqual(status.json, { state: null, lastFailure: null });
      const switching = await asked(server, { method: 'POST', url: api('/settings/database-move/switch') });
      assert.equal(switching.status, 409);
      // Moving onto the database in use is refused before anything is copied.
      const same = await asked(server, {
        method: 'POST',
        url: api('/settings/database-move'),
        payload: { url: 'sqlite:' },
      });
      assert.equal(same.status, 400);
    } finally {
      await server.close();
    }
  });

  it('refuses the settings where jukecord keeps none (a server made without them)', async () => {
    const server = await testServer();
    try {
      const refused = await asked(server, { method: 'GET', url: api('/settings') });
      assert.equal(refused.status, 503);
    } finally {
      await server.close();
    }
  });
});

describe('the host’s settings in the jukecord command', () => {
  it('takes a setting’s name with or without its prefix, in any case, with dashes', () => {
    assert.equal(settingName('JUKECORD_LOG_LEVEL'), 'JUKECORD_LOG_LEVEL');
    assert.equal(settingName('log-level'), 'JUKECORD_LOG_LEVEL');
    assert.equal(settingName('queue_max'), 'JUKECORD_QUEUE_MAX');
    assert.throws(() => settingName('no such!'), /is not a setting's name/);
    assert.throws(() => settingName(undefined), /say which setting/);
  });

  it('builds each request from the words typed', async () => {
    const words = (args: string[], flags: [string, string | true][] = []) => ({ args, flags: new Map(flags) });
    const lookups = {} as never;
    assert.deepEqual(
      await COMMANDS['host-settings-change'].request(words(['log-level', 'debug', 'QUEUE_MAX', '50']), lookups),
      { body: { values: { JUKECORD_LOG_LEVEL: 'debug', JUKECORD_QUEUE_MAX: '50' } } },
    );
    assert.throws(
      () => COMMANDS['host-settings-change'].request(words(['log-level']), lookups),
      /each setting and its value/,
    );
    assert.deepEqual(await COMMANDS['host-setting-reset'].request(words(['prefetch']), lookups), {
      params: { name: 'JUKECORD_PREFETCH' },
    });
    assert.deepEqual(
      await COMMANDS['database-move'].request(words(['postgres://u@db/j'], [['replace', true]]), lookups),
      { body: { url: 'postgres://u@db/j', replace: true } },
    );
  });

  it('lists the settings by group, a secret as set, what waits for a restart at the end', () => {
    const shown = COMMANDS['host-settings'].show({
      groups: [
        { id: 'server', label: { en: 'Server and network' } },
        { id: 'discord', label: { en: 'Discord' } },
      ],
      settings: [
        {
          name: 'JUKECORD_PORT',
          group: 'server',
          value: '8796',
          secret: false,
          source: 'saved',
          variable: null,
          pending: true,
          running: '8795',
          refused: null,
          defaultNote: null,
        },
        {
          name: 'JUKECORD_DISCORD_TOKEN',
          group: 'discord',
          value: null,
          set: true,
          shown: null,
          secret: true,
          source: 'environment',
          variable: 'JUKECORD_DISCORD_TOKEN_FILE',
          pending: false,
          running: null,
          refused: null,
          defaultNote: null,
        },
      ],
      restart: { pending: ['JUKECORD_PORT'], supervisor: 'docker', refusal: null },
    });
    assert.equal(
      shown,
      [
        'Server and network',
        '  JUKECORD_PORT           8796  [saved, after a restart (now 8795)]',
        '',
        'Discord',
        '  JUKECORD_DISCORD_TOKEN  set  [environment (JUKECORD_DISCORD_TOKEN_FILE)]',
        '',
        'Waiting for a restart: JUKECORD_PORT (jukecord restart)',
      ].join('\n'),
    );
  });
});
