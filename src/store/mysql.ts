/**
 * The MySQL and MariaDB executor: a pool of connections made with mysql2 (pure JavaScript: no native build in the
 * image or the programs), which is loaded only when a mysql:// or mariadb:// address is used.
 *
 * Statements are prepared on the server and their values bound to them (mysql2's execute), never written into the
 * text. A JavaScript whole number is bound as a BIGINT: mysql2 sends a plain number as a DOUBLE, which MySQL 8.0.22
 * and later refuse for LIMIT ? and which compares a 64-bit id as a float. Every connection is set up the same way
 * before its first statement, whatever the server's defaults:
 * - sql_mode: ANSI_QUOTES (a double-quoted word is a name, as in SQLite and PostgreSQL), PIPES_AS_CONCAT (|| joins
 *   text instead of meaning OR), ONLY_FULL_GROUP_BY, and the strict modes (a value that does not fit is refused, not
 *   cut short);
 * - statements at READ COMMITTED, as PostgreSQL runs them, and each transaction at SERIALIZABLE unless it asks for
 *   READ COMMITTED or a snapshot (see src/store/pooled.ts); a wait for a row given up after 10 s, a statement after
 *   30 s (MySQL's max_execution_time, MariaDB's max_statement_time);
 * - the connection in utf8mb4 with the utf8mb4_bin collation, as jukecord's tables are.
 */
import { createHash } from 'node:crypto';
import type { Pool, PoolConnection, ResultSetHeader } from 'mysql2/promise';
import type { ServerAddress } from './address.ts';
import { connectionFailure, tlsOptions } from './network.ts';
import {
  type Answer,
  DEFAULT_POOL,
  IDLE_MS,
  LOCK_TIMEOUT_MS,
  PooledExecutor,
  type PoolOptions,
  STATEMENT_TIMEOUT_MS,
  TURN_WAIT_MS,
  type Turn,
} from './pooled.ts';
import type { DatabaseServer, SqlRow, SqlValue } from './sql.ts';

// The sql_mode of every connection (see the module comment).
const SQL_MODE = [
  'ANSI_QUOTES',
  'PIPES_AS_CONCAT',
  'ONLY_FULL_GROUP_BY',
  'STRICT_ALL_TABLES',
  'NO_ZERO_IN_DATE',
  'NO_ZERO_DATE',
  'ERROR_FOR_DIVISION_BY_ZERO',
  'NO_ENGINE_SUBSTITUTION',
].join(',');

// The error numbers of a transaction refused for another's sake: a deadlock (InnoDB rolled the transaction back), and
// MariaDB's "record has changed since last read" (its snapshot isolation).
const REFUSED = new Set([1213, 1020]);

// mysql2's typed parameters: the factory of a value sent with a type of its own (mysql2.TypedParameter).
type Typed = (value: number | bigint) => unknown;

/**
 * The statements of a text that holds several (a migration), split at each semicolon that ends one: outside quoted
 * text, quoted names and comments. A text with values is one statement; this is only for texts without.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let index = 0;
  while (index < sql.length) {
    const char = sql[index] ?? '';
    if (char === "'" || char === '"' || char === '`') {
      // A quoted part, to its closing quote (doubled inside it, or after a backslash in MySQL's text).
      let end = index + 1;
      while (end < sql.length) {
        if (sql[end] === '\\') end += 2;
        else if (sql[end] === char && sql[end + 1] === char) end += 2;
        else if (sql[end] === char) break;
        else end += 1;
      }
      index = end + 1;
      continue;
    }
    if (char === '-' && sql[index + 1] === '-') {
      const end = sql.indexOf('\n', index);
      index = end === -1 ? sql.length : end;
      continue;
    }
    if (char === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2);
      index = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (char === ';') {
      statements.push(sql.slice(start, index));
      start = index + 1;
    }
    index += 1;
  }
  statements.push(sql.slice(start));
  // Comments alone, or nothing at all, between two semicolons are no statement.
  return statements
    .map((statement) => statement.trim())
    .filter((statement) => statement.replace(/--[^\n]*/g, '').trim() !== '');
}

export class MysqlExecutor extends PooledExecutor<PoolConnection> {
  readonly dialect = 'mysql' as const;
  private readonly pool: Pool;
  private readonly bigint: Typed;
  // The statements that set a connection up (they differ between MySQL and MariaDB), and the connections set up
  // already (mysql2's own connection objects, which outlive the wrappers the pool hands out).
  private readonly setup: readonly string[];
  private readonly ready: WeakSet<object>;
  // How many statements and transactions wait for a connection, and how many hold one (for the metrics).
  private waiting = 0;
  private busy = 0;

