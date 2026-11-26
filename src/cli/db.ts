/**
 * `jukecord db`: the database itself, reached from where the command runs (not through jukecord's HTTP API), so it
 * works while jukecord is stopped.
 *
 *   jukecord db status [<address>]               the database's kind, version, schema, size and round trip
 *   jukecord db copy <from> [<to>] [--replace]   every row of one database into another
 *
 * An address is written as JUKECORD_DATABASE_URL takes it (sqlite:, sqlite:/path/file.db, postgres://...,
 * mysql://...), or as the word `configured`: the database jukecord uses here (JUKECORD_DATABASE_URL, its _FILE, or
 * the data folder's jukecord.db), which is also what status looks at and what copy writes into when none is given.
 *
 * Exit codes, as the other commands': 0 done, 1 refused (a target that holds data, a schema of another jukecord, the
 * same database twice), 2 a typing mistake, 3 the database did not answer.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigError } from '../config.ts';
import { readSettingsFile, SettingsFileError } from '../settings/file.ts';
import { ONE_PROCESS } from '../settings/layers.ts';
import { dataFolderOf, firstSettings } from '../settings/start.ts';
import {
  AddressError,
  type DatabaseAddress,
  describeAddress,
  parseDatabaseAddress,
  sameDatabase,
  withoutPassword,
} from '../store/address.ts';
import { copyStore } from '../store/copy.ts';
import { ConnectionError } from '../store/network.ts';
import { openExecutor } from '../store/open.ts';
import { TABLES } from '../store/schema.ts';
import { type SqlExecutor, StoreError } from '../store/sql.ts';
import { SqliteExecutor } from '../store/sqlite.ts';
import { healthOf, LATEST_SCHEMA, Store, schemaVersionOf, sizeOf } from '../store/store.ts';
import { formatSize } from '../util/units.ts';

/** The help of the db commands, as `jukecord help db` prints it. */
export const DB_HELP = [
  'Usage: jukecord db <status|copy> ...',
  '  db status [<address>]               the database: kind, version, schema, size, round trip',
  '  db copy <from> [<to>] [--replace]   every row of one database into another (<to>: the one jukecord uses)',
  '',
  'An address: sqlite: (the data folder’s jukecord.db), sqlite:/path/file.db, postgres://user:password@host/db,',
  'mysql://user:password@host/db, or configured (the database jukecord uses here). These run on the database itself,',
  'so they work while jukecord is stopped; copy into a database jukecord is using only while it is stopped.',
].join('\n');

// How long a db command waits for a server that does not answer yet: a person waits at the terminal.
const WAIT_MS = 15_000;

/** A mistake in the words: exit code 2. */
class Usage extends Error {
  override name = 'Usage';
}

/** Runs `jukecord db ...` (the words after "db"); returns the exit code. */
export async function runDatabaseCommand(
  args: readonly string[],
  flags: ReadonlyMap<string, string | true>,
  env: NodeJS.ProcessEnv,
  print: (text: string, error?: boolean) => void,
): Promise<number> {
  const json = flags.has('json');
  // A failure in the words people read, or as JSON under --json (as the other commands say theirs), on stderr.
  const failed = (code: string, message: string): void =>
    print(json ? JSON.stringify({ error: { code, message } }, null, 2) : `jukecord db: ${message}`, true);
  try {
    for (const [name, value] of flags) {
      if (name !== 'json' && name !== 'replace') throw new Usage(`there is no option --${name} for db`);
      if (value !== true) throw new Usage(`--${name} takes no value`);
    }
    const [verb, ...rest] = args;
    if (verb === undefined || verb === 'help') {
      print(DB_HELP);
      return verb === undefined ? 2 : 0;
    }
    // The settings, for the database jukecord uses and the data folder a SQLite path is taken from: the environment's
    // and settings.json's (a database moved to from the panel's Settings is named there), as jukecord reads them
    // before it opens its database.
    let saved: ReturnType<typeof readSettingsFile>;
    try {
      saved = readSettingsFile(dataFolderOf(env, process.cwd()));
    } catch (error) {
      if (error instanceof SettingsFileError) throw new ConfigError([error.message]);
      throw error;
    }
    const first = firstSettings(env, process.cwd(), saved, ONE_PROCESS);
    if (!first.config) throw new ConfigError(first.problems);
    const config = first.config;
    const address = (text: string): DatabaseAddress => {
      if (text === 'configured') return config.database.address;
      try {
        return parseDatabaseAddress(text, config.dataDir);
      } catch (error) {
        if (error instanceof AddressError) throw new Usage(`${quoted(text)} ${error.message}`);
        throw error;
      }
    };
    if (verb === 'status') {
      if (rest.length > 1) throw new Usage('status takes one address at most');
      if (flags.has('replace')) throw new Usage('--replace is for db copy');
      print(await status(address(rest[0] ?? 'configured'), json));
      return 0;
    }
    if (verb === 'copy') {
      if (rest.length < 1 || rest.length > 2)
        throw new Usage('copy takes a source and, if not the configured one, a target');
      const from = address(rest[0] ?? '');
      const to = address(rest[1] ?? 'configured');
      print(await copy(from, to, flags.has('replace'), config.dataDir, json));
      return 0;
    }
    throw new Usage(`there is no db command "${verb}" (db status, db copy)`);
  } catch (error) {
    if (error instanceof Usage) {
      failed('usage', error.message);
      return 2;
    }
    if (error instanceof ConfigError) {
      failed('usage', error.message);
      return 2;
    }
    if (error instanceof ConnectionError) {
      failed('unreachable', error.message);
      return 3;
    }
    if (error instanceof StoreError) {
      failed('refused', error.message);
      return 1;
    }
    // Anything else (a SQLite file that is no database or cannot be read or written, a disk that filled up, a server
    // that refused a statement): its reason on one line, not a stack, and 1.
    failed('failed', error instanceof Error ? error.message : String(error));
    return 1;
  }
}

