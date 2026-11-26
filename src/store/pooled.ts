/**
 * What the executors of the network databases share (src/store/postgres.ts, src/store/mysql.ts): a pool of
 * connections, transactions that follow the caller, savepoints, serializable transactions run again when the
 * database refuses them halfway, and the report of each statement. Each driver's executor says only how to take a connection, run a
 * statement on it and begin a transaction.
 *
 * A transaction holds one connection of the pool from its BEGIN to its COMMIT; the code inside finds it through
 * AsyncLocalStorage, as on SQLite, and every statement it runs (however deep) runs on that connection. Statements
 * from outside run at once on another connection and see what was there before the transaction.
 *
 * A transaction runs at the serializable level unless it says what keeps its writers in order: the level that gives
 * what SQLite gives (one writer at a time) to whatever it reads and writes. When two would have seen each other
 * halfway, the database refuses one of them (a serialization failure on PostgreSQL, a deadlock on MySQL), and it is
 * run again from its start, a few times. That is why a transaction's function does database work only: run twice, it
 * must do the same twice.
 *
 * The serializable level also refuses transactions that never touched each other's rows: PostgreSQL tracks what a
 * transaction read by index pages and whole tables (a small table is read whole), MariaDB locks the gaps between rows
 * it read, so ten servers' queues at once, each in its own lane, used up the tries, and fifty browsers at once at one
 * listening link used up some of theirs. So jukecord's own transactions say what orders them (TransactionOptions):
 * - work whose writers take turns already (a server's lane) or that no check of its own hangs on (a row written and
 *   read back) runs at READ COMMITTED (latest), which refuses nothing: two of those only wait for a row both write;
 * - a check and the write that hangs on it (a login's likes at their limit, a link's last guest place) takes a turn
 *   on its key (turn): a lock of the database's own, which those of the same key wait for in line, at READ COMMITTED.
 * Statements outside a transaction run at READ COMMITTED too, each whole on its own.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { Lock } from '../util/lock.ts';
import type { ServerAddress } from './address.ts';
import { ConnectionError, connectionFailure, pause } from './network.ts';
import {
  type DatabaseServer,
  type Dialect,
  type ExecutorOptions,
  type ExecutorReport,
  type RunResult,
  refuseNul,
  type SqlExecutor,
  type SqlRow,
  type SqlValue,
  since,
  statementKind,
  type TransactionOptions,
} from './sql.ts';

/** What a pool of connections to a server is opened with. */
export interface PoolOptions extends ExecutorOptions {
  /** How many connections at most (JUKECORD_DATABASE_POOL, 10 by default). */
  readonly pool?: number;
  /** How long one statement may run before the server ends it (30 s by default). */
  readonly statementTimeoutMs?: number;
  /**
   * How long jukecord waits for a statement's answer before it gives the connection up (PostgreSQL's: the statement's
   * own limit and 10 s more by default, for an answer that never comes over a connection lost without a word).
   */
  readonly answerTimeoutMs?: number;
  /** How long an unused connection stays open (30 s by default; tests that open many pools close them sooner). */
  readonly idleMs?: number;
  /**
   * The authorities this pool's TLS trusts in place of Node's default list, when the address names none of its own
   * (the settings page's test of an address with authorities not saved yet: src/settings/authorities.ts).
   */
  readonly trust?: readonly string[];
}

/** How long an unused connection stays open by default: a quiet jukecord holds none open for long. */
export const IDLE_MS = 30_000;

/** The connections a pool opens at most when nothing says (JUKECORD_DATABASE_POOL). */
export const DEFAULT_POOL = 10;
/** How long a statement may run by default: past it the server ends the statement (and its transaction fails). */
export const STATEMENT_TIMEOUT_MS = 30_000;
/** How long a statement waits for a row another transaction holds before it fails (no transaction holds one long). */
export const LOCK_TIMEOUT_MS = 10_000;

