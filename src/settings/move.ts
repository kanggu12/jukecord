/**
 * Moving jukecord to another database from the panel, the API or the CLI: try the address (testDatabase), copy every
 * row into it while jukecord runs (start, with progress), then switch: jukecord stops as for a restart, copies once
 * more after every part that writes has stopped (so nothing written since the first copy stays behind), writes the
 * new address to settings.json, and is started again on it. The database in use is never changed: it stays as it was,
 * to go back to.
 *
 * The copy reads the database in use through a connection of its own (the one jukecord runs on keeps serving: a
 * SQLite file's one connection would be held for the whole copy otherwise), as `jukecord db copy` does, by the same
 * engine (src/store/copy.ts: one moment's view of the source, one transaction of the target).
 */
import fs from 'node:fs';
import path from 'node:path';
import { ActionError } from '../app/actions.ts';
import {
  AddressError,
  type DatabaseAddress,
  describeAddress,
  parseDatabaseAddress,
  sameDatabase,
} from '../store/address.ts';
import { copyStore } from '../store/copy.ts';
import { ConnectionError } from '../store/network.ts';
import { openExecutor, openStore } from '../store/open.ts';
import { TABLES } from '../store/schema.ts';
import { StoreError } from '../store/sql.ts';
import { type Backend, healthOf, LATEST_SCHEMA, Store } from '../store/store.ts';

/** What a test of a database's address found. */
export interface DatabaseTest {
  /** Whether jukecord could reach it and could move there. */
  readonly ok: boolean;
  /** The address in words (the kind and where, never the user or the password). */
  readonly where: string;
  readonly kind: Backend | null;
  /** The program and its version ("PostgreSQL 18.7"), when it answered. */
  readonly server: string | null;
  /** How long one statement took there and back, in milliseconds. */
  readonly roundTripMs: number | null;
  /** The jukecord schema it holds (0: none yet), and this jukecord's. */
  readonly schema: number | null;
  readonly latest: number;
  /** The rows of jukecord's tables there (0: empty), when it holds this jukecord's schema. */
  readonly rows: number | null;
  /** Whether it is the database in use now. */
  readonly inUse: boolean;
  /** Whether it is a SQLite file that is not there yet (the move makes it). */
  readonly newFile: boolean;
  /** Why it cannot be moved to, in one sentence, when it cannot. */
  readonly problem: string | null;
}

/** A move as it stands. */
export interface MoveState {
  readonly phase: 'copying' | 'copied' | 'failed' | 'switching';
  readonly where: string;
  readonly kind: Backend | null;
  /** Whether the target's data is replaced (it held some). */
  readonly replace: boolean;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  /** The rows copied so far of all there are, and the table being copied. */
  readonly rows: number;
  readonly total: number;
  readonly table: string | null;
  /** How long the copy took, once it is done. */
  readonly ms: number | null;
  /** Why it failed, when it did. */
  readonly error: string | null;
}

/** A move's last attempt to switch that did not finish, kept across the restart (move.json in the data folder). */
export interface MoveFailure {
  readonly at: number;
  readonly where: string;
  readonly reason: string;
}

/** The file a switch that failed leaves for the next start to say why. */
export const MOVE_FILE = 'move.json';

// How long a server that does not answer is waited for in a test or a move: a person waits at the page.
const WAIT_MS = 10_000;

// A database's address read for a move or a test; a mistake in it is said as the setting's problem is.
function addressOf(text: string, dataDir: string): DatabaseAddress {
  try {
    return parseDatabaseAddress(text, dataDir);
  } catch (error) {
    if (error instanceof AddressError) throw new ActionError('invalid', `JUKECORD_DATABASE_URL ${error.message}`);
    throw error;
  }
}

// The rows of jukecord's tables in a store (each table counted).
async function rowsIn(store: Store): Promise<number> {
  let rows = 0;
  for (const table of TABLES) rows += Number((await store.sql.get(`SELECT COUNT(*) AS n FROM ${table.name}`))?.n);
  return rows;
}

