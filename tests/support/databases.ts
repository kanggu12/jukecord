/**
 * The databases the store's tests run on: SQLite always, and each server named in JUKECORD_TEST_DATABASES
 * (addresses separated by spaces), for example:
 *
 *   JUKECORD_TEST_DATABASES="postgres://jukecord:jukecord@127.0.0.1:15432/jukecord mysql://root:jukecord@127.0.0.1:13306/jukecord"
 *
 * A server's address names a database the tests may make schemas in (PostgreSQL) or a user that may make databases
 * (MySQL, MariaDB: root in a throwaway container). Each test gets an empty database at the latest schema: a
 * PostgreSQL schema or a MySQL database of this process's own (jkt_<pid>_<n>), emptied after the test (every table
 * truncated, the ids counted from 1 again) and handed to the next one, and dropped when the file's tests are done.
 * SQLite's is a file of its own in a temporary folder.
 *
 * `eachDatabase(title, fn)` makes one suite per database; inside it, `db.open()` is the store of the test's database.
 * JUKECORD_TEST_STORE (one address) makes every `memoryStore()` of the whole suite one of that server's instead.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, describe } from 'node:test';
import type { Metrics } from '../../src/metrics/registry.ts';
import {
  type DatabaseAddress,
  parseDatabaseAddress,
  type ServerAddress,
  type SqliteAddress,
} from '../../src/store/address.ts';
import { MysqlExecutor } from '../../src/store/mysql.ts';
import { PostgresExecutor } from '../../src/store/postgres.ts';
import { MIGRATIONS, TABLES, VERSION_TABLE } from '../../src/store/schema.ts';
import type { SqlExecutor } from '../../src/store/sql.ts';
import { SqliteExecutor } from '../../src/store/sqlite.ts';
import { Store } from '../../src/store/store.ts';

/** How a test opens a store. */
export interface OpenOptions {
  readonly now?: () => number;
  readonly metrics?: Metrics;
}

/** One database the tests run on. */
export interface TestDatabase {
  /** "sqlite", or the kind and place of the server ("postgres 127.0.0.1:15432"), never its password. */
  readonly name: string;
  readonly kind: 'sqlite' | 'postgres' | 'mysql';
  /**
   * A store on this test's database, empty at the latest schema when the test began. A second open() in the same test
   * reaches the same database, as opening a file again does.
   */
  open(options?: OpenOptions): Promise<Store>;
  /** The executor of this test's database, without a store over it (for what opens a store or copies itself). */
  executor(options?: OpenOptions): Promise<SqlExecutor>;
  /** This test's database's address (for what reaches it by address: a copy, the jukecord command). */
  address(): Promise<DatabaseAddress>;
  /** The same as an address written out, as JUKECORD_DATABASE_URL takes it (with the test server's password). */
  url(): Promise<string>;
  /** An address of another database of this kind, empty and without tables, the test's alone. */
  another(): Promise<DatabaseAddress>;
}

// The stores and executors opened during the test running now, closed when it ends.
const opened: { close(): Promise<void> }[] = [];

// What each test leaves to clear away once its stores are closed (its databases handed back, its files removed).
const clearing: (() => Promise<void>)[] = [];

// Close what the test opened, then clear its databases away for the next.
afterEach(async () => {
  for (const one of opened.splice(0)) await one.close().catch(() => {});
  for (const clear of clearing.splice(0)) await clear();
});

// What the file's last test leaves: each server's databases dropped and its administering connection closed.
const finishing: (() => Promise<void>)[] = [];
after(async () => {
  for (const finish of finishing.splice(0)) await finish().catch(() => {});
});

// An executor for an address (the one the store would open), with the pool the tests use.
async function executorFor(address: DatabaseAddress, options: OpenOptions): Promise<SqlExecutor> {
  const metrics = options.metrics ? { metrics: options.metrics } : {};
  if (address.kind === 'sqlite') return SqliteExecutor.open(address.file, metrics);
  // A few connections: a test runs one thing at a time, or a handful at once in the tests of concurrency.
  const pool = { pool: 4, ...metrics };
  return address.kind === 'postgres' ? PostgresExecutor.open(address, pool) : MysqlExecutor.open(address, pool);
}

// The clock a store gets when the test gives none: the same fixed moment as memoryStore()'s, so the times it writes
// can be compared.
const FIXED_NOW = () => Date.UTC(2026, 10, 11);

// A store opened on an executor, closed with the test.
async function storeOn(sql: SqlExecutor, options: OpenOptions): Promise<Store> {
  const store = await Store.open(sql, { now: options.now ?? FIXED_NOW });
  opened.push(store);
  return store;
}

