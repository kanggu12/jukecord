/**
 * The SQL executor: the one way the store reaches its database.
 *
 * The repositories (src/store/store.ts) hold their SQL text and hand it here with its values; an executor runs it on
 * one kind of database and gives back plain rows. Every call returns a promise, because the drivers of network
 * databases (PostgreSQL, MySQL) have no other way to answer; the SQLite executor (src/store/sqlite.ts) answers at once
 * but keeps the same shape, so the store above it does not change with the database under it. The executors of the
 * network databases are src/store/postgres.ts and src/store/mysql.ts (MySQL and MariaDB); the few statements that
 * differ between databases are written by src/store/dialect.ts.
 *
 * Transactions follow the caller, not an argument: `transaction(async () => ...)` opens one, and every statement a
 * repository method runs inside that function, however deep, runs in it (an executor finds it through
 * AsyncLocalStorage). A transaction opened inside another becomes a savepoint of it, which rolls back alone.
 */
import type { Logger } from '../log.ts';

/** Raised for requests the data does not allow: an unknown queue item, a playlist name already taken. */
export class StoreError extends Error {
  override name = 'StoreError';
}

/** A value bound to one of a statement's placeholders (`?`). */
export type SqlValue = string | number | bigint | null | Uint8Array;

/** A row as the database returns it, by column name. */
export type SqlRow = Readonly<Record<string, SqlValue>>;

/** What a statement that writes did. */
export interface RunResult {
  /** How many rows it inserted, changed or deleted. */
  readonly changes: number;
  /** The row ID an INSERT made (it means nothing after any other statement); null when the database does not say. */
  readonly lastId: number | null;
}

/** Which SQL the database speaks: the few statements that differ between databases are chosen by it. */
export type Dialect = 'sqlite' | 'postgres' | 'mysql';

/** The database program behind an executor, as the status, the doctor and `jukecord db status` name it. */
export interface DatabaseServer {
  /** Which program it is; MariaDB speaks the mysql dialect, with a few words of its own. */
  readonly product: 'SQLite' | 'PostgreSQL' | 'MySQL' | 'MariaDB';
  /** Its version as it says it, "3.50.4", "18.7" or "11.8.9" (MariaDB's own suffix left out). */
  readonly version: string;
}

/** How a transaction runs. */
export interface TransactionOptions {
  /**
   * Only reads, as one consistent view of the database that waits for no writer and holds none up: a copy of the
   * whole database, the statistics' several questions of one moment. Writing in it fails on the network databases.
   */
  readonly snapshot?: boolean;
}

/** What every executor may be given when it is opened. */
export interface ExecutorOptions {
  /** Where each statement, each transaction and the connections are reported (nothing reported when absent). */
  readonly report?: ExecutorReport;
  /** Where a connection lost while idle, or a transaction tried again, is said (nothing said when absent). */
  readonly log?: Pick<Logger, 'info' | 'warn' | 'error'>;
}

/** What a statement does, by its first word (a label of a metric: never a statement's text). */
export type StatementKind = 'select' | 'insert' | 'update' | 'delete' | 'transaction' | 'other';

/** How an executor's connections stand: lent to a statement or a transaction, idle, and callers waiting for one. */
export interface ConnectionUse {
  readonly busy: number;
  readonly idle: number;
  readonly waiting: number;
}

/**
 * Where an executor reports (the metrics make one into their families): each statement as it ends, timed from the
 * call (the wait for a connection included: what the caller waited), each transaction whole, from the moment it was
 * asked for to its commit or rollback, as `transaction` (a try the database refused, run again, is a failed one), and
 * how its connections stand, read when the metrics are written.
 */
export interface ExecutorReport {
  /** A statement (or a whole transaction) ended, `seconds` after it was asked for; `failed` when it threw. */
  query(kind: StatementKind, seconds: number, failed: boolean): void;
  /** Reads how the connections stand each time the metrics are written (called once, when the executor opens). */
  connections(read: () => ConnectionUse): void;
}

export interface SqlExecutor {
  readonly dialect: Dialect;
  /** The database program and its version (known once the executor is open). */
  readonly server: DatabaseServer;
  /** Whether statements can still run (false once closed): the readiness check asks this. */
  readonly isOpen: boolean;
  /** Every row a query returns, in its order. */
  all(sql: string, params?: readonly SqlValue[]): Promise<SqlRow[]>;
  /** The first row a query returns, or undefined when it returns none. */
  get(sql: string, params?: readonly SqlValue[]): Promise<SqlRow | undefined>;
  /** Runs one statement that writes. */
  run(sql: string, params?: readonly SqlValue[]): Promise<RunResult>;
  /** Runs several statements written out in one text (a migration), with no values to bind. */
  exec(sql: string): Promise<void>;
  /**
   * Runs `fn` in a transaction: everything it writes is kept, or nothing is if it throws (the error is passed on).
   * Inside another transaction it is a savepoint of it, which rolls back alone. Statements from outside the
   * transaction (another request, another server's lane) wait for its end on SQLite and see what was there before it
   * on the network databases, whose transactions are serializable: one that would have seen another's change in the
   * middle is run again from the start (so `fn` must do nothing but database work and keep nothing it read before a
   * failure). `fn` must await only database work, never the network or a timer, or everyone waits that long too.
   */
  transaction<T>(fn: () => Promise<T> | T, options?: TransactionOptions): Promise<T>;
  /** Closes the connection once no transaction holds it; statements after that fail. */
  close(): Promise<void>;
}

// The extended result codes node:sqlite puts on a constraint's failure: a UNIQUE constraint, and a PRIMARY KEY.
const SQLITE_CONSTRAINT_UNIQUE = 2067;
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;

/**
 * Whether an error is a database refusing a row whose key is taken (a UNIQUE or PRIMARY KEY constraint), whichever
 * driver raised it: what a repository turns into a refusal people can read (a playlist name already taken).
 */
export function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const fields = error as Error & { code?: unknown; errcode?: unknown; errno?: unknown };
  // SQLite (node:sqlite): the constraint's own extended result code.
  if (fields.errcode === SQLITE_CONSTRAINT_UNIQUE || fields.errcode === SQLITE_CONSTRAINT_PRIMARYKEY) return true;
  // PostgreSQL: unique_violation, the SQLSTATE of both.
  if (fields.code === '23505') return true;
  // MySQL and MariaDB: ER_DUP_ENTRY.
  return fields.errno === 1062;
}

/** The kind of a statement, by its first word: WITH reads, REPLACE inserts, a transaction's own words are its. */
export function statementKind(sql: string): StatementKind {
  // The first word after any spaces and comments a statement may start with.
  const word = /^(?:\s|--[^\n]*\n)*([a-z]+)/i.exec(sql)?.[1]?.toLowerCase();
  switch (word) {
    case 'select':
    case 'with':
      return 'select';
    case 'insert':
    case 'replace':
      return 'insert';
    case 'update':
      return 'update';
    case 'delete':
      return 'delete';
    case 'begin':
    case 'start':
    case 'commit':
    case 'rollback':
    case 'savepoint':
    case 'release':
      return 'transaction';
    default:
      return 'other';
  }
}

/** Seconds since `started` (a performance.now() reading), for a report. */
export function since(started: number): number {
  return (performance.now() - started) / 1000;
}
