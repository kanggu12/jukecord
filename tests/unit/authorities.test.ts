/**
 * The host's own certificate authorities (JUKECORD_CA_FILE, src/authorities.ts): read and checked with the settings,
 * and once trusted, trusted by every client jukecord connects with that is given no authority of its own, and not by
 * one that is (a database's sslrootcert, the directory's JUKECORD_LDAP_CA_FILE). Against servers whose certificates an
 * authority made for the test signed: before it is trusted every client refuses them, after it every one gets
 * through: Node's TLS, fetch (Discord's, the provider's and jukecord's own requests), OIDC discovery through
 * openid-client, ldapts, the database drivers' options (pg's, and mysql2's own secure context), and @redis/client over
 * rediss:// when a test server is named (JUKECORD_TEST_BUS_URL, through a TLS proxy made here). The steps run in
 * order, in this file's own process: the trust is the process's.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import tls from 'node:tls';
import { Client } from 'ldapts';
import { OidcLogin } from '../../src/auth/oidc.ts';
import type { OidcSettings } from '../../src/auth/settings.ts';
import { certificatesIn, describeAuthorities, readAuthorities, trustAuthorities } from '../../src/authorities.ts';
import { RedisTransport } from '../../src/bus/redis.ts';
import { MemoryCache } from '../../src/cache/memory.ts';
import { openCache } from '../../src/cache/open.ts';
import { ConfigError, describeConfig, loadConfig } from '../../src/config.ts';
import { parseDatabaseAddress, type ServerAddress } from '../../src/store/address.ts';
import { tlsOptions } from '../../src/store/network.ts';
import { eventually, TEST_BUS_URL, testLog } from '../support/bus.ts';
import { FakeProvider } from '../support/oidc.ts';
import { haveOpenssl, httpsServer, type TestAuthority, testAuthority, tlsServer, verifies } from '../support/tls.ts';

const openssl = haveOpenssl();

describe("the host's certificate authorities (JUKECORD_CA_FILE)", {
  skip: !openssl && 'openssl is not installed',
}, () => {
  // The authority the host trusts, and another one, which signed nothing the tests connect to.
  let authority: TestAuthority;
  let stranger: TestAuthority;
  // The servers its certificate is on: a plain HTTPS one, an OIDC provider's, a directory's that hangs up after the
  // handshake, and a TLS proxy in front of the test Valkey (when one is named).
  let web: Awaited<ReturnType<typeof httpsServer>>;
  let sso: Awaited<ReturnType<typeof httpsServer>>;
  let directory: Awaited<ReturnType<typeof tlsServer>>;
  let valkey: Awaited<ReturnType<typeof tlsServer>> | null = null;
  let provider: FakeProvider;

  before(async () => {
    authority = testAuthority('jukecord-test-ca');
    stranger = testAuthority('jukecord-test-stranger');
    // A plain HTTPS server, which answers the jukecord command's status as jukecord's API does.
    web = await httpsServer(authority, (request, response) => {
      if (request.url === '/api/v1/status') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ version: '0.4.0', mode: 'browser-only', discord: false, uptimeMs: 1 }));
        return;
      }
      response.end('hello');
    });
    // The provider's documents over real HTTPS (its fetch answers them, as in the login tests).
    sso = await httpsServer(authority, (request, response) => {
      void provider.fetch(new Request(`https://localhost:${sso.port}${request.url}`)).then(async (answer) => {
        response.writeHead(answer.status, Object.fromEntries(answer.headers));
        response.end(Buffer.from(await answer.arrayBuffer()));
      });
    });
    provider = new FakeProvider(`https://localhost:${sso.port}/realms/home`);
    directory = await tlsServer(authority, (socket) => socket.end());
    const bus = TEST_BUS_URL ? new URL(TEST_BUS_URL) : null;
    if (bus) {
      valkey = await tlsServer(authority, (socket) => {
        const upstream = net.connect(Number(bus.port || 6379), bus.hostname);
        upstream.on('error', () => socket.destroy());
        // Gone on either side, gone on both: a pipe passes an end on, not a connection that closed.
        socket.on('close', () => upstream.destroy());
        upstream.on('close', () => socket.destroy());
        socket.pipe(upstream).pipe(socket);
      });
    }
  });

  after(async () => {
    await Promise.all([web.close(), sso.close(), directory.close(), valkey?.close()]);
    authority.remove();
    stranger.remove();
  });

  // The provider's settings as jukecord takes them, its issuer on the test's server.
  const settings = (): OidcSettings => ({
    issuer: provider.issuer,
    clientId: 'jukecord',
    clientSecret: null,
    scopes: ['openid'],
    groupsClaim: 'groups',
    groups: { admin: ['*'], control: [], read: [] },
    label: null,
    discordClaim: null,
  });
  // A login through the provider started as jukecord starts one: its discovery over the network, with Node's fetch.
  const startLogin = () =>
    new OidcLogin({
      settings: settings(),
      redirectUri: 'https://jukecord.test/auth/sso/callback',
      afterLogout: 'https://jukecord.test/login',
      cache: new MemoryCache(),
      log: testLog().log,
    }).start('/');
  // A bind with ldapts as the directory login opens its connection (its tlsOptions: the name, TLS 1.2 at least, and no
  // authority of its own when JUKECORD_LDAP_CA_FILE is not set): the error it ends with.
  const bindDirectory = async (): Promise<string> => {
    const client = new Client({
      url: `ldaps://localhost:${directory.port}`,
      tlsOptions: { servername: 'localhost', minVersion: 'TLSv1.2' },
      connectTimeout: 2000,
      timeout: 2000,
    });
    try {
      await client.bind('cn=jukecord,dc=example,dc=org', 'secret');
      return 'bound';
    } catch (error) {
      const failure = error as NodeJS.ErrnoException;
      return String(failure.code ?? failure.message);
    } finally {
      await client.unbind().catch(() => {});
    }
  };
  // The bus over rediss:// through the TLS proxy, as an edge or the core opens it.
  const openBus = () =>
    RedisTransport.open(`rediss://localhost:${valkey?.port}`, { log: testLog().log, service: 'ca-test', waitMs: 1500 });
  // What the database drivers are given for an address without sslrootcert, as src/store/network.ts makes it.
  const databaseOptions = (url: string): tls.ConnectionOptions =>
    (tlsOptions(parseDatabaseAddress(url, '/srv') as ServerAddress)?.options ?? {}) as tls.ConnectionOptions;

  it('reads every certificate of a PEM file, and says what is wrong with one that has none or a broken one', () => {
    const two = certificatesIn(`# a bundle\n${authority.ca}\n${stranger.ca}`);
    assert.ok('certificates' in two && two.certificates.length === 2);
    assert.deepEqual(certificatesIn('nothing here'), {
      problem: 'has no certificate in PEM form (-----BEGIN CERTIFICATE-----)',
    });
    const cut = certificatesIn(`-----BEGIN CERTIFICATE-----\nMIIBroken\n-----END CERTIFICATE-----\n${authority.ca}`);
    assert.ok(
      'problem' in cut && /^has a certificate that cannot be read \(the first: /.test(cut.problem),
      JSON.stringify(cut),
    );
    assert.equal(
      readAuthorities('missing.pem', authority.dir).problem,
      `JUKECORD_CA_FILE: ${path.join(authority.dir, 'missing.pem')} cannot be read`,
    );
    assert.deepEqual(readAuthorities(null, authority.dir), { authorities: null, problem: null });
  });

  it('is checked with the other settings, and named in them with how many it adds', () => {
    const empty = path.join(authority.dir, 'empty.pem');
    fs.writeFileSync(empty, '\n');
    const problems = (file: string): string => {
      try {
        loadConfig({ JUKECORD_CA_FILE: file }, '/srv');
        return 'accepted';
      } catch (error) {
        assert.ok(error instanceof ConfigError);
        return error.message;
      }
    };
    assert.match(problems('/nowhere/ca.pem'), /JUKECORD_CA_FILE: \/nowhere\/ca\.pem cannot be read/);
    assert.match(problems(empty), /JUKECORD_CA_FILE: .*empty\.pem has no certificate in PEM form/);
    const config = loadConfig({ JUKECORD_CA_FILE: authority.caFile }, '/srv');
    assert.equal(config.ca?.certificates.length, 1);
    assert.equal(
      describeConfig(config)['certificate authorities'],
      `1 extra authority from ${authority.caFile}, besides Node's own`,
    );
    assert.equal(describeConfig(loadConfig({}, '/srv'))['certificate authorities'], "Node's own");
    // Nothing is trusted by reading it: that is the start's to do.
    assert.equal(describeAuthorities(null), "Node's own");
  });

  it('is trusted by the jukecord command before it connects, and a file it cannot use is said as the settings say it', async () => {
    // The command as a program of its own (its entry trusts the file), against an API at an https:// address; run
    // without blocking, as the API's server is this process's own.
    const status = (caFile: string | null, envFile?: string) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(
          process.execPath,
          [
            ...(envFile ? [`--env-file=${envFile}`] : []),
            '--disable-warning=ExperimentalWarning',
            'src/cli/main.ts',
            '--json',
            'status',
            '--url',
            `https://localhost:${web.port}`,
          ],
          {
            env: {
              PATH: process.env.PATH ?? '',
              JUKECORD_TOKEN: 'jkc_test',
              ...(caFile ? { JUKECORD_CA_FILE: caFile } : {}),
            },
          },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        child.on('close', (code) => resolve({ code, stdout, stderr }));
      });
    const trusted = await status(authority.caFile);
    assert.equal(trusted.code, 0, trusted.stderr);
    assert.equal(JSON.parse(trusted.stdout).mode, 'browser-only');
    // Named in a .env that Node reads (--env-file, as the programs' launcher runs jukecord): jukecord reads the setting
    // itself, so it takes effect, where Node's own NODE_EXTRA_CA_CERTS from such a file would not.
    const settings = path.join(authority.dir, '.env');
    fs.writeFileSync(settings, `JUKECORD_CA_FILE=${authority.caFile}\n`);
    assert.equal((await status(null, settings)).code, 0);
    // Without it the API's certificate is nobody's: jukecord did not answer (3).
    assert.equal((await status(null)).code, 3);
    const wrong = await status('/nowhere/ca.pem');
    assert.equal(wrong.code, 2);
    assert.match(wrong.stderr, /^jukecord: JUKECORD_CA_FILE: \/nowhere\/ca\.pem cannot be read/);
  });

  it('leaves every client unable to check a server the authority signed, before it is trusted', async () => {
    assert.equal(await verifies(web.port), 'UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    await assert.rejects(fetch(`https://localhost:${web.port}/`), (error: Error) => {
      assert.equal((error.cause as NodeJS.ErrnoException).code, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE');
      return true;
    });
    await assert.rejects(startLogin(), /discovery document could not be read/);
    assert.equal(await bindDirectory(), 'UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    assert.equal(
      await verifies(web.port, databaseOptions('postgres://j@localhost/j?sslmode=verify-full')),
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    );
    if (valkey) await assert.rejects(openBus(), /could not reach Redis/);
  });

  it("is trusted by every client once added; a connection's own authority is still the only one it trusts", async () => {
    const read = readAuthorities(authority.caFile, authority.dir);
    assert.ok(read.authorities);
    assert.equal(trustAuthorities(read.authorities), 1);
    // Node's TLS: with no authority given, with `ca` there but undefined, and through a secure context made with an
    // undefined `ca` (mysql2 makes its own so).
    assert.equal(await verifies(web.port), 'ok');
    assert.equal(await verifies(web.port, { ca: undefined }), 'ok');
    assert.equal(await verifies(web.port, { secureContext: tls.createSecureContext({ ca: undefined }) }), 'ok');
    // The database's options without sslrootcert carry no authority (what pg hands tls.connect), and pass.
    const database = databaseOptions('postgres://j@localhost/j?sslmode=verify-full');
    assert.equal('ca' in database, false);
    assert.equal(await verifies(web.port, database), 'ok');
    // A connection given its own authority (sslrootcert, JUKECORD_LDAP_CA_FILE) trusts that one alone; an empty list
    // is no authority at all, which no client of jukecord's passes.
    assert.equal(await verifies(web.port, { ca: stranger.ca }), 'UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    assert.equal(await verifies(web.port, { ca: [] }), 'UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    // fetch, which Discord's REST, the provider's requests and the command line use.
    assert.equal(await (await fetch(`https://localhost:${web.port}/`)).text(), 'hello');
    // The provider found through its discovery document: the login starts, off to its authorization endpoint.
    const started = await startLogin();
    assert.ok(started.location.startsWith(`${provider.issuer}/protocol/openid-connect/auth?`), started.location);
    // The directory: the handshake passes now (the server then hangs up, which is all it does).
    assert.doesNotMatch(await bindDirectory(), /CERT|VERIFY|SIGNATURE/);
    if (valkey) {
      const bus = await openBus();
      try {
        const heard: string[] = [];
        await bus.subscribe('jukecord-ca-test', (message) => heard.push(message));
        await bus.publish('jukecord-ca-test', 'over rediss');
        await eventually(() => heard.includes('over rediss'), 'a message over rediss://');
        const cache = await openCache({
          url: `rediss://localhost:${valkey.port}`,
          prefix: 'jukecord-ca-test',
          log: testLog().log,
          service: 'ca-test',
          waitMs: 1500,
        });
        await cache.set('k', 'v', 10_000);
        assert.equal(await cache.get('k'), 'v');
        await cache.close();
      } finally {
        await bus.close();
      }
    }
  });

  it('keeps what NODE_EXTRA_CA_CERTS adds, as the list it extends is the default one', () => {
    // A process that trusts the stranger through NODE_EXTRA_CA_CERTS and the authority through JUKECORD_CA_FILE: a
    // server of each verifies.
    const script = `
      import tls from 'node:tls';
      import { readAuthorities, trustAuthorities } from ${JSON.stringify(path.resolve('src/authorities.ts'))};
      const read = readAuthorities(process.env.JUKECORD_CA_FILE, process.cwd());
      trustAuthorities(read.authorities);
      const pems = tls.getCACertificates('default');
      const has = (pem) => pems.some((one) => one.replace(/\\s/g, '') === pem.replace(/\\s/g, ''));
      console.log(JSON.stringify({ extra: has(process.env.STRANGER), own: has(process.env.AUTHORITY) }));
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: {
        PATH: process.env.PATH ?? '',
        NODE_EXTRA_CA_CERTS: stranger.caFile,
        JUKECORD_CA_FILE: authority.caFile,
        STRANGER: stranger.ca,
        AUTHORITY: authority.ca,
      },
      encoding: 'utf8',
    });
    assert.deepEqual(JSON.parse(out.trim().split('\n').at(-1) ?? '{}'), { extra: true, own: true });
  });
});