/** What a database answered to one statement, in the store's terms. */
export interface Answer {
  readonly rows: SqlRow[];
  readonly changes: number;
  readonly lastId: number | null;
}

/** A statement with its values. */
export interface Statement {
  readonly sql: string;
  readonly params: readonly SqlValue[];
}

/** How a transaction takes and gives back its turn on a key (see PooledExecutor.turn). */
export interface Turn {
  readonly take: Statement;
  /** Whether the answer to `take` says the turn was had (MySQL's named lock says 0 when it waited in vain). */
  taken(answer: Answer): boolean;
  readonly give: Statement | null;
}

/** How long a transaction waits for its turn before it fails (as long as a wait for a row). */
export const TURN_WAIT_MS = LOCK_TIMEOUT_MS;

// How many times a transaction (or a statement outside one) the database refused halfway is run in all.
const ATTEMPTS = 6;

// The pause before running again: 10, 20, 40, 80, 160 ms, each with up to as much again at random, so two that
// collided do not collide again in step.
function backoff(attempt: number): number {
  const base = 10 * 2 ** (attempt - 1);
  return base + Math.random() * base;
}

// What a transaction and all its savepoints share: the connection, and how it went.
interface Root<C> {
  readonly connection: C;
  // The error with which the database refused the transaction (to be run again): nothing more runs in it.
  doomed: Error | null;
  // The connection itself failed: nothing more runs on it, and it is closed instead of given back to the pool.
  broken: boolean;
}

// One open transaction or savepoint, as SQLite's executor keeps them (see src/store/sqlite.ts).
interface Transaction<C> {
  readonly depth: number;
  open: boolean;
  readonly savepoints: Lock;
  readonly root: Root<C>;
}

// The outcome of one try of a transaction: its value, or its error and whether trying again may help.
type Attempt<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown; readonly again: boolean };

export abstract class PooledExecutor<C> implements SqlExecutor {
  abstract readonly dialect: Dialect;
  /** The server and its version, as it said when the pool was opened. */
  readonly server: DatabaseServer;
  /** Where the database is (for messages: never with the password). */
  protected readonly address: ServerAddress;
  // Where each statement and transaction is reported (see ExecutorReport), or nowhere.
  protected readonly report: ExecutorReport | null;
  // The transaction the code running now is inside, if any.
  private readonly current = new AsyncLocalStorage<Transaction<C>>();
  // Set by close(): no statement starts outside a transaction after it (closing), and once the transactions that held
  // a connection then have ended, none at all (closed).
  private closing = false;
  private closed = false;
  // How many transactions hold a connection now, and who waits for them all to end (close()).
  private holding = 0;
  private readonly whenFree: (() => void)[] = [];
  // The lines of the turns' keys in this process (see transaction()), each with how many are in it.
  private readonly lines = new Map<string, { readonly lock: Lock; people: number }>();

  protected constructor(address: ServerAddress, server: DatabaseServer, options: ExecutorOptions) {
    this.address = address;
    this.server = server;
    this.report = options.report ?? null;
  }

  /** Takes a connection of the pool for a transaction. */
  protected abstract acquire(): Promise<C>;
  /** Gives a transaction's connection back to the pool, or closes it when it is broken. */
  protected abstract release(connection: C, broken: boolean): void;
  /** Runs one statement on a connection, or on any of the pool's (null): values bound, or none for several at once. */
  protected abstract execute(
    connection: C | null,
    sql: string,
    params: readonly SqlValue[] | undefined,
  ): Promise<Answer>;
  /**
   * The statements that begin a transaction: a serializable one, a snapshot that only reads, or one whose every
   * statement sees the latest committed rows (see TransactionOptions).
   */
  protected abstract begin(mode: 'serializable' | 'snapshot' | 'latest'): readonly string[];
  /**
   * How a transaction takes its turn on a key (TransactionOptions.turn): the statement run right after it begins,
   * whether its answer says the turn was had, and the statement that gives the turn back once the transaction has
   * ended (none where the turn ends with the transaction itself).
   */
  protected abstract turn(key: string): Turn;
  /** Whether the database refused a statement for another transaction's sake, so that running it again may work. */
  protected abstract refused(error: unknown): boolean;
  /** Whether an error means the connection itself is gone (cut, timed out, closed by the server). */
  protected abstract lost(error: unknown): boolean;
  /** Closes every connection of the pool. */
  protected abstract end(): Promise<void>;