  private constructor(
    pool: Pool,
    address: ServerAddress,
    server: DatabaseServer,
    options: PoolOptions,
    parts: { bigint: Typed; setup: readonly string[]; ready: WeakSet<object> },
  ) {
    super(address, server, options);
    this.pool = pool;
    this.bigint = parts.bigint;
    this.setup = parts.setup;
    this.ready = parts.ready;
    const size = options.pool ?? DEFAULT_POOL;
    // The pool's use: busy and waiting as counted here; idle from the pool's list of free connections when it has one
    // (a field of mysql2's own, read only for the metrics), else what is left of the pool's size.
    options.report?.connections(() => {
      const free = (pool.pool as unknown as { _freeConnections?: { length?: number } })._freeConnections?.length;
      return {
        busy: this.busy,
        idle: typeof free === 'number' ? free : Math.max(0, size - this.busy),
        waiting: this.waiting,
      };
    });
  }

  /**
   * Opens a pool to the database at `address`, asks the server who it is (MySQL or MariaDB, and the version) and sets
   * its first connection up, so a wrong address, password or certificate fails here, with its reason in words.
   */
  static async open(address: ServerAddress, options: PoolOptions = {}): Promise<MysqlExecutor> {
    const tls = tlsOptions(address);
    // The driver, loaded now: a jukecord on SQLite never loads it.
    const { default: mysql } = await import('mysql2/promise');
    const size = options.pool ?? DEFAULT_POOL;
    const pool = mysql.createPool({
      ...(address.socket === null ? { host: address.host, port: address.port } : { socketPath: address.socket }),
      user: address.user,
      ...(address.password === null ? {} : { password: address.password }),
      database: address.database,
      // TLS as the address asks (see mysqlSsl()).
      ...(tls === null ? {} : { ssl: mysqlSsl(tls) }),
      connectionLimit: size,
      maxIdle: size,
      // An unused connection is closed after half a minute, so a quiet jukecord holds none open for long.
      idleTimeout: options.idleMs ?? IDLE_MS,
      waitForConnections: true,
      queueLimit: 0,
      connectTimeout: address.connectTimeoutMs,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10_000,
      // utf8mb4 with the binary collation, as the tables are (the connection's own collation decides how a value
      // written in a statement compares).
      charset: 'UTF8MB4_BIN',
      // Sums (DECIMAL in MySQL) as numbers; whole numbers past 2^53 as text (jukecord's never are).
      decimalNumbers: true,
      supportBigNumbers: true,
      bigNumberStrings: false,
      // The prepared statements each connection keeps: every text of the repositories, and a bound on the server's
      // count (max_prepared_stmt_count is shared by every connection).
      maxPreparedStatements: 500,
      multipleStatements: false,
    });
    const ready = new WeakSet<object>();
    try {
      const connection = await pool.getConnection();
      try {
        const [rows] = await connection.query('SELECT VERSION() AS version');
        const said = String((rows as { version?: unknown }[])[0]?.version ?? 'unknown');
        // "11.8.9-MariaDB-ubu2404" or "8.4.13": the program and the number alone.
        const mariadb = /mariadb/i.test(said);
        const version = said.split('-')[0] ?? said;
        const setup = setupStatements(mariadb, options.statementTimeoutMs ?? STATEMENT_TIMEOUT_MS);
        for (const statement of setup) await connection.query(statement);
        ready.add(connection.connection);
        const server: DatabaseServer = { product: mariadb ? 'MariaDB' : 'MySQL', version };
        const typed = (mysql as unknown as { TypedParameter: { BIGINT: Typed } }).TypedParameter;
        return new MysqlExecutor(pool, address, server, options, { bigint: typed.BIGINT, setup, ready });
      } finally {
        connection.release();
      }
    } catch (error) {
      await pool.end().catch(() => {});
      throw connectionFailure(error, address) ?? error;
    }
  }

  protected async acquire(): Promise<PoolConnection> {
    this.waiting += 1;
    let connection: PoolConnection;
    try {
      connection = await this.pool.getConnection();
    } finally {
      this.waiting -= 1;
    }
    this.busy += 1;
    try {
      // A connection the pool opened since: set up before its first statement.
      if (!this.ready.has(connection.connection)) {
        for (const statement of this.setup) await connection.query(statement);
        this.ready.add(connection.connection);
      }
    } catch (error) {
      this.busy -= 1;
      connection.destroy();
      throw error;
    }
    return connection;
  }

  protected release(connection: PoolConnection, broken: boolean): void {
    this.busy -= 1;
    // A broken connection is closed and leaves the pool, which opens another when one is needed.
    if (broken) connection.destroy();
    else connection.release();
  }

