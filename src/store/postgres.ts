/**
 * The PostgreSQL executor: a pool of connections made with pg (pure JavaScript: no native build in the image or the
 * programs), which is loaded only when a postgres:// address is used.
 *
 * Statements keep the `?` placeholders of the shared SQL and are numbered here ($1, $2 ...). Every connection is
 * opened with the limits jukecord runs with (a statement ends after 30 s, a wait for a row after 10 s, a transaction
 * left idle after a minute), names itself "jukecord" to the server, and reads whole numbers and sums as JavaScript
 * numbers (pg would give BIGINT and NUMERIC as text). The transactions are those of src/store/pooled.ts.
 */
import type { Pool, PoolClient, PoolConfig, QueryResult } from 'pg';
import type { ServerAddress } from './address.ts';
import { ConnectionError, connectionFailure, tlsOptions } from './network.ts';
import {
  type Answer,
  DEFAULT_POOL,
  IDLE_MS,
  LOCK_TIMEOUT_MS,
  PooledExecutor,
  type PoolOptions,
  STATEMENT_TIMEOUT_MS,
  type Turn,
} from './pooled.ts';
import type { DatabaseServer, SqlRow, SqlValue } from './sql.ts';

// How long a transaction may sit idle on its connection before the server ends it: no transaction of jukecord's waits
// for anything but the database, so one that does is stuck (and holds rows others need).
const IDLE_IN_TRANSACTION_MS = 60_000;

// How many placeholder conversions are kept: every text the repositories use, and a bound on texts made at random.
const TEXTS_KEPT = 1000;

// TCP keep-alive from this long of quiet on a connection (the system's default is two hours): a connection a NAT or a
// firewall dropped on the way is found dead within seconds of it (Node then sends ten probes a second apart), instead
// of holding its statement, and the server's lane waiting on that statement, for hours.
const KEEPALIVE_MS = 10_000;

// How much longer than a statement may run (the server ends it then) jukecord waits for the answer: the server's own
// end comes first, and this is for an answer that never comes (a connection lost without a word, a server hung).
const ANSWER_MARGIN_MS = 10_000;

// The SQLSTATE codes of a transaction refused for another's sake: a serialization failure, and a deadlock.
const REFUSED = new Set(['40001', '40P01']);

// The SQLSTATE classes and codes of a connection that is gone: connection exceptions (08), and the server ending it
// (an administrator, a crash, a restart, a transaction idle for too long).
const LOST = /^(08|57P0[1-3]$|25P03$)/;

/**
 * Numbers a statement's placeholders for PostgreSQL ($1, $2 ...), outside quoted text, quoted names and comments,
 * where a question mark is only a character.
 */