  get isOpen(): boolean {
    return !this.closing && !this.closed;
  }

  async all(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow[]> {
    return (await this.statement(sql, params)).rows;
  }

  async get(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow | undefined> {
    return (await this.statement(sql, params)).rows[0];
  }

  async run(sql: string, params: readonly SqlValue[] = []): Promise<RunResult> {
    const answer = await this.statement(sql, params);
    return { changes: answer.changes, lastId: answer.lastId };
  }

  async exec(sql: string): Promise<void> {
    await this.statement(sql, undefined);
  }

  async transaction<T>(fn: () => Promise<T> | T, options: TransactionOptions = {}): Promise<T> {
    // Inside a transaction still open: a savepoint of it.
    const parent = this.current.getStore();
    if (parent?.open) return this.savepoint(parent, fn);
    // Those of one turn's key in this process wait in line here, holding no connection of the pool, and only the one
    // at the front waits on the database (for another jukecord's transaction of that key): a crowd at one listening
    // link held every connection, waiting, and another server's statements waited half a second for one.
    const inLine = options.turn === undefined || options.snapshot ? null : await this.line(options.turn);
    try {
      for (let attempt = 1; ; attempt += 1) {
        const outcome = await this.attempt(fn, options);
        if (outcome.ok) return outcome.value;
        // Refused for another transaction's sake: run again from the start, after a pause, a few times.
        if (outcome.again && attempt < ATTEMPTS) {
          await pause(backoff(attempt));
          continue;
        }
        throw outcome.error;
      }
    } finally {
      inLine?.();
    }
  }

  // A place in this process's line for a turn's key (see transaction()); the line is let go when nobody is in it.
  private async line(key: string): Promise<() => void> {
    let line = this.lines.get(key);
    if (line === undefined) {
      line = { lock: new Lock(), people: 0 };
      this.lines.set(key, line);
    }
    const mine = line;
    mine.people += 1;
    const release = await mine.lock.acquire();
    return () => {
      release();
      mine.people -= 1;
      if (mine.people === 0 && this.lines.get(key) === mine) this.lines.delete(key);
    };
  }

  async close(): Promise<void> {
    if (this.closing || this.closed) return;
    // Inside a transaction (a test that closes halfway): closed now, as SQLite's executor does; its next statement fails.
    if (this.current.getStore()?.open) {
      this.closed = true;
      void this.end().catch(() => {});
      return;
    }
    // Otherwise once no transaction holds a connection: closed under one, it would end halfway. Those holding one go
    // on to their end meanwhile; nothing new starts.
    this.closing = true;
    while (this.holding > 0) await new Promise<void>((resolve) => this.whenFree.push(resolve));
    this.closed = true;
    await this.end();
  }

  // One try of a transaction on a connection of its own.
  private async attempt<T>(fn: () => Promise<T> | T, options: TransactionOptions): Promise<Attempt<T>> {
    if (this.closing || this.closed) throw closedError();
    // The try reported whole, from now (its wait for a connection included) to its commit or rollback; a try the
    // database refused is a failed one.
    const asked = performance.now();
    let outcome: Attempt<T>;
    try {
      outcome = await this.tried(fn, options);
    } catch (error) {
      this.report?.query('transaction', since(asked), true);
      throw error;
    }
    this.report?.query('transaction', since(asked), !outcome.ok);
    return outcome;
  }

  // One try of a transaction (see attempt()).
  private async tried<T>(fn: () => Promise<T> | T, options: TransactionOptions): Promise<Attempt<T>> {
    let connection: C;
    try {
      connection = await this.acquire();
    } catch (error) {
      throw connectionFailure(error, this.address) ?? error;
    }
    const root: Root<C> = { connection, doomed: null, broken: false };
    const transaction: Transaction<C> = { depth: 1, open: true, savepoints: new Lock(), root };
    // The turn this transaction takes on a key, if it asks for one (a snapshot only reads, and takes none).
    const turn = options.turn === undefined || options.snapshot ? null : this.turn(options.turn);
    let turnHeld = false;
    this.holding += 1;
    try {
      // A transaction that takes a turn is at READ COMMITTED: the turn keeps its check true (see TransactionOptions).
      const mode = options.snapshot ? 'snapshot' : options.latest || turn !== null ? 'latest' : 'serializable';
      for (const statement of this.begin(mode)) await this.on(root, statement, undefined, true);
      if (turn !== null) {
        // In line behind every transaction of the same key, on the database: one at a time, whichever jukecord.
        if (!turn.taken(await this.on(root, turn.take.sql, turn.take.params, true))) {
          throw new Error(`waited ${TURN_WAIT_MS / 1000} s in vain for the turn of "${options.turn}"`);
        }
        turnHeld = true;
      }
      let value: T;
      try {
        value = await this.current.run(transaction, fn);
      } catch (error) {
        // Nothing of it is kept. Refused by the database (even when the function caught that and threw something
        // else): run again. Any other error is the transaction's own, passed on.
        transaction.open = false;
        await this.rollback(root);
        const again = root.doomed !== null;
        return { ok: false, error: again ? root.doomed : error, again };
      }
      transaction.open = false;
      // Refused halfway, though the function went on: nothing of it is kept, and it is run again.
      if (root.doomed) {
        await this.rollback(root);
        return { ok: false, error: root.doomed, again: true };
      }
      try {
        await this.on(root, 'COMMIT', undefined);
      } catch (error) {
        // A serialization failure can come at the commit; a lost connection there leaves the outcome unknown, which
        // is said, not tried again (it may have been kept).
        await this.rollback(root);
        return { ok: false, error, again: root.doomed !== null };
      }
      return { ok: true, value };
    } catch (error) {
      // BEGIN itself failed (the connection lost on the way), or the turn was not had: nothing to undo but the BEGIN.
      await this.rollback(root);
      return { ok: false, error, again: root.doomed !== null };
    } finally {
      transaction.open = false;
      // The turn given back once the transaction has ended (MySQL's named lock outlives it), on its own connection; a
      // connection that cannot is closed, which gives it back too.
      if (turnHeld && turn?.give && !root.broken) {
        try {
          await this.execute(connection, turn.give.sql, turn.give.params);
        } catch {
          root.broken = true;
        }
      }
      this.release(connection, root.broken);
      this.holding -= 1;
      if (this.holding === 0) for (const resolve of this.whenFree.splice(0)) resolve();
    }
  }

  // A transaction inside an open one: a savepoint, which rolls back alone and leaves the outer level to decide.
  private async savepoint<T>(parent: Transaction<C>, fn: () => Promise<T> | T): Promise<T> {
    // Savepoints of one transaction take turns: two at once would release each other's names.
    const release = await parent.savepoints.acquire();
    // The transaction ended while this waited (its code did not wait for this one): this is a transaction of its own.
    if (!parent.open) {
      release();
      return this.transaction(fn);
    }
    const savepoint: Transaction<C> = {
      depth: parent.depth + 1,
      open: true,
      savepoints: new Lock(),
      root: parent.root,
    };
    // Named by the level it is opened at, as on SQLite: sp1 inside the outermost, sp2 inside that.
    const name = `sp${parent.depth}`;
    try {
      await this.on(parent.root, `SAVEPOINT ${name}`, undefined);
      let result: T;
      try {
        result = await this.current.run(savepoint, fn);
      } catch (error) {
        savepoint.open = false;
        // Only this level is undone, unless the whole transaction is to be run again (or its connection is gone):
        // then there is nothing to keep of it anyway.
        if (!parent.root.doomed && !parent.root.broken) {
          try {
            await this.on(parent.root, `ROLLBACK TO SAVEPOINT ${name}`, undefined);
            await this.on(parent.root, `RELEASE SAVEPOINT ${name}`, undefined);
          } catch {
            // The rollback failed too: the outer level fails on its next statement, or at its commit.
          }
        }
        throw error;
      }
      savepoint.open = false;
      await this.on(parent.root, `RELEASE SAVEPOINT ${name}`, undefined);
      return result;
    } finally {
      savepoint.open = false;
      release();
    }
  }

  // Undoes what is left of a transaction; a connection that cannot even do that is closed rather than reused.
  private async rollback(root: Root<C>): Promise<void> {
    if (root.broken) return;
    try {
      await this.execute(root.connection, 'ROLLBACK', undefined);
    } catch {
      root.broken = true;
    }
  }

  // Runs one statement: on the transaction's connection inside one, otherwise on any connection of the pool, run
  // again when the database refused it for another transaction's sake (nothing of a refused statement happened).
  private async statement(sql: string, params: readonly SqlValue[] | undefined): Promise<Answer> {
    // A text value with a NUL in it is refused before anything is sent, as on every database (see refuseNul).
    if (params !== undefined) refuseNul(params);
    const transaction = this.current.getStore();
    if (transaction?.open) return this.on(transaction.root, sql, params);
    if (this.closing || this.closed) throw closedError();
    for (let attempt = 1; ; attempt += 1) {
      // Reported from the call, the wait for a connection of the pool included.
      const asked = performance.now();
      try {
        const answer = await this.execute(null, sql, params);
        this.report?.query(statementKind(sql), since(asked), false);
        return answer;
      } catch (error) {
        this.report?.query(statementKind(sql), since(asked), true);
        if (this.refused(error) && attempt < ATTEMPTS) {
          await pause(backoff(attempt));
          continue;
        }
        throw this.lost(error) || !hasCode(error) ? (connectionFailure(error, this.address) ?? error) : error;
      }
    }
  }

  // Runs one statement on a transaction's connection, noting a refusal (the transaction is run again) or a lost
  // connection (nothing more runs on it).
  private async on(root: Root<C>, sql: string, params: readonly SqlValue[] | undefined, own = false): Promise<Answer> {
    if (root.doomed) throw root.doomed;
    if (root.broken) throw new ConnectionError('the connection of this transaction was lost', false);
    if (this.closed && sql !== 'ROLLBACK') throw closedError();
    // A statement of the transaction's own (BEGIN and what sets its level up, its turn, SAVEPOINT, COMMIT) is part of
    // the transaction's report, not one of its own.
    const kind = own ? 'transaction' : statementKind(sql);
    const asked = performance.now();
    try {
      const answer = await this.execute(root.connection, sql, params);
      if (kind !== 'transaction') this.report?.query(kind, since(asked), false);
      return answer;
    } catch (error) {
      if (kind !== 'transaction') this.report?.query(kind, since(asked), true);
      if (this.refused(error)) root.doomed = error instanceof Error ? error : new Error(String(error));
      if (this.lost(error)) {
        root.broken = true;
        throw connectionFailure(error, this.address) ?? error;
      }
      throw error;
    }
  }
}

// Whether a driver's error carries the database's own code (a statement's error) rather than none (the network's):
// MySQL's errors have an SQLSTATE of their own, PostgreSQL's have one as their code (five characters with a digit in
// them, where Node's own codes are words: EPIPE, ECONNREFUSED).
function hasCode(error: unknown): boolean {
  const fields = error as { code?: unknown; sqlState?: unknown } | null;
  return (
    typeof fields?.sqlState === 'string' ||
    (typeof fields?.code === 'string' && /^(?=.*\d)[0-9A-Z]{5}$/.test(fields.code))
  );
}

// The error of a statement asked for after close().
function closedError(): Error {
  return new Error('the database connection is closed');
}