  protected async execute(
    connection: PoolConnection | null,
    sql: string,
    params: readonly SqlValue[] | undefined,
  ): Promise<Answer> {
    // Outside a transaction: a connection of the pool for this one statement (set up as every connection is).
    if (connection === null) {
      const own = await this.acquire();
      let broken = false;
      try {
        return await this.execute(own, sql, params);
      } catch (error) {
        broken = this.lost(error);
        throw error;
      } finally {
        this.release(own, broken);
      }
    }
    // Several statements without values (a migration): one at a time, as text.
    if (params === undefined) {
      for (const statement of splitStatements(sql)) await connection.query(statement);
      return { rows: [], changes: 0, lastId: null };
    }
    const [result] = await connection.execute(sql, params.map((value) => this.bound(value)) as never);
    // A query answers with its rows; a statement that writes, with what it did.
    if (Array.isArray(result)) return { rows: result as unknown as SqlRow[], changes: 0, lastId: null };
    const header = result as ResultSetHeader;
    return { rows: [], changes: header.affectedRows, lastId: header.insertId > 0 ? header.insertId : null };
  }

  protected begin(mode: 'serializable' | 'snapshot' | 'latest'): readonly string[] {
    // A snapshot: REPEATABLE READ for this one transaction (plain reads under SERIALIZABLE would lock every row they
    // read), its view taken at once, reads only. READ COMMITTED: the connection's own level. Every other one:
    // SERIALIZABLE for this one transaction (SET TRANSACTION without SESSION is for the next one only).
    if (mode === 'snapshot') {
      return [
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
        'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY',
      ];
    }
    if (mode === 'latest') return ['START TRANSACTION'];
    return ['SET TRANSACTION ISOLATION LEVEL SERIALIZABLE', 'START TRANSACTION'];
  }

  protected turn(key: string): Turn {
    // A named lock, which is the connection's and outlives the transaction: given back after it ends. A name is 64
    // characters at most: the key's SHA-256, cut short. GET_LOCK says 1 when it has the lock, 0 when it waited for
    // it in vain.
    const name = `jukecord.${createHash('sha256').update(key).digest('hex').slice(0, 40)}`;
    return {
      take: { sql: 'SELECT GET_LOCK(?, ?) AS turn', params: [name, Math.ceil(TURN_WAIT_MS / 1000)] },
      taken: (answer) => Number(answer.rows[0]?.turn) === 1,
      give: { sql: 'SELECT RELEASE_LOCK(?) AS given', params: [name] },
    };
  }

  protected refused(error: unknown): boolean {
    return REFUSED.has(Number((error as { errno?: unknown } | null)?.errno));
  }

  protected lost(error: unknown): boolean {
    const fields = error as { fatal?: unknown; sqlState?: unknown } | null;
    // mysql2 marks the errors after which the connection cannot go on; one without an SQLSTATE is no statement's.
    return fields?.fatal === true || typeof fields?.sqlState !== 'string';
  }

  protected async end(): Promise<void> {
    await this.pool.end();
  }

  // A value as it is bound: a whole number as a BIGINT (see the module comment), bytes as a Buffer, the rest as is.
  private bound(value: SqlValue): unknown {
    if (typeof value === 'bigint') return this.bigint(value);
    if (typeof value === 'number' && Number.isSafeInteger(value)) return this.bigint(value);
    if (value instanceof Uint8Array && !Buffer.isBuffer(value)) return Buffer.from(value);
    return value;
  }
}

// The statements that set a connection up (see the module comment): MariaDB names the statement time limit (in
// seconds) differently. READ COMMITTED is the connection's level, for its statements outside a transaction (as
// PostgreSQL's are: no locks on the gaps between rows, which another server's rows wait for) and for the transactions
// that ask for it; a serializable one sets its own (see begin()).
function setupStatements(mariadb: boolean, statementTimeoutMs: number): readonly string[] {
  const limit = mariadb
    ? `SESSION max_statement_time = ${statementTimeoutMs / 1000}`
    : `SESSION max_execution_time = ${Math.round(statementTimeoutMs)}`;
  return [
    `SET SESSION sql_mode = '${SQL_MODE}', SESSION innodb_lock_wait_timeout = ${Math.ceil(LOCK_TIMEOUT_MS / 1000)}, ${limit}`,
    'SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED',
  ];
}

/**
 * mysql2's TLS options for an address's (see src/store/network.ts for what each mode means): the certificate files
 * that were given (ca, cert, key) and nothing in place of those that were not, so without a root certificate Node's
 * default authorities check the server (with what JUKECORD_CA_FILE adds); the chain checked with
 * rejectUnauthorized and the host's name with verifyIdentity, mysql2's words for them.
 */
export function mysqlSsl(tls: NonNullable<ReturnType<typeof tlsOptions>>): Record<string, unknown> {
  const { ca, cert, key } = tls.options;
  return {
    ...(ca === undefined ? {} : { ca }),
    ...(cert === undefined ? {} : { cert }),
    ...(key === undefined ? {} : { key }),
    rejectUnauthorized: tls.verify !== 'none',
    verifyIdentity: tls.verify === 'full',
  };
}