// Whether a folder can take a new file: the nearest one that exists is writable.
function writableFolder(file: string): boolean {
  let folder = path.dirname(file);
  while (!fs.existsSync(folder) && path.dirname(folder) !== folder) folder = path.dirname(folder);
  try {
    fs.accessSync(folder, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export interface DatabaseMoveOptions {
  /** The data folder, for a SQLite path written short and for move.json. */
  readonly dataDir: string;
  /** The database in use. */
  readonly current: DatabaseAddress;
  /** Connections at most to a server, for the copy's own. */
  readonly pool: number;
  readonly now?: () => number;
}

export class DatabaseMove {
  private readonly options: DatabaseMoveOptions;
  private readonly now: () => number;
  // The move under way or done, its target, and the way to stop its copy.
  private state: MoveState | null = null;
  private target: { address: DatabaseAddress; text: string } | null = null;
  private abort: AbortController | null = null;
  private copying: Promise<void> | null = null;

  constructor(options: DatabaseMoveOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /** Tries an address without saving or changing anything: whether it answers, its version, its schema, its rows. */
  async test(text: string, trust?: readonly string[]): Promise<DatabaseTest> {
    const address = addressOf(text, this.options.dataDir);
    const where = describeAddress(address);
    const inUse = sameDatabase(address, this.options.current);
    const base = { where, latest: LATEST_SCHEMA, inUse };
    // A SQLite file not made yet: nothing to ask, only whether its folder can take it.
    if (address.kind === 'sqlite' && !fs.existsSync(address.file)) {
      const ok = writableFolder(address.file);
      return {
        ...base,
        ok,
        kind: 'sqlite',
        server: null,
        roundTripMs: null,
        schema: null,
        rows: null,
        newFile: true,
        problem: ok ? null : `${path.dirname(address.file)} cannot take a new file`,
      };
    }
    let store: Store | null = null;
    try {
      // Tried once: a test is a question asked now, and the one asking can ask again.
      // Trusting, with the authorities in use, those the page has not saved yet when it gives some.
      const sql = await openExecutor(address, { pool: 1, waitMs: 0, ...(trust ? { trust } : {}) });
      const health = await healthOf(sql);
      const schema = health.schema;
      // Read without changing it: at this jukecord's schema only, as a copy's source would be.
      store = schema === LATEST_SCHEMA ? await Store.open(sql, { migrate: false }) : null;
      if (!store) await sql.close();
      const rows = store ? await rowsIn(store) : null;
      const problem = inUse
        ? 'it is the database jukecord uses now'
        : schema !== null && schema > LATEST_SCHEMA
          ? `it is at schema ${schema}, newer than this jukecord's (${LATEST_SCHEMA})`
          : schema !== null && schema > 0 && schema < LATEST_SCHEMA
            ? `it is at schema ${schema}, older than this jukecord's (${LATEST_SCHEMA}); start a jukecord on it first`
            : health.ok
              ? null
              : (health.error ?? 'it does not answer');
      return {
        ...base,
        ok: problem === null,
        kind: health.backend,
        server: health.server,
        roundTripMs: health.roundTripMs,
        schema,
        rows,
        newFile: false,
        problem,
      };
    } catch (error) {
      // Not reached, or refused: the reason in its words (never the password).
      const reason = error instanceof ConnectionError || error instanceof StoreError ? error.message : String(error);
      return {
        ...base,
        ok: false,
        kind: address.kind === 'sqlite' ? 'sqlite' : address.product === 'MariaDB' ? 'mariadb' : address.kind,
        server: null,
        roundTripMs: null,
        schema: null,
        rows: null,
        newFile: false,
        problem: reason,
      };
    } finally {
      await store?.close();
    }
  }

  /** The move as it stands, or null when none was started. */
  get current(): MoveState | null {
    return this.state;
  }

  /**
   * Starts copying every row into the database an address names: refused when one is under way, for the database in
   * use, and for one that holds jukecord's data unless it is to be replaced. Resolves once the copy has begun; the
   * state says how far it is.
   */
  async start(text: string, replace: boolean): Promise<MoveState> {
    if (this.state?.phase === 'copying' || this.state?.phase === 'switching')
      throw new ActionError('conflict', 'a move is under way already');
    const address = addressOf(text, this.options.dataDir);
    if (sameDatabase(address, this.options.current))
      throw new ActionError('invalid', 'that is the database jukecord uses now');
    const tested = await this.test(text);
    if (!tested.ok) throw new ActionError('conflict', `the database cannot be moved to: ${tested.problem}`);
    if (!replace && (tested.rows ?? 0) > 0)
      throw new ActionError(
        'conflict',
        'the database holds jukecord’s data already; move with replace to empty it first',
      );
    this.target = { address, text };
    this.abort = new AbortController();
    this.state = {
      phase: 'copying',
      where: tested.where,
      kind: tested.kind,
      replace,
      startedAt: this.now(),
      finishedAt: null,
      rows: 0,
      total: 0,
      table: null,
      ms: null,
      error: null,
    };
    const signal = this.abort.signal;
    this.copying = this.copy(address, replace, signal).then(
      (ms) => {
        if (this.state) this.state = { ...this.state, phase: 'copied', ms, table: null, finishedAt: this.now() };
      },
      (error: unknown) => {
        const reason = signal.aborted
          ? 'the move was cancelled'
          : error instanceof Error
            ? error.message
            : String(error);
        if (this.state) this.state = { ...this.state, phase: 'failed', error: reason, finishedAt: this.now() };
      },
    );
    return this.state;
  }

  /** Stops a copy under way (the target keeps what it held) and forgets the move. */
  async cancel(): Promise<void> {
    if (this.state?.phase === 'switching')
      throw new ActionError('conflict', 'the switch is under way; it cannot be stopped');
    this.abort?.abort();
    await this.copying;
    this.state = null;
    this.target = null;
  }

  /**
   * The switch's own copy, made once every part that writes has stopped (see src/main.ts's stop): every row again into
   * the target (it is emptied first, in the same transaction). Returns the address to write to settings.json.
   */
  async finalCopy(): Promise<string> {
    if (!this.target) throw new Error('no move to switch');
    await this.copy(this.target.address, true, new AbortController().signal);
    return this.target.text;
  }

  /** Marks the move as switching (refused unless its copy is done). */
  switching(): { readonly where: string } {
    if (this.state?.phase !== 'copied' || !this.target)
      throw new ActionError('conflict', 'there is no finished copy to switch to; copy the data first');
    this.state = { ...this.state, phase: 'switching' };
    return { where: this.state.where };
  }

  // One copy from the database in use (a connection of its own) into the target, following its progress.
  private async copy(address: DatabaseAddress, replace: boolean, signal: AbortSignal): Promise<number> {
    const started = this.now();
    const source = await Store.open(await openExecutor(this.options.current, { pool: 2, waitMs: WAIT_MS }), {
      migrate: false,
    });
    try {
      // The target at this jukecord's schema: made on an empty database, kept as it is on one that has it.
      const target = await openStore(address, { pool: Math.min(this.options.pool, 4), waitMs: WAIT_MS });
      try {
        await copyStore(source, target, {
          replace,
          signal,
          progress: (done) => {
            if (this.state?.phase === 'copying')
              this.state = { ...this.state, rows: done.rows, total: done.total, table: done.table };
          },
        });
      } finally {
        await target.close();
      }
    } finally {
      await source.close();
    }
    return this.now() - started;
  }

  /** The last switch that did not finish, from the run before (move.json), or null. */
  lastFailure(): MoveFailure | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.options.dataDir, MOVE_FILE), 'utf8')) as MoveFailure;
    } catch {
      return null;
    }
  }

  /** Says, for the next start, why the switch did not finish (the database in use stays). */
  recordFailure(reason: string): void {
    const failure: MoveFailure = { at: this.now(), where: this.state?.where ?? '', reason };
    fs.writeFileSync(path.join(this.options.dataDir, MOVE_FILE), `${JSON.stringify(failure)}\n`, { mode: 0o600 });
  }

  /** Forgets the last failure (a move that worked, or a new one started). */
  clearFailure(): void {
    fs.rmSync(path.join(this.options.dataDir, MOVE_FILE), { force: true });
  }
}

/** The kind of database an address names, as the status says it. */
export function backendOfAddress(address: DatabaseAddress): Backend {
  if (address.kind === 'sqlite') return 'sqlite';
  if (address.kind === 'postgres') return 'postgres';
  return address.product === 'MariaDB' ? 'mariadb' : 'mysql';
}
