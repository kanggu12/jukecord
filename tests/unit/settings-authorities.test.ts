/**
 * The host's certificate authorities on the settings page and in the API: a PEM checked before it is taken (an
 * authority's certificate at least, never a key, nothing else), kept in the data folder as a file of its own (0600)
 * that settings.json names, applied at the next start, removed in one go; locked where the environment sets it; and
 * the tests of an address that trust a PEM not saved yet (refused without it, reached with it, a hint to the setting
 * when refused). The authorities are made by openssl at run time (tests/support/tls.ts); the tests are skipped
 * without it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { LoginChecks } from '../../src/auth/check.ts';
import { loadConfig } from '../../src/config.ts';
import {
  certificateFacts,
  checkAuthorities,
  forgetAuthorities,
  keepAuthorities,
} from '../../src/settings/authorities.ts';
import { readSettingsFile, SETTINGS_FILE, SettingsFile } from '../../src/settings/file.ts';
import { ONE_PROCESS } from '../../src/settings/layers.ts';
import { testServer } from '../../src/settings/servers.ts';
import { HostSettings, SettingsRefused } from '../../src/settings/service.ts';
import { parseDatabaseAddress } from '../../src/store/address.ts';
import { tlsOptions } from '../../src/store/network.ts';
import type { Store } from '../../src/store/store.ts';
import { API_PREFIX } from '../../src/web/api.ts';
import { TEST_BUS_URL, testLog } from '../support/bus.ts';
import { memoryStore, slowMemoryStore } from '../support/store.ts';
import { haveOpenssl, httpsServer, type TestAuthority, testAuthority, tlsServer } from '../support/tls.ts';
import { asHost, testServer as webServer } from '../support/web.ts';

const api = (url: string) => `${API_PREFIX}${url}`;
const skip = !haveOpenssl() && 'openssl is not installed';

describe('certificate authorities on the settings page', { skip }, () => {
  let authority: TestAuthority;
  let other: TestAuthority;
  before(() => {
    authority = testAuthority('jukecord-test-root');
    other = testAuthority('jukecord-test-other');
  });
  after(() => {
    authority.remove();
    other.remove();
  });

  it('takes a bundle with an authority’s certificate, and says why it refuses anything else', () => {
    // Taken: the authority, a bundle's comment lines around it, and a server's certificate beside it.
    const bundle = `# the home network's root\n${authority.ca}\n${authority.cert}`;
    const taken = checkAuthorities(bundle);
    assert.ok('certificates' in taken);
    assert.equal(taken.certificates.length, 2);
    const refused = (text: string) => {
      const checked = checkAuthorities(text);
      return 'problem' in checked ? checked.problem : 'taken';
    };
    // A private key, whatever its kind, by name; anything else that is not a certificate; no certificate at all;
    // one that cannot be read; servers' certificates alone; too much.
    assert.equal(
      refused(`${authority.ca}\n${authority.key}`),
      'it holds a private key: give only the authorities’ certificates, never a key',
    );
    assert.equal(
      refused(`${authority.ca}\n-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n`),
      'it holds something other than certificates (PUBLIC KEY)',
    );
    assert.equal(
      refused('not a certificate at all'),
      'it has no certificate in PEM form (-----BEGIN CERTIFICATE-----)',
    );
    assert.match(
      refused('-----BEGIN CERTIFICATE-----\nnot base64 of a certificate\n-----END CERTIFICATE-----'),
      /^it has a certificate that cannot be read \(the first: /,
    );
    assert.equal(
      refused(authority.cert),
      'it has no authority’s certificate (CA:TRUE): a server’s or a person’s certificate signs nothing',
    );
    assert.equal(refused(`${authority.ca}\n${'#'.repeat(1024 * 1024)}`), 'the certificates are larger than 1 MiB');
  });

  it('says whose each certificate is, who signed it and until when', () => {
    const [root, server] = certificateFacts([authority.ca, authority.cert]);
    assert.deepEqual(
      [root?.subject, root?.issuer, root?.authority],
      ['CN=jukecord-test-root', 'CN=jukecord-test-root', true],
    );
    assert.deepEqual(
      [server?.subject, server?.issuer, server?.authority],
      ['CN=localhost', 'CN=jukecord-test-root', false],
    );
    // Made for a day: it holds until tomorrow, from about now.
    assert.ok(Date.parse(root?.validTo ?? '') > Date.now());
    assert.match(root?.fingerprint ?? '', /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });

  it('keeps the certificates in a file of their own, 0600, named by what is in it, and forgets the old ones', () => {
    const dataDir = fs.mkdtempSync(path.join(authority.dir, 'data-'));
    const first = keepAuthorities(dataDir, [authority.ca]);
    // Windows keeps no POSIX modes (every file reads 0o666); the 0600 is checked where there is one.
    if (process.platform !== 'win32') assert.equal(fs.statSync(first).mode & 0o777, 0o600);
    assert.match(path.basename(first), /^authorities-[0-9a-f]{16}\.pem$/);
    // The same certificates are the same file; others another one.
    assert.equal(keepAuthorities(dataDir, [authority.ca]), first);
    const second = keepAuthorities(dataDir, [other.ca]);
    assert.notEqual(second, first);
    // A file of the host's own beside them is never touched.
    fs.writeFileSync(path.join(dataDir, 'my-ca.pem'), other.ca);
    forgetAuthorities(dataDir, second);
    assert.deepEqual(fs.readdirSync(dataDir).sort(), [path.basename(second), 'my-ca.pem'].sort());
  });

  it('imports through the API: the file kept, settings.json naming it, waiting for a restart; removed in one go', async () => {
    const server = await webServer({ hostSettings: {} });
    try {
      const imported = await server.web.app.inject({
        method: 'PUT',
        url: api('/settings/authorities'),
        headers: asHost,
        payload: { pem: authority.ca },
      });
      assert.equal(imported.statusCode, 200, imported.body);
      const view = imported.json().view;
      const file = view.authorities.file as string;
      assert.equal(path.dirname(file), server.dataDir);
      // Windows keeps no POSIX modes (every file reads 0o666); the 0600 is checked where there is one.
      if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.deepEqual(
        [
          view.authorities.source,
          view.authorities.kept,
          view.authorities.pending,
          view.authorities.certificates.length,
        ],
        ['saved', true, true, 1],
      );
      assert.ok(view.restart.pending.includes('JUKECORD_CA_FILE'));
      // In settings.json, as every bootstrap setting.
      const saved = JSON.parse(fs.readFileSync(path.join(server.dataDir, SETTINGS_FILE), 'utf8'));
      assert.equal(saved.settings.JUKECORD_CA_FILE.value, file);
      // Other authorities: another file, the first gone.
      const again = await server.web.app.inject({
        method: 'PUT',
        url: api('/settings/authorities'),
        headers: asHost,
        payload: { pem: other.ca },
      });
      const second = again.json().view.authorities.file as string;
      assert.notEqual(second, file);
      assert.equal(fs.existsSync(file), false);
      // A key is refused, said by the setting, and nothing changes.
      const keyed = await server.web.app.inject({
        method: 'PUT',
        url: api('/settings/authorities'),
        headers: asHost,
        payload: { pem: `${authority.ca}${authority.key}` },
      });
      assert.equal(keyed.statusCode, 400);
      assert.deepEqual(keyed.json().error.problems[0].names, ['JUKECORD_CA_FILE']);
      assert.equal(
        (await server.web.app.inject({ method: 'GET', url: api('/settings/authorities'), headers: asHost })).json()
          .file,
        second,
      );
      // Removed: the setting back to none, the page's file gone.
      const removed = await server.web.app.inject({
        method: 'DELETE',
        url: api('/settings/authorities'),
        headers: asHost,
      });
      assert.equal(removed.statusCode, 200);
      assert.equal(removed.json().view.authorities.file, null);
      assert.equal(fs.existsSync(second), false);
    } finally {
      await server.close();
    }
  });

  // The host's settings over a store, in a data folder of their own; what settings.json names for the authorities,
  // and the files the page keeps beside it.
  async function service(store?: Store, answerMs?: number) {
    const dataDir = fs.mkdtempSync(path.join(authority.dir, 'data-'));
    const env = { JUKECORD_DATA_DIR: dataDir };
    const settings = new HostSettings({
      env,
      cwd: dataDir,
      store: store ?? (await memoryStore()),
      file: new SettingsFile(dataDir),
      rules: ONE_PROCESS,
      started: loadConfig(env, dataDir),
      supervisor: 'none',
      log: testLog().log,
      apply: () => {},
      ...(answerMs !== undefined ? { answerMs } : {}),
    });
    return { settings, dataDir };
  }
  const named = (dataDir: string) => readSettingsFile(dataDir).get('JUKECORD_CA_FILE')?.value ?? null;
  const kept = (dataDir: string) => fs.readdirSync(dataDir).filter((name) => name.startsWith('authorities-'));

  it('keeps the file settings.json names when imports and a removal come at once', async () => {
    const { settings, dataDir } = await service();
    // Two imports at once: one after the other, the last one's file named, there, and the only one kept.
    await Promise.all([settings.importAuthorities(authority.ca), settings.importAuthorities(other.ca)]);
    const last = named(dataDir);
    assert.ok(last !== null && fs.existsSync(last), `${last} is not there`);
    assert.deepEqual(kept(dataDir), [path.basename(last)]);
    // An import and a removal at once, in either order: what the last one leaves is what settings.json says.
    await Promise.all([settings.importAuthorities(authority.ca), settings.removeAuthorities()]);
    assert.deepEqual([named(dataDir), kept(dataDir)], [null, []]);
    await Promise.all([settings.removeAuthorities(), settings.importAuthorities(other.ca)]);
    const again = named(dataDir);
    assert.ok(again !== null && fs.existsSync(again), `${again} is not there`);
    assert.deepEqual(kept(dataDir), [path.basename(again)]);
  });

  it('keeps the file of an import whose save the database answers after the page stopped waiting', async () => {
    // Every read of the saved settings held until let go (the change reads them first): the page is told the database
    // does not answer.
    let holding = true;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = await slowMemoryStore(undefined, (what) =>
      holding && what.includes('FROM host_settings') ? gate : undefined,
    );
    const { settings, dataDir } = await service(store, 200);
    await assert.rejects(settings.importAuthorities(authority.ca), /the database does not answer/);
    holding = false;
    release();
    // The save lands later, naming the file, which is there.
    for (let tries = 0; tries < 200 && named(dataDir) === null; tries += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const file = named(dataDir);
    assert.ok(file !== null && fs.existsSync(file), `${file} is not there`);
    assert.deepEqual(kept(dataDir), [path.basename(file)]);
  });

  it('holds authorities named by hand to the import’s checks: a key or no authority refused, nothing saved', async () => {
    const { settings, dataDir } = await service();
    const write = (name: string, text: string) => {
      const file = path.join(dataDir, name);
      fs.writeFileSync(file, text);
      return file;
    };
    for (const [file, problem] of [
      [
        write('with-a-key.pem', `${authority.ca}\n${authority.key}`),
        'JUKECORD_CA_FILE: it holds a private key: give only the authorities’ certificates, never a key',
      ],
      [
        write('a-server-only.pem', authority.cert),
        'JUKECORD_CA_FILE: it has no authority’s certificate (CA:TRUE): a server’s or a person’s certificate signs nothing',
      ],
    ] as const) {
      const refused = await settings.change({ JUKECORD_CA_FILE: file }).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(refused instanceof SettingsRefused, `${file} was taken`);
      assert.deepEqual(
        (refused.problems ?? []).map((entry) => entry.message),
        [problem],
      );
    }
    assert.equal(named(dataDir), null);
    // An authority's certificate, named by hand: taken, and the page never removes it.
    const mine = write('home-root.pem', authority.ca);
    await settings.change({ JUKECORD_CA_FILE: mine });
    assert.equal(named(dataDir), mine);
    await settings.removeAuthorities();
    assert.ok(fs.existsSync(mine));
  });

  it('leaves authorities the environment sets as they are: shown, never changed from the page', async () => {
    const server = await webServer({ hostSettings: { env: { JUKECORD_CA_FILE: authority.caFile } } });
    try {
      const shown = (
        await server.web.app.inject({ method: 'GET', url: api('/settings/authorities'), headers: asHost })
      ).json();
      assert.deepEqual(
        [shown.source, shown.variable, shown.locked, shown.kept, shown.certificates[0]?.subject],
        ['environment', 'JUKECORD_CA_FILE', 'environment', false, 'CN=jukecord-test-root'],
      );
      for (const [method, payload] of [
        ['PUT', { pem: other.ca }],
        ['DELETE', undefined],
      ] as const) {
        const refused = await server.web.app.inject({
          method,
          url: api('/settings/authorities'),
          headers: asHost,
          ...(payload ? { payload } : {}),
        });
        assert.equal(refused.statusCode, 409, `${method}: ${refused.body}`);
      }
    } finally {
      await server.close();
    }
  });

  it('lets a test trust a PEM not saved yet: refused without it, with a hint to the setting, and reached with it', async () => {
    // An identity provider on a certificate the test's authority signed.
    const provider = await httpsServer(authority, (request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ issuer: `https://127.0.0.1:${(request.socket.localPort ?? 0).toString()}` }));
    });
    // The login tests as main.ts makes them, on the process's own fetch (the default authorities), nothing else set.
    const server = await webServer({
      hostSettings: {},
      loginChecks: new LoginChecks({
        env: {},
        cwd: '/srv',
        redirectUri: 'http://localhost:8795/auth/sso/callback',
        afterLogout: 'http://localhost:8795/login',
        log: testLog().log,
      }),
    });
    try {
      const settings = {
        JUKECORD_OIDC_ISSUER: `https://127.0.0.1:${provider.port}`,
        JUKECORD_OIDC_CLIENT_ID: 'jukecord',
        JUKECORD_OIDC_READ_GROUPS: '*',
      };
      const test = async (ca?: string) =>
        (
          await server.web.app.inject({
            method: 'POST',
            url: api('/auth/test-oidc'),
            headers: asHost,
            payload: { settings, ...(ca ? { ca } : {}) },
          })
        ).json() as { checks: { name: string; status: string; detail: string }[] };
      // Without it: the certificate leads to no authority this process trusts, and the setting is named.
      const without = await test();
      assert.match(without.checks[0]?.detail ?? '', /name its certificate in JUKECORD_CA_FILE/);
      // With it: past TLS, to what the provider answered (its document is not a whole one, which is said instead).
      const withIt = await test(authority.ca);
      assert.doesNotMatch(JSON.stringify(withIt.checks), /JUKECORD_CA_FILE|certificate/i);
      // A PEM that is no authority's is refused as an import would be.
      const keyed = await server.web.app.inject({
        method: 'POST',
        url: api('/auth/test-oidc'),
        headers: asHost,
        payload: { settings, ca: authority.key },
      });
      assert.equal(keyed.statusCode, 400);
    } finally {
      await server.close();
      await provider.close();
    }
  });

  it('gives a database test the list in place of the default, never over the address’s own root certificate', () => {
    const trust = ['-----BEGIN CERTIFICATE-----\nA\n-----END CERTIFICATE-----'];
    const plain = parseDatabaseAddress('postgres://jukecord@db.example/jukecord?sslmode=verify-full', authority.dir);
    assert.deepEqual(tlsOptions(plain as never, trust)?.options.ca, trust);
    // What the address asks for stays: require checks nothing, with a list or without.
    const required = parseDatabaseAddress('postgres://jukecord@db.example/jukecord?sslmode=require', authority.dir);
    assert.equal(tlsOptions(required as never, trust)?.verify, 'none');
    // An address with its own root certificate keeps it alone.
    const own = parseDatabaseAddress(
      `postgres://jukecord@db.example/jukecord?sslmode=verify-ca&sslrootcert=${encodeURIComponent(authority.caFile)}`,
      authority.dir,
    );
    assert.equal(tlsOptions(own as never, trust)?.options.ca, authority.ca);
  });

  it('lets the cache’s and the bus’s test reach a server over TLS with a PEM not saved yet', {
    skip: !TEST_BUS_URL && 'JUKECORD_TEST_BUS_URL is not set',
  }, async () => {
    // TLS in front of the test's Valkey, on a certificate the test's authority signed.
    const target = new URL(TEST_BUS_URL ?? '');
    const front = await tlsServer(authority, (socket) => {
      const upstream = net.connect(Number(target.port || 6379), target.hostname);
      socket.pipe(upstream).pipe(socket);
      // Either side gone takes the other with it (a connection left to the server would keep the test running).
      for (const [one, other] of [
        [socket, upstream],
        [upstream, socket],
      ] as const) {
        one.on('error', () => other.destroy());
        one.on('close', () => other.destroy());
      }
    });
    try {
      const url = `rediss://${target.password ? `:${target.password}@` : ''}localhost:${front.port}`;
      const without = await testServer(url, 'cache');
      assert.equal(without.ok, false);
      assert.match(String(without.problem), /name its certificate in JUKECORD_CA_FILE/);
      const withIt = await testServer(url, 'bus', [authority.ca]);
      assert.equal(withIt.ok, true, String(withIt.problem));
    } finally {
      await front.close();
    }
  });
});