/** SQLite: a file of the test's own in a temporary folder, removed with the test. */
function sqlite(): TestDatabase {
  let dir: string | null = null;
  // The test's folder, made at its first use.
  const folder = (): string => {
    if (dir === null) {
      const made = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-test-'));
      dir = made;
      clearing.push(async () => {
        fs.rmSync(made, { recursive: true, force: true });
        dir = null;
      });
    }
    return dir;
  };
  let others = 0;
  const own = (): SqliteAddress => ({ kind: 'sqlite', file: path.join(folder(), 'jukecord.db') });
  return {
    name: 'sqlite',
    kind: 'sqlite',
    open: async (options = {}) => storeOn(await executorFor(own(), options), options),
    executor: async (options = {}) => {
      const sql = await executorFor(own(), options);
      opened.push(sql);
      return sql;
    },
    address: async () => own(),
    url: async () => `sqlite:${own().file}`,
    another: async () => {
      others += 1;
      return { kind: 'sqlite', file: path.join(folder(), `another-${others}.db`) };
    },
  };
}

// The databases of one server for this process: made when first needed, emptied between tests, dropped at the end.
class ServerDatabases {
  readonly admin: ServerAddress;
  // The administering database's address as it was written (the test databases' are made from it).
  private readonly url: string;
  // The connection that makes, empties and drops them (to the database the address names).
  private root: SqlExecutor | null = null;
  // Databases ready for a test (at the latest schema and empty), and every one made, for dropping.
  private readonly free: string[] = [];
  private readonly made = new Set<string>();
  private count = 0;

  constructor(admin: ServerAddress, url: string) {
    this.admin = admin;
    this.url = url;
    finishing.push(() => this.finish());
  }

  /** A database's address by its name, written out (a schema parameter on PostgreSQL, the path on MySQL). */
  urlOf(name: string): string {
    const url = new URL(this.url);
    if (this.admin.kind === 'postgres') url.searchParams.set('schema', name);
    else url.pathname = `/${name}`;
    return url.href;
  }

  // The administering connection, opened once.
  private async rooted(): Promise<SqlExecutor> {
    this.root ??=
      this.admin.kind === 'postgres'
        ? await PostgresExecutor.open(this.admin, { pool: 2 })
        : await MysqlExecutor.open(this.admin, { pool: 2 });
    return this.root;
  }

  /** The address of a database by its name (a schema of the admin's database on PostgreSQL). */
  addressOf(name: string): ServerAddress {
    return this.admin.kind === 'postgres' ? { ...this.admin, schema: name } : { ...this.admin, database: name };
  }

  /** A database of its own, empty and without tables. */
  async blank(): Promise<string> {
    const root = await this.rooted();
    this.count += 1;
    const name = `jkt_${process.pid}_${this.count}`;
    await root.exec(this.admin.kind === 'postgres' ? `CREATE SCHEMA ${name}` : `CREATE DATABASE ${name}`);
    this.made.add(name);
    return name;
  }

  /** A database for a test: an empty one at the latest schema, made (and its tables made) when none is free. */
  async take(): Promise<string> {
    const ready = this.free.pop();
    if (ready !== undefined) return ready;
    const name = await this.blank();
    // Its tables, made once by the store itself (the server's baseline and the migrations after it).
    const store = await Store.open(await executorFor(this.addressOf(name), {}));
    await store.close();
    return name;
  }

