/**
 * Opening the database an address names (JUKECORD_DATABASE_URL): the executor of its kind, the store over it with
 * its schema brought up to date.
 *
 * A database server that does not answer yet is waited for, up to a minute by default, a little longer between each
 * try: a database container started beside jukecord takes a few seconds to take connections, and a name in a
 * cluster's DNS may come a moment after the pod. Each failed try is said with its reason; a failure that waiting does
 * not mend (a wrong password, no such database, a certificate refused) ends the wait at once. The executors of the
 * network databases, and their drivers, are loaded only for an address of theirs.
 */
import type { Logger } from '../log.ts';
import { type DatabaseAddress, describeAddress } from './address.ts';
import { ConnectionError, pause } from './network.ts';
import type { PoolOptions } from './pooled.ts';
import type { SqlExecutor } from './sql.ts';
import { SqliteExecutor } from './sqlite.ts';
import { Store } from './store.ts';

/** How a database is opened. */
export interface OpenOptions extends PoolOptions {
  /** How long to wait for a server that does not answer yet (a minute by default; 0 tries once). */
  readonly waitMs?: number;
  /** Where each failed try is said, and where the executors say a connection lost while idle. */
  readonly log?: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** The store's clock (tests fix it). */
  readonly now?: () => number;
}

/** How long a start waits for a database server by default. */
export const WAIT_MS = 60_000;

// The pause before the next try: half a second, then twice as long each time, five seconds at most.
function delay(attempt: number): number {
  return Math.min(5_000, 500 * 2 ** (attempt - 1));
}

/**
 * The executor of an address's database (a SQLite file is opened at once; a server is waited for while waiting may
 * help). A failure is a ConnectionError that names the database (never its password) and says why.
 */
export async function openExecutor(address: DatabaseAddress, options: OpenOptions = {}): Promise<SqlExecutor> {
  const executor = {
    ...(options.report ? { report: options.report } : {}),
    ...(options.log ? { log: options.log } : {}),
  };
  if (address.kind === 'sqlite') {
    return SqliteExecutor.open(address.file, options.readOnly === true ? { ...executor, readOnly: true } : executor);
  }
  const waitMs = options.waitMs ?? WAIT_MS;
  const started = Date.now();
  for (let attempt = 1; ; attempt += 1) {
    try {
      // The executor's module (and with it its driver) loaded on the first try only, and only for its kind.
      if (address.kind === 'postgres') {
        const { PostgresExecutor } = await import('./postgres.ts');
        return await PostgresExecutor.open(address, options);
      }
      const { MysqlExecutor } = await import('./mysql.ts');
      return await MysqlExecutor.open(address, options);
    } catch (error) {
      if (!(error instanceof ConnectionError)) throw error;
      const pauseMs = delay(attempt);
      // Waiting may not help, or has gone on long enough: the reason, with the database it is about.
      if (!error.transient || Date.now() - started + pauseMs > waitMs) {
        const waited =
          Date.now() - started >= 1000 ? ` (tried for ${Math.round((Date.now() - started) / 1000)} s)` : '';
        throw new ConnectionError(`${describeAddress(address)}: ${error.message}${waited}`, false, { cause: error });
      }
      options.log?.warn('the database does not answer yet; trying again', {
        database: describeAddress(address),
        reason: error.message,
        inSeconds: pauseMs / 1000,
      });
      await pause(pauseMs);
    }
  }
}

/** The store of an address's database: its executor (see openExecutor), and the schema brought up to date. */
export async function openStore(address: DatabaseAddress, options: OpenOptions = {}): Promise<Store> {
  const sql = await openExecutor(address, options);
  return Store.open(sql, options.now ? { now: options.now } : {});
}
