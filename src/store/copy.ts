/**
 * The copy of a whole database into another, of the same kind or not: `jukecord db copy` (moving to PostgreSQL, back
 * to SQLite), the backups of a server database (a SQLite file, the kind SQLite's own backups are, so any backup goes
 * back into any database), and a restore into one.
 *
 * The source is read as one moment's view (a snapshot transaction: what it held when the copy began, whatever jukecord
 * writes there meanwhile), table by table in the order of their foreign keys, a page of rows at a time by the table's
 * key. The target is written in one transaction, in batches of rows: a copy that fails leaves the target as it was. A
 * target that holds data is refused unless it is to be replaced, and then emptied first, in that same transaction.
 * Ids are copied as they are; PostgreSQL's identities are set past the highest copied (MySQL's AUTO_INCREMENT and
 * SQLite's rowid move past an id written by themselves). The rows of each table are counted in the target before the
 * commit, against those read.
 */
import { TABLES, type Table } from './schema.ts';
import { type SqlRow, type SqlValue, StoreError } from './sql.ts';
import type { Store } from './store.ts';

export interface CopyOptions {
  /** Empty a target that holds data first; without it such a target is refused (nothing is changed). */
  readonly replace?: boolean;
  /** Rows read from the source at a time (500 by default). */
  readonly page?: number;
}

/** What a copy did. */
export interface CopyReport {
  /** Each table, in the order copied, with its rows. */
  readonly tables: readonly { readonly name: string; readonly rows: number }[];
  /** The rows of every table. */
  readonly rows: number;
  /** How long it took, in milliseconds. */
  readonly ms: number;
}

// Rows read at a time: a few hundred kilobytes in memory, and few enough round trips for a database of a million rows.
const PAGE = 500;

// The most a batch of rows written at once may hold, about: MariaDB takes 16 MiB in one packet by default, and a
// track's lyrics may be 64,000 characters of four bytes each.
const BATCH_BYTES = 4 * 1024 * 1024;

// The name the column that orders a table without an id is read under (SQLite's rowid, the servers' seq).
const ORDER = 'jk_order';

// The `?, ?, ?` of a row of values.
function marks(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/** Copies every row of `from` into `to`; both are open at this jukecord's schema. */
export async function copyStore(from: Store, to: Store, options: CopyOptions = {}): Promise<CopyReport> {
  const started = performance.now();
  const page = options.page ?? PAGE;
  // One moment's view of the source for the whole copy, and one transaction of the target for all of it.
  const tables = await from.transaction(
    () =>
      to.transaction(async () => {
        await clear(to, options.replace === true);
        const copied: { name: string; rows: number }[] = [];
        for (const table of TABLES) {
          const rows = await copyTable(from, to, table, page);
          copied.push({ name: table.name, rows });
        }
        // Every row read is in the target, table by table, before anything is kept.
        for (const entry of copied) {
          const there = await to.sql.get(`SELECT COUNT(*) AS n FROM ${entry.name}`);
          if (Number(there?.n) !== entry.rows) {
            throw new StoreError(
              `${entry.name}: ${entry.rows} rows were read, but ${String(there?.n)} are in the target`,
            );
          }
        }
        await identitiesPast(to);
        return copied;
      }),
    { snapshot: true },
  );
  return {
    tables,
    rows: tables.reduce((sum, entry) => sum + entry.rows, 0),
    ms: Math.round(performance.now() - started),
  };
}

// A target that holds data is refused, or emptied when it is to be replaced (the tables that refer to others first).
async function clear(to: Store, replace: boolean): Promise<void> {
  const held: string[] = [];
  for (const table of TABLES) {
    if (await to.sql.get(`SELECT 1 AS found FROM ${table.name} LIMIT 1`)) held.push(table.name);
  }
  if (held.length === 0) return;
  if (!replace) {
    throw new StoreError(
      `the target already holds jukecord's data (${held.join(', ')}); give --replace to empty it first`,
    );
  }
  for (const table of [...TABLES].reverse()) await to.sql.run(`DELETE FROM ${table.name}`);
}

// How a table is read in pages: by its key, or (a table without an id that keeps its rows' order) by the column
// that keeps it, read under a name of its own.
function orderOf(store: Store, table: Table): { readonly columns: readonly string[]; readonly extra: string } {
  if (table.ordered)
    return { columns: [store.dialect.insertionOrder], extra: `, ${store.dialect.insertionOrder} AS ${ORDER}` };
  return { columns: table.key.map((column) => store.dialect.column(column)), extra: '' };
}

// Copies one table, a page at a time, and says how many rows it had.
async function copyTable(from: Store, to: Store, table: Table, page: number): Promise<number> {
  const order = orderOf(from, table);
  const columns = table.columns.map((column) => from.dialect.column(column)).join(', ');
  const select = `SELECT ${columns}${order.extra} FROM ${table.name}`;
  const ordered = `ORDER BY ${order.columns.join(', ')} LIMIT ${page}`;
  // The key of the last row of a page, from which the next page starts (a row's key is above it).
  let after: SqlValue[] | null = null;
  let total = 0;
  for (;;) {
    const rows: SqlRow[] =
      after === null
        ? await from.sql.all(`${select} ${ordered}`)
        : await from.sql.all(
            `${select} WHERE (${order.columns.join(', ')}) > (${marks(after.length)}) ${ordered}`,
            after,
          );
    if (rows.length === 0) break;
    await insertRows(to, table, rows);
    total += rows.length;
    if (rows.length < page) break;
    const last = rows.at(-1) ?? {};
    after = table.ordered ? [last[ORDER] ?? null] : table.key.map((column) => last[column] ?? null);
  }
  return total;
}

// Writes rows into a table, a batch of them in each statement (at most BATCH_BYTES of values, about).
async function insertRows(to: Store, table: Table, rows: readonly SqlRow[]): Promise<void> {
  const columns = table.columns.map((column) => to.dialect.column(column)).join(', ');
  const row = `(${marks(table.columns.length)})`;
  let batch: SqlValue[][] = [];
  let bytes = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    await to.sql.run(`INSERT INTO ${table.name} (${columns}) VALUES ${batch.map(() => row).join(', ')}`, batch.flat());
    batch = [];
    bytes = 0;
  };
  for (const source of rows) {
    // The values in the columns' order; a column the source has no value for is null.
    const values = table.columns.map((column) => source[column] ?? null);
    // Text counted at four bytes a character (UTF-8's most), anything else at eight.
    const size = values.reduce<number>((sum, value) => sum + (typeof value === 'string' ? value.length * 4 : 8), 0);
    if (batch.length > 0 && bytes + size > BATCH_BYTES) await flush();
    batch.push(values);
    bytes += size;
  }
  await flush();
}

// PostgreSQL's identity columns go on from the highest id copied (each table's next id is past it). MySQL's
// AUTO_INCREMENT and SQLite's rowid did so by themselves when the rows were written.
async function identitiesPast(to: Store): Promise<void> {
  if (to.sql.dialect !== 'postgres') return;
  for (const table of TABLES) {
    if (!table.identity) continue;
    // setval(sequence, the highest id, true): the next is the one after it; an empty table starts again at 1.
    await to.sql.get(
      `SELECT setval(pg_get_serial_sequence('${table.name}', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) AS next
         FROM ${table.name}`,
    );
  }
}