// An error met while working on one database, said with the database it is about (a SQLite error does not name its
// file); a refusal or an unreachable database names its own already.
function about(what: string, error: unknown): unknown {
  if (error instanceof Usage || error instanceof ConnectionError || error instanceof StoreError) return error;
  return new Error(`${what}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
}

// An address as a word of a message: a server's without its password, a SQLite path as it is.
function quoted(text: string): string {
  return `"${withoutPassword(text)}"`;
}

// The status of one database (see the module comment).
async function status(address: DatabaseAddress, json: boolean): Promise<string> {
  // A SQLite file that is not there is not made by looking at it, and one that is, is only read (its mode, its journal
  // and its bytes stay as they are).
  if (address.kind === 'sqlite' && !fs.existsSync(address.file)) {
    throw new StoreError(`there is no database at ${address.file}`);
  }
  // What goes wrong said with the database it is about (a SQLite file that is no database says only that).
  return described(address, json).catch((error: unknown) => {
    throw about(describeAddress(address), error);
  });
}

// The status of one database that is there, in words or as JSON.
async function described(address: DatabaseAddress, json: boolean): Promise<string> {
  const sql = await openExecutor(address, { waitMs: WAIT_MS, pool: 1, readOnly: true });
  try {
    const health = await healthOf(sql);
    const schema = health.schema ?? (await schemaVersionOf(sql));
    const bytes = await sizeOf(sql);
    // The rows of each table, for a schema this jukecord knows (a copy is checked by them).
    const rows = schema === LATEST_SCHEMA ? await countRows(sql) : null;
    if (json) {
      return JSON.stringify(
        {
          backend: health.backend,
          server: health.server,
          database: describeAddress(address),
          schema,
          latestSchema: LATEST_SCHEMA,
          bytes,
          roundTripMs: health.roundTripMs,
          rows,
        },
        null,
        2,
      );
    }
    const state =
      schema === LATEST_SCHEMA
        ? `${schema}, this jukecord's`
        : schema === 0
          ? 'none (no jukecord data yet)'
          : schema > LATEST_SCHEMA
            ? `${schema}, newer than this jukecord's (${LATEST_SCHEMA})`
            : `${schema}, older than this jukecord's (${LATEST_SCHEMA}; starting jukecord on it brings it up to date)`;
    const lines = [
      `Database: ${describeAddress(address)}`,
      `Server: ${health.server}`,
      `Schema: ${state}`,
      `Size: ${bytes === null ? 'not said' : formatSize(bytes)}`,
      `Round trip: ${health.roundTripMs ?? '?'} ms`,
    ];
    if (rows) {
      const total = Object.values(rows).reduce((sum, count) => sum + count, 0);
      lines.push(
        `Rows: ${total} (${rows.tracks} tracks, ${rows.history} plays, ${rows.queue_items} queued, ${rows.playlists} playlists)`,
      );
    }
    return lines.join('\n');
  } finally {
    await sql.close();
  }
}