export function numberPlaceholders(sql: string): string {
  let out = '';
  let count = 0;
  let index = 0;
  while (index < sql.length) {
    const char = sql[index] ?? '';
    // Quoted text or a quoted name: copied to its closing quote (a doubled quote is one inside it).
    if (char === "'" || char === '"') {
      let end = index + 1;
      while (end < sql.length) {
        if (sql[end] === char && sql[end + 1] === char) end += 2;
        else if (sql[end] === char) break;
        else end += 1;
      }
      out += sql.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    // A comment to the end of its line, or a block comment: copied as it is.
    if (char === '-' && sql[index + 1] === '-') {
      const end = sql.indexOf('\n', index);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === '?') {
      count += 1;
      out += `$${count}`;
    } else {
      out += char;
    }
    index += 1;
  }
  return out;
}

export class PostgresExecutor extends PooledExecutor<PoolClient> {
  readonly dialect = 'postgres' as const;
  private readonly pool: Pool;
  // The connections that failed (cut, ended by the server) with the error each failed with: a transaction holding one
  // learns of it at its next statement, which fails with that error instead of reaching the dead connection.
  private readonly failed: WeakMap<object, Error>;
  // Statements with their placeholders numbered, by the text the repositories wrote, oldest first.
  private readonly texts = new Map<string, string>();

  private constructor(
    pool: Pool,
    address: ServerAddress,
    server: DatabaseServer,
    options: PoolOptions,
    failed: WeakMap<object, Error>,
  ) {
    super(address, server, options);
    this.pool = pool;
    this.failed = failed;
    // The pool's use, read when the metrics are: busy, idle, and how many wait for a connection.
    options.report?.connections(() => ({
      busy: pool.totalCount - pool.idleCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    }));
  }

  /**
   * Opens a pool to the database at `address` and asks the server who it is, so a wrong address, password or
   * certificate fails here, with its reason in words (ConnectionError), not at the first statement.
   */
  static async open(address: ServerAddress, options: PoolOptions = {}): Promise<PostgresExecutor> {
    const tls = tlsOptions(address, options.trust);
    // The driver, loaded now: a jukecord on SQLite never loads it.
    const { default: pg } = await import('pg');
    // Whole numbers (BIGINT, as every one is in jukecord's tables) and sums (NUMERIC) as JavaScript numbers: they
    // stay below 2^53 (ids, counts, milliseconds), which a number holds exactly.
    const parse = (text: string) => Number(text);
    const types = {
      getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
        oid === pg.types.builtins.INT8 || oid === pg.types.builtins.NUMERIC
          ? parse
          : pg.types.getTypeParser(oid, format ?? 'text')) as typeof pg.types.getTypeParser,
    };
    const statementTimeoutMs = options.statementTimeoutMs ?? STATEMENT_TIMEOUT_MS;
    const config: PoolConfig = {
      // A socket's folder (postgres:///jukecord?host=/run/postgresql) or the host.
      host: address.socket ?? address.host,
      port: address.port,
      user: address.user,
      ...(address.password === null ? {} : { password: address.password }),
      database: address.database,
      ssl: tls === null ? false : tls.options,
      max: options.pool ?? DEFAULT_POOL,
      // Connecting, and waiting for a free connection when all are in use, each give up after this long.
      connectionTimeoutMillis: address.connectTimeoutMs,
      // An unused connection is closed after half a minute, so a quiet jukecord holds none open for long.
      idleTimeoutMillis: options.idleMs ?? IDLE_MS,
      // TCP keep-alive from 10 s of quiet: a connection cut on the way (a NAT, a firewall) is noticed in seconds instead
      // of hanging a statement (the system's own default starts after two hours).
      keepAlive: true,
      keepAliveInitialDelayMillis: KEEPALIVE_MS,
      // A statement whose answer has not come 10 s after the server would have ended it fails, and its connection is
      // closed (see lost(): it is a connection lost without a word).
      query_timeout: options.answerTimeoutMs ?? statementTimeoutMs + ANSWER_MARGIN_MS,
      application_name: 'jukecord',
      statement_timeout: statementTimeoutMs,
      lock_timeout: LOCK_TIMEOUT_MS,
      idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_MS,
      // The schema the address names, where every unqualified table name is looked for and made.
      ...(address.schema === null ? {} : { options: `-c search_path=${address.schema}` }),
      types,
    };
    const pool = new pg.Pool(config);
    // A connection the server ended while it sat idle (a restart, an administrator) is dropped by the pool, which opens
    // another when one is needed. Said, not thrown: an 'error' nobody listens to would end jukecord.
    pool.on('error', (error) =>
      options.log?.warn('a connection to the database was lost while idle; a new one is opened when needed', {
        reason: error.message,
      }),
    );
    // Every connection is listened to for its whole life: the pool's own listener above covers it only while it is
    // idle, and a connection that fails while a transaction holds it (a server restart, a failover, an administrator,
    // a network cut, the server's end of a transaction left idle) says so with an 'error' event, which, heard by
    // nobody, would end jukecord. Kept here instead: the transaction's next statement fails with it.
    const failed = new WeakMap<object, Error>();
    pool.on('connect', (client) => {
      client.on('error', (error: Error) => {
        // The first error is the one that says why (the server's own words); the connection's end comes after it.
        if (!failed.has(client)) failed.set(client, error);
      });
    });
    try {
      const answer = await pool.query(
        "SELECT current_setting('server_version') AS version, current_setting('server_encoding') AS encoding",
      );
      const row = answer.rows[0] as { version?: unknown; encoding?: unknown } | undefined;
      // "18.7", or "16.4 (Debian 16.4-1.pgdg120+2)" from a distribution's build: the number alone.
      const version = String(row?.version ?? 'unknown').split(' ')[0] ?? 'unknown';
      // Emoji and every other character need UTF-8; a LATIN1 or SQL_ASCII database would refuse them (or keep them
      // as something else), and a track's hash is of its UTF-8 bytes.
      if (row?.encoding !== 'UTF8') {
        throw new ConnectionError(
          `the database "${address.database}" is in ${String(row?.encoding)}, not UTF8; make it with ENCODING 'UTF8'`,
          false,
        );
      }
      // Made when missing, but on a database only read: a schema that is not there reads as one with no tables.
      if (address.schema !== null && options.readOnly !== true) await ensureSchema(pool, address.schema);
      return new PostgresExecutor(pool, address, { product: 'PostgreSQL', version }, options, failed);
    } catch (error) {
      await pool.end().catch(() => {});
      throw connectionFailure(error, address) ?? error;
    }
  }

  protected async acquire(): Promise<PoolClient> {
    return this.pool.connect();
  }

  protected release(connection: PoolClient, broken: boolean): void {
    // A broken connection is closed by the pool (release with a truthy error) instead of handed to someone else.
    connection.release(broken ? true : undefined);
  }

  protected async execute(
    connection: PoolClient | null,
    sql: string,
    params: readonly SqlValue[] | undefined,
  ): Promise<Answer> {
    // A transaction's connection that failed since its last statement: this one fails as that did (see open()).
    const failure = connection === null ? undefined : this.failed.get(connection);
    if (failure !== undefined) throw failure;
    const target = connection ?? this.pool;
    // Without values the text goes as it is (the simple protocol, which takes several statements at once: a
    // migration); with them, numbered and bound (each value sent apart from the text, never written into it).
    const result: QueryResult =
      params === undefined ? await target.query(sql) : await target.query(this.numbered(sql), [...params]);
    // Several statements at once answer with one result each; their rows are not read.
    const one = Array.isArray(result) ? undefined : result;
    return { rows: (one?.rows ?? []) as SqlRow[], changes: one?.rowCount ?? 0, lastId: null };
  }

  protected begin(mode: 'serializable' | 'snapshot' | 'latest'): readonly string[] {
    // A snapshot: one consistent view that never waits for a writer and is never refused (REPEATABLE READ, reads
    // only). Work in turns already, a row read back, a migration: each statement's own view (READ COMMITTED). Every
    // other transaction: serializable, so none sees another's change halfway (see src/store/pooled.ts).
    if (mode === 'snapshot') return ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'];
    if (mode === 'latest') return ['BEGIN ISOLATION LEVEL READ COMMITTED'];
    return ['BEGIN ISOLATION LEVEL SERIALIZABLE'];
  }

  protected turn(key: string): Turn {
    // An advisory lock of the transaction's own (it ends with it, so nothing gives it back), on a 64-bit hash of the
    // key: two keys that share a hash only take turns needlessly. The wait for it is a wait for a lock, given up
    // after lock_timeout (10 s) with the server's own error.
    return {
      take: { sql: 'SELECT pg_advisory_xact_lock(hashtextextended(?, 0)) AS turn', params: [`jukecord:${key}`] },
      taken: () => true,
      give: null,
    };
  }

  protected refused(error: unknown): boolean {
    return REFUSED.has(String((error as { code?: unknown } | null)?.code));
  }

  protected lost(error: unknown): boolean {
    const code = (error as { code?: unknown } | null)?.code;
    // A code of the server's own that says the connection ended, or none at all (a socket's error, the driver's
    // "Connection terminated").
    if (typeof code === 'string' && /^(?=.*\d)[0-9A-Z]{5}$/.test(code)) return LOST.test(code);
    return true;
  }

  protected async end(): Promise<void> {
    await this.pool.end();
  }

  // A statement with numbered placeholders, kept for the next time the same text comes (the oldest let go past the
  // bound).
  private numbered(sql: string): string {
    const kept = this.texts.get(sql);
    if (kept !== undefined) return kept;
    const text = numberPlaceholders(sql);
    this.texts.set(sql, text);
    if (this.texts.size > TEXTS_KEPT) {
      const oldest = this.texts.keys().next().value;
      if (oldest !== undefined) this.texts.delete(oldest);
    }
    return text;
  }
}

// Makes the schema an address names when it is not there yet (asked first: CREATE SCHEMA IF NOT EXISTS needs the
// right to create schemas even when the schema exists, which a user given only that schema does not have).
async function ensureSchema(pool: Pool, schema: string): Promise<void> {
  const there = async () =>
    ((await pool.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema])).rowCount ?? 0) > 0;
  if (await there()) return;
  try {
    // The name is a plain identifier (checked when the address was read), so it is written in as it is.
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  } catch (error) {
    // Two jukecords making it at the same moment (a core and its edges on a first install): IF NOT EXISTS does not
    // cover that race, and the one that loses it is told the name is taken (a unique violation on pg_namespace's
    // index, or duplicate_schema) once the other's is kept. Made by the other, then: found when looked for again.
    const code = (error as { code?: unknown } | null)?.code;
    if ((code !== '23505' && code !== '42P06') || !(await there())) throw error;
  }
}
