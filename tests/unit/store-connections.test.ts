/**
 * A server's connections lost under jukecord, on each server of JUKECORD_TEST_DATABASES: ended by the server between
 * two statements of a transaction (an administrator, a restart, a failover), cut in the middle of a statement (a
 * reset), or gone quiet (a NAT or a firewall that dropped it without a word). Each fails the transaction or the
 * statement that held it as a ConnectionError, the process goes on, and the next statement runs on a new connection.
 * Also: TCP keep-alive from 10 s of quiet on every connection, as the system shows it, and a PostgreSQL schema made
 * once when two jukecords open a new one at the same moment. SQLite's file has no connection to lose.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { it } from 'node:test';
import type { ServerAddress } from '../../src/store/address.ts';
import { ConnectionError } from '../../src/store/network.ts';
import { openExecutor, openStore } from '../../src/store/open.ts';
import type { SqlExecutor } from '../../src/store/sql.ts';
import { eachDatabase, type TestDatabase } from '../support/databases.ts';
import { TcpProxy } from '../support/proxy.ts';

// The reason the tests of a lost connection do not run on SQLite.
const NO_CONNECTION = 'a SQLite file has no connection to lose';

// Waits `ms` milliseconds.
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// What a promise ended with: its error, or null when it worked.
const failureOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

// The test's server database's address (the tests here are the servers').
async function serverAddress(db: TestDatabase): Promise<ServerAddress> {
  const address = await db.address();
  if (address.kind === 'sqlite') throw new Error('a server database was expected');
  return address;
}

// The server's number for the connection a statement runs on.
async function connectionId(sql: SqlExecutor): Promise<number> {
  const row = await sql.get(
    sql.dialect === 'postgres' ? 'SELECT pg_backend_pid() AS id' : 'SELECT CONNECTION_ID() AS id',
  );
  return Number(row?.id);
}

// Ends a connection from another one, as an administrator (or the server stopping) does.
async function endConnection(admin: SqlExecutor, id: number): Promise<void> {
  if (admin.dialect === 'postgres') await admin.get('SELECT pg_terminate_backend(?) AS ended', [id]);
  // KILL takes no bound value; the id is the server's own number.
  else await admin.exec(`KILL CONNECTION ${Math.trunc(id)}`);
}

// A statement that takes `seconds` to answer.
const sleeping = (sql: SqlExecutor, seconds: number) =>
  sql.dialect === 'postgres' ? `SELECT pg_sleep(${seconds}) AS slept` : `SELECT SLEEP(${seconds}) AS slept`;

// The keep-alive timers of the connections to a port, as the system shows them (ss -o), in seconds; null where ss
// cannot be run (not Linux, not installed).
function keepAliveSeconds(port: number): number[] | null {
  let out: string;
  try {
    out = execFileSync('ss', ['-tnoH', 'state', 'established', `( dport = :${port} )`], { encoding: 'utf8' });
  } catch {
    return null;
  }
  // timer:(keepalive,9.982sec,0), timer:(keepalive,119min,0) or timer:(keepalive,1min59sec,0)
  return [...out.matchAll(/timer:\(keepalive,([^,]+),/g)].map(([, said = '']) => {
    const minutes = Number(/(\d+)min/.exec(said)?.[1] ?? 0);
    const seconds = Number(/([\d.]+)sec/.exec(said)?.[1] ?? 0);
    const ms = Number(/([\d.]+)ms/.exec(said)?.[1] ?? 0);
    return minutes * 60 + seconds + ms / 1000;
  });
}

eachDatabase('a connection lost under jukecord', (db) => {
  // On the servers only, each given up after a while rather than left hanging when a connection is not let go.
  const onServers = { skip: db.kind === 'sqlite' ? NO_CONNECTION : false, timeout: 15_000 };

  it(
    'fails a transaction whose connection the server ends between two of its statements, and goes on',
    onServers,
    async () => {
      const sql = await db.executor();
      const admin = await db.executor();
      const failure = await failureOf(
        sql.transaction(async () => {
          await endConnection(admin, await connectionId(sql));
          // The server's end reaches this side while the transaction does nothing on it (PostgreSQL's 'error' event,
          // heard by nobody before, ended the process here).
          await pause(300);
          await sql.get('SELECT 1 AS one');
        }),
      );
      assert.ok(failure instanceof ConnectionError, `a ConnectionError, not ${String(failure)}`);
      // The next statement runs on a connection of its own.
      assert.deepEqual(await sql.get('SELECT 2 AS two'), { two: 2 });
      assert.deepEqual(await sql.transaction(() => sql.get('SELECT 3 AS three')), { three: 3 });
    },
  );

  it('fails a transaction whose connection is cut in the middle of a statement, and goes on', onServers, async () => {
    const address = await serverAddress(db);
    const proxy = await TcpProxy.start(address.host, address.port);
    const sql = await openExecutor({ ...address, port: proxy.port }, { waitMs: 0, pool: 2 });
    try {
      const cutting = pause(300).then(() => proxy.cut());
      const failure = await failureOf(sql.transaction(() => sql.get(sleeping(sql, 2))));
      await cutting;
      assert.ok(failure instanceof ConnectionError, `a ConnectionError, not ${String(failure)}`);
      assert.deepEqual(await sql.transaction(() => sql.get('SELECT 2 AS two')), { two: 2 });
    } finally {
      await sql.close();
      await proxy.close();
    }
  });

  it('fails a statement outside a transaction whose connection is cut, and goes on', onServers, async () => {
    const address = await serverAddress(db);
    const proxy = await TcpProxy.start(address.host, address.port);
    const sql = await openExecutor({ ...address, port: proxy.port }, { waitMs: 0, pool: 2 });
    try {
      const cutting = pause(300).then(() => proxy.cut());
      const failure = await failureOf(sql.get(sleeping(sql, 2)));
      await cutting;
      assert.ok(failure instanceof ConnectionError, `a ConnectionError, not ${String(failure)}`);
      assert.deepEqual(await sql.get('SELECT 2 AS two'), { two: 2 });
    } finally {
      await sql.close();
      await proxy.close();
    }
  });

  it('gives up a statement whose answer never comes (a connection dropped on the way), and goes on', {
    // Without the wait for the answer it would hang there for hours: failed after a while instead.
    timeout: 15_000,
    skip:
      db.kind === 'sqlite'
        ? NO_CONNECTION
        : db.kind === 'mysql'
          ? 'the answer timeout is PostgreSQL’s (MySQL’s writes have no time limit to set one above)'
          : false,
  }, async () => {
    const address = await serverAddress(db);
    const proxy = await TcpProxy.start(address.host, address.port);
    // A statement may run for a second; its answer is waited for half a second more.
    const sql = await openExecutor(
      { ...address, port: proxy.port },
      { waitMs: 0, pool: 2, statementTimeoutMs: 1000, answerTimeoutMs: 1500 },
    );
    try {
      // A connection made and left in the pool, then dropped on the way without a word.
      assert.deepEqual(await sql.get('SELECT 1 AS one'), { one: 1 });
      proxy.silence();
      const started = performance.now();
      const failure = await failureOf(sql.transaction(() => sql.get('SELECT 2 AS two')));
      assert.ok(failure instanceof ConnectionError, `a ConnectionError, not ${String(failure)}`);
      // Given up after the wait for the answer, not hours later.
      assert.ok(performance.now() - started < 5000);
      // The dropped connection is not handed out again: the next statement gets a new one.
      assert.deepEqual(await sql.get('SELECT 3 AS three'), { three: 3 });
    } finally {
      await sql.close();
      await proxy.close();
    }
  });

  it(
    'keeps every connection alive from 10 s of quiet (TCP keep-alive), as the system shows it',
    onServers,
    async (t) => {
      const address = await serverAddress(db);
      const proxy = await TcpProxy.start(address.host, address.port);
      const sql = await openExecutor({ ...address, port: proxy.port }, { waitMs: 0, pool: 2 });
      try {
        // A connection made and left idle in the pool: its keep-alive timer runs.
        await sql.get('SELECT 1 AS one');
        const timers = keepAliveSeconds(proxy.port);
        if (timers === null) {
          t.skip('ss is not here to show the timers');
          return;
        }
        assert.ok(timers.length > 0, 'the connection has a keep-alive timer');
        // About 10 s; the system's default (what PostgreSQL's connections had) is two hours.
        for (const seconds of timers) assert.ok(seconds <= 11, `a keep-alive timer of ${seconds} s`);
      } finally {
        await sql.close();
        await proxy.close();
      }
    },
  );

  it('makes the schema an address names once when jukecords open it at the same moment', {
    skip: db.kind === 'postgres' ? false : 'a schema in the address is PostgreSQL’s',
  }, async () => {
    const address = await serverAddress(db);
    const admin = await db.executor();
    const names = Array.from({ length: 6 }, (_, round) => `jkt_new_${process.pid}_${round}`);
    try {
      for (const name of names) {
        // Three at once, as a core and its edges start on a first install.
        const opens = await Promise.allSettled(
          [1, 2, 3].map(() => openStore({ ...address, schema: name }, { waitMs: 0, pool: 2 })),
        );
        for (const result of opens) if (result.status === 'fulfilled') await result.value.close();
        const failures = opens.flatMap((result) => (result.status === 'rejected' ? [String(result.reason)] : []));
        assert.deepEqual(failures, [], `schema ${name}`);
      }
    } finally {
      for (const name of names) await admin.exec(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
    }
  });
});