// How many rows each table of jukecord's schema has.
async function countRows(sql: SqlExecutor): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of TABLES)
    counts[table.name] = Number((await sql.get(`SELECT COUNT(*) AS n FROM ${table.name}`))?.n);
  return counts;
}

// Copies every row of one database into another (see src/store/copy.ts), and says what it did.
async function copy(from: DatabaseAddress, to: DatabaseAddress, replace: boolean, dataDir: string, json: boolean) {
  if (sameDatabase(from, to)) throw new StoreError('the source and the target are the same database');
  if (from.kind === 'sqlite' && !fs.existsSync(from.file)) throw new StoreError(`there is no database at ${from.file}`);
  const options = { waitMs: WAIT_MS, pool: 2 };
  // The source as it is: at this jukecord's schema, or (a SQLite file of an older jukecord, an old backup) a copy of
  // it brought up to date beside the data, so the file itself is not changed.
  const { store: source, done } = await openSource(from, options, dataDir).catch((error: unknown) => {
    throw about(`the source, ${describeAddress(from)}`, error);
  });
  // A SQLite target this copy makes is removed again when the copy fails, with its log files: no half-made database
  // is left behind (one that was there is left as it was, since the copy is one transaction).
  const made = to.kind === 'sqlite' && !fs.existsSync(to.file) ? to.file : null;
  const unmake = () => {
    if (made !== null)
      for (const part of ['', '-wal', '-shm', '-journal']) fs.rmSync(`${made}${part}`, { force: true });
  };
  try {
    let target: Store;
    try {
      target = await Store.open(await openExecutor(to, options));
    } catch (error) {
      unmake();
      throw about(`the target, ${describeAddress(to)}`, error);
    }
    try {
      const report = await copyStore(source, target, { replace }).catch(async (error: unknown) => {
        await target.close();
        unmake();
        throw about(`copying into ${describeAddress(to)}`, error);
      });
      if (json) {
        return JSON.stringify(
          {
            from: describeAddress(from),
            to: describeAddress(to),
            rows: report.rows,
            ms: report.ms,
            tables: report.tables,
          },
          null,
          2,
        );
      }
      const width = Math.max(...report.tables.map((entry) => entry.name.length));
      return [
        `Copied ${report.rows} rows in ${(report.ms / 1000).toFixed(1)} s`,
        `  from ${describeAddress(from)}`,
        `  to   ${describeAddress(to)}`,
        ...report.tables.map((entry) => `  ${entry.name.padEnd(width)}  ${entry.rows}`),
      ].join('\n');
    } finally {
      await target.close();
    }
  } finally {
    await done();
  }
}

// The store a copy reads: the source opened as it is (without migrating it; a SQLite file only read, so its mode, its
// journal and its bytes stay as they are, and a backup kept read-only is copied all the same), or, for a SQLite file
// at an older schema, a copy of the file brought up to date in the data folder (or the system's temporary folder when
// the data folder cannot be written), removed after.
async function openSource(
  from: DatabaseAddress,
  options: { waitMs: number; pool: number },
  dataDir: string,
): Promise<{ store: Store; done: () => Promise<void> }> {
  const sql = await openExecutor(from, { ...options, readOnly: true });
  const version = await schemaVersionOf(sql).catch(async (error: unknown) => {
    await sql.close();
    throw error;
  });
  if (!(sql instanceof SqliteExecutor) || version === 0 || version >= LATEST_SCHEMA) {
    // At this jukecord's schema, or refused with the reason (a newer one, none, or an older server database).
    const store = await Store.open(sql, { migrate: false });
    return { store, done: () => store.close() };
  }
  let folder = dataDir;
  try {
    fs.mkdirSync(folder, { recursive: true });
    fs.accessSync(folder, fs.constants.W_OK);
  } catch {
    folder = os.tmpdir();
  }
  const file = path.join(folder, `.jukecord-copy-${process.pid}-${Date.now()}.db`);
  try {
    await sql.vacuumIntoAside(file);
  } finally {
    await sql.close();
  }
  const remove = () => {
    for (const part of ['', '-wal', '-shm', '-journal']) fs.rmSync(`${file}${part}`, { force: true });
  };
  try {
    const store = await Store.open(file);
    return {
      store,
      done: async () => {
        await store.close();
        remove();
      },
    };
  } catch (error) {
    remove();
    throw error;
  }
}