  /**
   * Hands a database back once its test is done: emptied (every table, the ids counted from 1 again) when it is still
   * at the latest schema, dropped when a test changed what it is (its version, its tables).
   */
  async give(name: string): Promise<void> {
    const root = await this.rooted();
    const latest = MIGRATIONS.at(-1)?.version ?? 0;
    const tables = TABLES.map((table) => `${name}.${table.name}`);
    try {
      const version = await root.get(`SELECT MAX(version) AS version FROM ${name}.${VERSION_TABLE}`);
      if (Number(version?.version) !== latest) throw new Error('not at the latest schema');
      if (this.admin.kind === 'postgres') {
        // One statement for every table: their identities start again at 1 (RESTART IDENTITY).
        await root.exec(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
      } else {
        // TRUNCATE starts AUTO_INCREMENT again; the tables' foreign keys would refuse it, so they are not checked for
        // the moment (on the one connection a transaction holds, where the setting lives).
        await root.transaction(async () => {
          await root.exec('SET FOREIGN_KEY_CHECKS = 0');
          try {
            for (const table of tables) await root.exec(`TRUNCATE TABLE ${table}`);
          } finally {
            await root.exec('SET FOREIGN_KEY_CHECKS = 1');
          }
        });
      }
      this.free.push(name);
    } catch {
      await this.drop(name);
    }
  }

  /** Drops one database. */
  async drop(name: string): Promise<void> {
    const root = await this.rooted();
    await root.exec(
      this.admin.kind === 'postgres' ? `DROP SCHEMA IF EXISTS ${name} CASCADE` : `DROP DATABASE IF EXISTS ${name}`,
    );
    this.made.delete(name);
  }

  // The file's tests are done: every database this process made is dropped.
  private async finish(): Promise<void> {
    if (this.root === null) return;
    for (const name of [...this.made]) await this.drop(name).catch(() => {});
    await this.root.close();
    this.root = null;
  }
}

// The servers by address, one set of databases each per process.
const servers = new Map<string, ServerDatabases>();

function serverDatabases(url: string): ServerDatabases {
  let known = servers.get(url);
  if (!known) {
    const address = parseDatabaseAddress(url, os.tmpdir());
    if (address.kind === 'sqlite') throw new Error('JUKECORD_TEST_DATABASES names servers; SQLite is always tested');
    known = new ServerDatabases(address, url);
    servers.set(url, known);
  }
  return known;
}

/** A server's test database (see the module comment). */
function server(url: string): TestDatabase {
  const databases = serverDatabases(url);
  const admin = databases.admin;
  // The test's own database, taken at its first use and handed back after it.
  let mine: Promise<string> | null = null;
  const own = (): Promise<string> => {
    if (mine === null) {
      const taken = databases.take();
      mine = taken;
      clearing.push(async () => {
        mine = null;
        await databases.give(await taken);
      });
    }
    return mine;
  };
  return {
    name: `${admin.kind} ${admin.host}:${admin.port}`,
    kind: admin.kind,
    open: async (options = {}) => storeOn(await executorFor(databases.addressOf(await own()), options), options),
    executor: async (options = {}) => {
      const sql = await executorFor(databases.addressOf(await own()), options);
      opened.push(sql);
      return sql;
    },
    address: async () => databases.addressOf(await own()),
    url: async () => databases.urlOf(await own()),
    another: async () => {
      const name = await databases.blank();
      // Dropped with the test: what it holds is the test's own.
      clearing.push(() => databases.drop(name));
      return databases.addressOf(name);
    },
  };
}

/** The server addresses of JUKECORD_TEST_DATABASES. */
export const SERVER_URLS: readonly string[] = (process.env.JUKECORD_TEST_DATABASES ?? '').split(/\s+/).filter(Boolean);

/** Every database the store's tests run on: SQLite, then each server. */
export const TEST_DATABASES: readonly TestDatabase[] = [sqlite(), ...SERVER_URLS.map((url) => server(url))];

/** A suite of tests for each database, named with it: `db` inside is that database (see TestDatabase). */
export function eachDatabase(title: string, fn: (db: TestDatabase) => void): void {
  for (const db of TEST_DATABASES) describe(`${title} (${db.name})`, () => fn(db));
}

/** The server every memoryStore() opens on instead of SQLite (JUKECORD_TEST_STORE), or null. */
export const TEST_STORE: string | null = process.env.JUKECORD_TEST_STORE?.trim() || null;

// The stores memoryStore() opened on the JUKECORD_TEST_STORE server: a suite may open one in a before() hook for all
// its tests, so they stay open until the file's tests are done (their pools let idle connections go after a second,
// so a file with many of them holds few connections).
const kept: { close(): Promise<void> }[] = [];
finishing.unshift(async () => {
  for (const one of kept.splice(0)) await one.close().catch(() => {});
});

/**
 * A store of its own on the JUKECORD_TEST_STORE server, at the latest schema and empty, as memoryStore() gives one on
 * SQLite (each call a database of its own), open until the file's tests are done.
 */
export async function serverStore(url: string, now: () => number): Promise<Store> {
  const store = await Store.open(await serverExecutor(url), { now });
  return store;
}

/** The executor of a database of its own on the JUKECORD_TEST_STORE server (for a store a test wraps itself). */
export async function serverExecutor(url: string): Promise<SqlExecutor> {
  const databases = serverDatabases(url);
  const name = await databases.take();
  const address = databases.addressOf(name);
  const sql =
    address.kind === 'postgres'
      ? await PostgresExecutor.open(address, { pool: 4, idleMs: 1000 })
      : await MysqlExecutor.open(address, { pool: 4, idleMs: 1000 });
  kept.push(sql);
  return sql;
}
