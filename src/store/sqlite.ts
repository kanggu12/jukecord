/**
 * The SQLite executor: one database file in the data directory (or ":memory:" for tests), opened with Node's built-in
 * driver.
 *
 * node:sqlite needs no native add-on, so the same code runs on amd64 and arm64 without a compiler in the image. The
 * driver is still marked experimental in Node 24, which is why it stays behind this one file: if its interface
 * changes, only this file changes.
 *
 * The driver is synchronous: a statement runs to its end the moment it is called. What keeps it safe behind the
 * asynchronous executor is a lock around the one connection. SQLite has one transaction per connection, and a
 * transaction now spans awaits (a repository method writes, waits for the answer, writes again); while one is open,
 * every statement from outside it and every other transaction waits for its end, so nothing ever lands inside someone
 * else's transaction. The code inside it finds it through AsyncLocalStorage and runs on it at once.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { type DatabaseReport, type QueryKind, queryKind } from '../metrics/database.ts';
import { Lock } from '../util/lock.ts';
import { type RunResult, type SqlExecutor, type SqlRow, type SqlValue, StoreError } from './sql.ts';

// One open transaction or savepoint: how deep it is (1 for the outermost), whether it is still open (code it started
// can outlive it, and must not count as inside it then), and the lock its own savepoints take turns with.
interface Transaction {
  readonly depth: number;
  open: boolean;
  readonly savepoints: Lock;
}

// How many prepared statements are kept: the repositories have a hundred or so texts (the settings' few variants
// among them), so this keeps them all and still bounds a text made up at random.
const STATEMENTS_KEPT = 500;

// The outcome of synchronous work as a promise: its value, or its error as a rejection, never a throw at the call.
function settled<T>(work: () => T): Promise<T> {
  try {
    return Promise.resolve(work());
  } catch (error) {
    return Promise.reject(error);
  }
}

export class SqliteExecutor implements SqlExecutor {
  readonly dialect = 'sqlite' as const;
  /** The file path, or ":memory:" for the throwaway databases tests use. */
  readonly file: string;
  // The driver's connection; named for tests, which make its COMMIT fail to see the rollback.
  private readonly db: DatabaseSync;
  // The connection itself: held by a transaction from BEGIN to COMMIT, and waited for by everyone else meanwhile.
  private readonly lock = new Lock();
  // The transaction the code running now is inside, if any.
  private readonly current = new AsyncLocalStorage<Transaction>();
  // Prepared statements by their text, oldest first: preparing is most of what a simple statement costs (a thousand
  // rows written in a reorder took six times as long, prepared one by one), and the repositories' texts repeat.
  private readonly statements = new Map<string, StatementSync>();
  // Where each statement and transaction is reported (src/metrics/database.ts), or nowhere.
  private readonly report: DatabaseReport | null;

  private constructor(db: DatabaseSync, file: string, report: DatabaseReport | null) {
    this.db = db;
    this.file = file;
    this.report = report;
    // One connection: busy while a transaction holds it (a statement outside one runs to its end at once, so no scrape
    // ever finds it busy), idle otherwise, and none once closed; the waiting are those in line for the lock.
    report?.connections(() => {
      const open = this.db.isOpen;
      const busy = open && this.lock.locked ? 1 : 0;
      return { busy, idle: open ? 1 - busy : 0, waiting: this.lock.queued };
    });
  }

  /**
   * Opens (creating if needed) a database file, with the settings jukecord runs it with; `report` hears every statement
   * (the metrics).
   */
  static open(file: string, options: { readonly report?: DatabaseReport } = {}): SqliteExecutor {
    // The data directory may be new; SQLite does not create parent folders.
    if (file !== ':memory:') {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // A database copied in from elsewhere (a restore, a move between machines) keeps the mode it was copied with;
      // it is made this user's alone again, with its log files, which SQLite creates with the database's mode.
      for (const part of [file, `${file}-wal`, `${file}-shm`]) {
        try {
          fs.chmodSync(part, 0o600);
        } catch {
          // Not there yet (a new database), or not this user's to change: nothing to tighten.
        }
      }
    }
    // Foreign keys on (the driver's default, written out so it is not lost on a change of default); wait up to 5 s
    // for a lock instead of failing at once, which covers a backup running while the bot writes.
    const db = new DatabaseSync(file, { enableForeignKeyConstraints: true, timeout: 5000 });
    try {
      // WAL lets the panel read while the player writes; NORMAL sync is safe with WAL and much faster than FULL.
      if (file !== ':memory:') {
        db.exec('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA synchronous = NORMAL');
      }
    } catch (error) {
      // Not a database SQLite can use (a damaged file): the file is not held open behind the error.
      db.close();
      throw error;
    }
    return new SqliteExecutor(db, file, options.report ?? null);
  }

  get isOpen(): boolean {
    return this.db.isOpen;
  }

  all(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow[]> {
    // The driver's rows are plain objects of its own value types, every one of which is an SqlValue.
    return this.use(sql, () => this.prepared(sql).all(...params) as SqlRow[]);
  }

  get(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow | undefined> {
    return this.use(sql, () => this.prepared(sql).get(...params) as SqlRow | undefined);
  }

  run(sql: string, params: readonly SqlValue[] = []): Promise<RunResult> {
    return this.use(sql, () => {
      const result = this.prepared(sql).run(...params);
      // Counts and row IDs come as bigint past 2^53, which jukecord never reaches; plain numbers for the store.
      return { changes: Number(result.changes), lastId: Number(result.lastInsertRowid) };
    });
  }

  exec(sql: string): Promise<void> {
    return this.use(sql, () => {
      this.db.exec(sql);
    });
  }

  async transaction<T>(fn: () => Promise<T> | T): Promise<T> {
    // Inside a transaction still open: a savepoint of it.
    const parent = this.current.getStore();
    if (parent?.open) return this.savepoint(parent, fn);
    // A transaction is reported whole, from the moment it was asked for (its wait for the connection included).
    const asked = performance.now();
    let failed = true;
    // Otherwise the whole connection, for as long as `fn` runs: everyone else waits until the end.
    const release = await this.lock.acquire();
    const transaction: Transaction = { depth: 1, open: true, savepoints: new Lock() };
    try {
      // The outermost level takes SQLite's write lock at once (IMMEDIATE), so two writers queue up instead of
      // deadlocking (the backup worker's connection, or another program on the file).
      this.db.exec('BEGIN IMMEDIATE');
      let result: T;
      try {
        result = await this.current.run(transaction, fn);
      } catch (error) {
        // Nothing of it is kept. SQLite may have rolled back by itself already (a full disk, an I/O error); then
        // there is nothing to undo, and the error that happened is the one reported, not the rollback's.
        transaction.open = false;
        try {
          if (this.db.isTransaction) this.db.exec('ROLLBACK');
        } catch {
          // Nothing left to roll back.
        }
        throw error;
      }
      transaction.open = false;
      try {
        this.db.exec('COMMIT');
      } catch (error) {
        // The commit itself failed (a full disk shows up here in WAL mode): undo what is left of the transaction, so
        // the next one starts clean, and report the commit's own error.
        if (this.db.isTransaction) {
          try {
            this.db.exec('ROLLBACK');
          } catch {
            // Already rolled back by SQLite; nothing more to undo.
          }
        }
        throw error;
      }
      failed = false;
      return result;
    } finally {
      // Whatever happened, the transaction is over and the connection is the next one's.
      transaction.open = false;
      release();
      this.report?.query('transaction', (performance.now() - asked) / 1000, failed);
    }
  }

  // A transaction inside an open one: a savepoint, which rolls back alone and leaves the outer level to decide.
  private async savepoint<T>(parent: Transaction, fn: () => Promise<T> | T): Promise<T> {
    // Savepoints of one transaction take turns: two at once would release each other's names.
    const release = await parent.savepoints.acquire();
    // The transaction ended while this waited (its code did not wait for this one): this is a transaction of its own.
    if (!parent.open) {
      release();
      return this.transaction(fn);
    }
    const savepoint: Transaction = { depth: parent.depth + 1, open: true, savepoints: new Lock() };
    // Named by the level it is opened at, as before the executor: sp1 inside the outermost, sp2 inside that.
    const name = `sp${parent.depth}`;
    try {
      this.db.exec(`SAVEPOINT ${name}`);
      let result: T;
      try {
        result = await this.current.run(savepoint, fn);
      } catch (error) {
        // Roll back only this level; an outer level decides for itself what to do with the error. SQLite may have
        // rolled back the whole transaction by itself already; then there is nothing here to undo.
        savepoint.open = false;
        try {
          this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
        } catch {
          // Nothing left to roll back.
        }
        throw error;
      }
      savepoint.open = false;
      this.db.exec(`RELEASE ${name}`);
      return result;
    } finally {
      savepoint.open = false;
      release();
    }
  }

  async close(): Promise<void> {
    // Inside a transaction (a test that closes halfway): closed now, as before the executor; its next statement fails.
    if (this.inside()) {
      this.shut();
      return;
    }
    // Otherwise once no transaction holds the connection: closed under one, it would end halfway.
    const release = await this.lock.acquire();
    try {
      this.shut();
    } finally {
      release();
    }
  }

  // Closes the connection and lets its prepared statements go, so a statement after this fails as one would on a
  // closed connection (the database is not open), not on a statement the close ended.
  private shut(): void {
    this.statements.clear();
    if (this.db.isOpen) this.db.close();
  }

  // The prepared statement for a text: kept from before, or prepared now and kept (the oldest let go past the bound).
  private prepared(sql: string): StatementSync {
    const kept = this.statements.get(sql);
    if (kept) return kept;
    const statement = this.db.prepare(sql);
    this.statements.set(sql, statement);
    if (this.statements.size > STATEMENTS_KEPT) {
      const oldest = this.statements.keys().next().value;
      if (oldest !== undefined) this.statements.delete(oldest);
    }
    return statement;
  }

  /**
   * Writes a consistent copy of the database to `target` (VACUUM INTO) on this connection, once no transaction holds
   * it: VACUUM cannot run inside one.
   */
  async vacuumInto(target: string): Promise<void> {
    await this.run('VACUUM INTO ?', [target]);
  }

  /**
   * vacuumInto(), written by a worker thread with a connection of its own: a copy of a large database takes seconds, and
   * made on this thread it held it all that time (the voices' audio stood still, the panel waited, and past thirty
   * seconds the watchdog ended jukecord). The copy is the same consistent snapshot: the database is in WAL mode, where
   * a reader and this connection's writes do not wait for each other. Only for a file: an in-memory database has none
   * for another connection to open.
   */
  vacuumIntoAside(target: string): Promise<void> {
    if (this.file === ':memory:') return Promise.reject(new StoreError('an in-memory database has no file to copy'));
    return vacuumInto(this.file, target);
  }

  // Whether the code running now is inside a transaction (or savepoint) of this connection that is still open.
  private inside(): boolean {
    return this.current.getStore()?.open === true;
  }

  // Runs one statement: at once inside the caller's open transaction, otherwise once the connection is free.
  private use<T>(sql: string, statement: () => T): Promise<T> {
    // Reported, when there is a report, by its kind and the time from now to its end (a wait in line included); timed
    // around the work itself, so reporting adds no turn of the event loop to any statement.
    const work = this.report === null ? statement : this.measured(queryKind(sql), statement);
    // Inside a transaction still open: it holds the connection, and its own statements run on it.
    if (this.inside()) return settled(work);
    // Free: the statement runs to its end now (the driver is synchronous), so nothing can come between.
    if (!this.lock.locked) return settled(work);
    // Held by a transaction, or wanted by ones waiting already: in line behind them, in the order asked.
    return this.lock.acquire().then((release) => {
      try {
        return work();
      } finally {
        release();
      }
    });
  }

  // A statement's work, reporting when it ends how long it took since now and whether it threw.
  private measured<T>(kind: QueryKind, statement: () => T): () => T {
    const report = this.report;
    const asked = performance.now();
    return () => {
      let failed = true;
      try {
        const result = statement();
        failed = false;
        return result;
      } finally {
        report?.query(kind, (performance.now() - asked) / 1000, failed);
      }
    };
  }
}

// The worker's own code (plain JavaScript, run as it is): a read-only connection to the database file, VACUUM INTO
// the target, and the outcome posted back. Waits up to five seconds for a lock, as the main connection does.
const VACUUM_WORKER = `
const { workerData, parentPort } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
let db = null;
try {
  db = new DatabaseSync(workerData.source, { readOnly: true, timeout: 5000 });
  db.prepare('VACUUM INTO ?').run(workerData.target);
  parentPort.postMessage({ ok: true });
} catch (error) {
  parentPort.postMessage({ ok: false, message: String((error && error.message) || error) });
} finally {
  if (db) db.close();
}
`;

// Copies the database file `source` into `target` in a worker thread; rejects with the worker's reason.
function vacuumInto(source: string, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(VACUUM_WORKER, { eval: true, workerData: { source, target } });
    // The worker's answer: done, or why not.
    worker.once('message', (answer: { ok: boolean; message?: string }) => {
      if (answer.ok) resolve();
      else reject(new StoreError(`could not write the backup: ${answer.message ?? 'no reason given'}`));
    });
    // A worker that could not start, or ended without an answer (out of memory).
    worker.once('error', (error) => reject(error));
    worker.once('exit', (code) => {
      if (code !== 0) reject(new StoreError(`the backup's worker ended with code ${code}`));
    });
  });
}
