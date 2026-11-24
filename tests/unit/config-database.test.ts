/**
 * The database's settings (JUKECORD_DATABASE_URL, its _FILE, JUKECORD_DATABASE_POOL) and the wait at a start for a
 * server that does not answer yet, as the settings and src/store/open.ts read and do them. No database server is
 * needed: the server that does not answer is a port nothing listens on.
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ConfigError, type ConfigFiles, describeConfig, loadConfig } from '../../src/config.ts';
import { parseDatabaseAddress } from '../../src/store/address.ts';
import { ConnectionError } from '../../src/store/network.ts';
import { openExecutor } from '../../src/store/open.ts';

// Files a test gives the settings to read, by path.
function files(named: Record<string, string>): ConfigFiles {
  const known = new Map(Object.entries(named));
  return { read: (file) => known.get(file) ?? '', readable: (file) => known.has(file) };
}

// A server on this machine that cuts every connection at once, as a database restarting does: held for the test, so
// its port cannot be taken by another test's server meanwhile (a port let go and dialled later could be).
async function cuttingServer(): Promise<{ port: number; close(): Promise<void> }> {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('the database settings', () => {
  it('keep the data in the data folder’s SQLite file when nothing is set', () => {
    const config = loadConfig({ JUKECORD_DATA_DIR: '/data' }, '/');
    assert.deepEqual(config.database, {
      address: { kind: 'sqlite', file: path.join(path.resolve('/data'), 'jukecord.db') },
      pool: 10,
    });
    assert.equal(describeConfig(config).database, `SQLite (${path.join(path.resolve('/data'), 'jukecord.db')})`);
  });

  it('read a server’s address and the pool, and print where it is without the user or the password', () => {
    const config = loadConfig(
      {
        JUKECORD_DATABASE_URL: 'postgres://listener:hunter2@db.example.com:5432/jukecord?sslmode=verify-full',
        JUKECORD_DATABASE_POOL: '4',
      },
      '/',
    );
    assert.equal(config.database.address.kind, 'postgres');
    assert.equal(config.database.pool, 4);
    const printed = describeConfig(config);
    assert.equal(printed.database, 'PostgreSQL (db.example.com:5432, database jukecord, TLS verify-full)');
    assert.equal(printed['database connections'], 'up to 4');
    assert.doesNotMatch(JSON.stringify(printed), /hunter2|listener/);
  });

  it('read the address from a file named by JUKECORD_DATABASE_URL_FILE, as the other secrets', () => {
    const config = loadConfig(
      { JUKECORD_DATABASE_URL_FILE: '/run/secrets/database' },
      '/',
      files({ '/run/secrets/database': 'mysql://music:hunter2@db/jukecord\n' }),
    );
    assert.deepEqual(
      config.database.address.kind === 'mysql' ? [config.database.address.password, config.database.address.host] : [],
      ['hunter2', 'db'],
    );
    assert.throws(
      () =>
        loadConfig(
          { JUKECORD_DATABASE_URL: 'sqlite:', JUKECORD_DATABASE_URL_FILE: '/run/x' },
          '/',
          files({ '/run/x': 'sqlite:' }),
        ),
      /set JUKECORD_DATABASE_URL or JUKECORD_DATABASE_URL_FILE, not both/,
    );
  });

  it('refuse an address they cannot use, naming the setting and never the password', () => {
    const refused = (env: Record<string, string>, reason: RegExp) =>
      assert.throws(
        () => loadConfig(env, '/'),
        (error: unknown) =>
          error instanceof ConfigError && reason.test(error.message) && !/hunter2/.test(error.message),
      );
    refused({ JUKECORD_DATABASE_URL: 'postgres://music:hunter2@db' }, /JUKECORD_DATABASE_URL names no database/);
    refused({ JUKECORD_DATABASE_URL: 'mongodb://music:hunter2@db/j' }, /JUKECORD_DATABASE_URL starts with mongodb:/);
    refused({ JUKECORD_DATABASE_URL: 'postgres://music:hunter2@db/j?sslmode=prefer' }, /sslmode=prefer/);
    refused({ JUKECORD_DATABASE_POOL: '0' }, /JUKECORD_DATABASE_POOL: 0 is outside 1-100/);
  });
});

describe('opening a database server', () => {
  it('waits for one that does not answer yet, saying why each time, and gives up with the reason', async () => {
    const server = await cuttingServer();
    try {
      const address = parseDatabaseAddress(`postgres://music:hunter2@127.0.0.1:${server.port}/jukecord`, '/');
      const said: string[] = [];
      const log = {
        info: () => {},
        warn: (message: string, fields?: Readonly<Record<string, unknown>>) =>
          said.push(`${message}: ${String(fields?.reason)}`),
        error: () => {},
      };
      const started = Date.now();
      await assert.rejects(
        () => openExecutor(address, { waitMs: 1600, log }),
        (error: unknown) =>
          error instanceof ConnectionError &&
          error.message.startsWith(`PostgreSQL (127.0.0.1:${server.port}, database jukecord, without TLS): `) &&
          /cut the connection/.test(error.message) &&
          !error.message.includes('hunter2'),
      );
      // Tried again at least once (after half a second, then a second: how many fit in the wait depends on how fast
      // this machine answers), each time saying why.
      assert.ok(said.length >= 1, 'it tried again');
      for (const line of said) assert.match(line, /does not answer yet; trying again: .*cut the connection/);
      assert.ok(Date.now() - started >= 500, 'it waited');
    } finally {
      await server.close();
    }
  });

  it('does not wait out what waiting cannot mend: a certificate file that is not there', async () => {
    const address = parseDatabaseAddress(
      'mysql://music@127.0.0.1:1/jukecord?ssl-mode=VERIFY_CA&ssl-ca=/nowhere/ca.pem',
      '/',
    );
    const started = Date.now();
    await assert.rejects(() => openExecutor(address, { waitMs: 10_000 }), /sslrootcert\) file \/nowhere\/ca\.pem/);
    assert.ok(Date.now() - started < 1000, 'it gave up at once');
  });
});
