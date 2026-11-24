/**
 * The SQL executor: the one way the store reaches its database.
 *
 * The repositories (src/store/store.ts) hold their SQL text and hand it here with its values; an executor runs it on
 * one kind of database and gives back plain rows. Every call returns a promise, because the drivers of network
 * databases (PostgreSQL, MySQL) have no other way to answer; the SQLite executor (src/store/sqlite.ts) answers at once
 * but keeps the same shape, so the store above it does not change with the database under it.
 *
 * Transactions follow the caller, not an argument: `transaction(async () => ...)` opens one, and every statement a
 * repository method runs inside that function, however deep, runs in it (an executor finds it through
 * AsyncLocalStorage). A transaction opened inside another becomes a savepoint of it, which rolls back alone.
 */

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

export interface SqlExecutor {
  readonly dialect: Dialect;
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
   * transaction (another request, another server's lane) wait for its end; so `fn` must await only database work,
   * never the network or a timer, or everyone else waits that long too.
   */
  transaction<T>(fn: () => Promise<T> | T): Promise<T>;
  /** Closes the connection once no transaction holds it; statements after that fail. */
  close(): Promise<void>;
}
