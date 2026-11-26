/**
 * The words of SQL that differ between SQLite, PostgreSQL and MySQL/MariaDB, for the statements the repositories
 * share (src/store/store.ts writes everything else once, in SQL all three read alike).
 *
 * What differs, and how each is written here:
 * - placeholders: always `?` in the text; the PostgreSQL executor numbers them ($1, $2 ...) itself.
 * - an upsert: ON CONFLICT (key) DO UPDATE SET col = excluded.col on SQLite and PostgreSQL; on MySQL
 *   INSERT ... AS new ON DUPLICATE KEY UPDATE col = new.col, and on MariaDB, which has no row alias, VALUES(col).
 * - RETURNING: SQLite and PostgreSQL say the row's id in the statement; MySQL says the id an INSERT made
 *   (LAST_INSERT_ID, which an upsert that updated sets to the existing row's id), and a row is read back after.
 * - INSERT OR IGNORE: SQLite's words; ON CONFLICT DO NOTHING on PostgreSQL; on MySQL a plain INSERT whose duplicate
 *   the repository takes as nothing done (INSERT IGNORE would also pass over a missing track, which SQLite refuses).
 * - a null-safe comparison: IS on SQLite, IS NOT DISTINCT FROM on PostgreSQL, <=> on MySQL.
 * - whole-number division: / on SQLite and PostgreSQL (between whole numbers), DIV on MySQL, where / gives a decimal;
 *   a bound number used in it is cast to a whole number (node:sqlite binds every JavaScript number as a real).
 * - nulls in an ascending order: first on SQLite and MySQL by themselves, NULLS FIRST said on PostgreSQL.
 * - a track by its source: the source's SHA-256 is the unique key on the servers (a stored generated column), since
 *   an address can be longer than a MySQL index or a PostgreSQL btree entry takes; it is looked up by that hash and
 *   the text together.
 * - the order rows of a table without an id were first kept in: SQLite's rowid, a `seq` column on the servers.
 * - a reserved word as a column name (`repeat`): quoted with double quotes, which MySQL reads as a name too because
 *   the executor sets ANSI_QUOTES (and PIPES_AS_CONCAT, so || joins text there as well).
 * - an UPDATE of one server's rows by an index: MySQL and MariaDB are told the index (FORCE INDEX), since reading the
 *   whole table instead waits on other servers' rows; the others never need telling.
 *
 * Time arithmetic stays out of SQL: the repositories cut timestamps into whole days and hours with the division
 * above and say the dates in TypeScript, so every database counts days the same way.
 */
import type { Dialect } from './sql.ts';

/** Builds, from an incoming value's column, the SQL that reads it (in an upsert's SET). */
export type Column = (column: string) => string;

/** One column an upsert changes on the row it meets: to the incoming value, or to an expression of both rows. */
export type Assignment = string | readonly [string, (incoming: Column, current: Column) => string];

/** An INSERT that updates the row it meets on a unique key. */
export interface Upsert {
  readonly table: string;
  /** The columns inserted, in the order of the bound values. */
  readonly columns: readonly string[];
  /** The unique key the row may meet (SQLite and PostgreSQL name it; MySQL finds it itself). */
  readonly key: readonly string[];
  /** What changes on the row met. */
  readonly update: readonly Assignment[];
  /** Whether the statement says the row's id, inserted or updated (read with SqlDialect.insertedId). */
  readonly id?: boolean;
}

/** The SQL of one dialect (see the module comment). */
export interface SqlDialect {
  readonly name: Dialect;
  /** Whether a statement can end with RETURNING (SQLite, PostgreSQL); MySQL reads the id the INSERT made. */
  readonly returning: boolean;
  /** Whether INSERT ... ignoring a duplicate says so without an error (all but MySQL). */
  readonly ignoresDuplicates: boolean;
  /** A bound value read as a whole number, for arithmetic with whole numbers. */
  readonly wholeNumber: string;
  /** The column a table without an id keeps the order its rows were first kept in. */
  readonly insertionOrder: string;
  /** The unique key of a track's source in an upsert (the text on SQLite, its hash on the servers). */
  readonly sourceKey: string;
  /** A column name as SQL reads it (quoted when it is a reserved word somewhere). */
  column(name: string): string;
  /** Whole-number division, rounding toward zero (the timestamps are whole milliseconds). */
  quotient(dividend: string, divisor: number): string;
  /** `column` equals the value bound here, a null equalling a null. */
  same(column: string): string;
  /** `column` differs from the value bound here, a null differing from any value. */
  differs(column: string): string;
  /** An ORDER BY term, ascending, with the nulls first (as SQLite and MySQL order them by themselves). */
  nullsFirst(term: string): string;
  /** The condition that finds a track by its source, and the source as many times as the condition binds it. */
  bySource(alias: string, source: string): { readonly where: string; readonly params: readonly string[] };
  /** An upsert statement (see Upsert). */
  upsert(spec: Upsert): string;
  /** An INSERT that does nothing when the row's key is taken (see ignoresDuplicates for MySQL). */
  insertOrIgnore(table: string, columns: readonly string[]): string;
  /**
   * A table an UPDATE reads through one of its indexes, said where the database would not always take it: MySQL and
   * MariaDB may read a small table whole instead (MariaDB 11 often does), and an UPDATE that reads every row waits
   * for the rows other transactions hold, other servers' rows among them, which deadlocks two servers' changes at
   * READ COMMITTED. SQLite and PostgreSQL wait only for the rows a statement changes.
   */
  throughIndex(table: string, index: string): string;
}

// Column names that are reserved words in one of the databases (MySQL and MariaDB reserve REPEAT).
const RESERVED = new Set(['repeat']);

// A column's name, quoted when it is reserved: double quotes are a name's quotes in SQLite, PostgreSQL and (with
// ANSI_QUOTES) MySQL.
function column(name: string): string {
  return RESERVED.has(name) ? `"${name}"` : name;
}

// The `?, ?, ?` of a row of values.
function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

// The SET list of an upsert, with the incoming and current values written the dialect's way.
function assignments(update: readonly Assignment[], incoming: Column, current: Column): string {
  return update
    .map((entry) =>
      typeof entry === 'string'
        ? `${column(entry)} = ${incoming(entry)}`
        : `${column(entry[0])} = ${entry[1](incoming, current)}`,
    )
    .join(', ');
}

// SQLite's and PostgreSQL's upsert, which are the same words: ON CONFLICT ... DO UPDATE with the incoming row as
// "excluded" and the current one by the table's name.
function onConflict(spec: Upsert): string {
  const set = assignments(
    spec.update,
    (name) => `excluded.${column(name)}`,
    (name) => `${spec.table}.${column(name)}`,
  );
  return (
    `INSERT INTO ${spec.table} (${spec.columns.map(column).join(', ')}) VALUES (${placeholders(spec.columns.length)}) ` +
    `ON CONFLICT (${spec.key.map(column).join(', ')}) DO UPDATE SET ${set}${spec.id ? ' RETURNING id' : ''}`
  );
}

/** SQLite's SQL: what jukecord wrote before there were other databases. */
export const SQLITE: SqlDialect = {
  name: 'sqlite',
  returning: true,
  ignoresDuplicates: true,
  wholeNumber: 'CAST(? AS INTEGER)',
  insertionOrder: 'rowid',
  sourceKey: 'source',
  column,
  quotient: (dividend, divisor) => `(${dividend}) / ${divisor}`,
  same: (column) => `${column} IS ?`,
  differs: (column) => `${column} IS NOT ?`,
  nullsFirst: (term) => term,
  bySource: (alias, source) => ({ where: `${alias}.source = ?`, params: [source] }),
  upsert: onConflict,
  insertOrIgnore: (table, columns) =>
    `INSERT OR IGNORE INTO ${table} (${columns.map(column).join(', ')}) VALUES (${placeholders(columns.length)})`,
  throughIndex: (table) => table,
};

/**
 * The SHA-256 of a text's UTF-8 bytes in PostgreSQL, from functions that are all IMMUTABLE (a generated column and an
 * index take no others; convert_to is only STABLE): decode(..., 'escape') turns the text into its bytes in the
 * database's encoding, which is UTF8 (the executor checks), once each backslash is doubled, since that format reads a
 * backslash as an escape.
 */
export function postgresSha256(text: string): string {
  return `sha256(decode(replace(${text}, chr(92), chr(92) || chr(92)), 'escape'))`;
}

/** PostgreSQL's SQL. */
export const POSTGRES: SqlDialect = {
  name: 'postgres',
  returning: true,
  ignoresDuplicates: true,
  wholeNumber: 'CAST(? AS BIGINT)',
  insertionOrder: 'seq',
  sourceKey: 'source_hash',
  column,
  quotient: (dividend, divisor) => `(${dividend}) / ${divisor}`,
  same: (column) => `${column} IS NOT DISTINCT FROM ?`,
  differs: (column) => `${column} IS DISTINCT FROM ?`,
  nullsFirst: (term) => `${term} NULLS FIRST`,
  bySource: (alias, source) => ({
    where: `${alias}.source_hash = ${postgresSha256('?')} AND ${alias}.source = ?`,
    params: [source, source],
  }),
  upsert: onConflict,
  insertOrIgnore: (table, columns) =>
    `INSERT INTO ${table} (${columns.map(column).join(', ')}) VALUES (${placeholders(columns.length)}) ON CONFLICT DO NOTHING`,
  throughIndex: (table) => table,
};

/**
 * MySQL's or MariaDB's SQL. They differ in the upsert only: MySQL 8.0.19 and later name the incoming row with an alias
 * (its VALUES() is deprecated since 8.0.20), MariaDB has no alias and keeps VALUES().
 */
export function mysqlDialect(mariadb: boolean): SqlDialect {
  return {
    name: 'mysql',
    returning: false,
    ignoresDuplicates: false,
    wholeNumber: 'CAST(? AS SIGNED)',
    insertionOrder: 'seq',
    sourceKey: 'source_hash',
    column,
    quotient: (dividend, divisor) => `(${dividend}) DIV ${divisor}`,
    same: (column) => `${column} <=> ?`,
    differs: (column) => `NOT (${column} <=> ?)`,
    nullsFirst: (term) => term,
    bySource: (alias, source) => ({
      where: `${alias}.source_hash = UNHEX(SHA2(?, 256)) AND ${alias}.source = ?`,
      params: [source, source],
    }),
    upsert: (spec) => {
      // The current row's value is the column by its table's name: a bare name would be ambiguous beside the row
      // alias's own column of that name.
      const set = assignments(
        spec.update,
        (name) => (mariadb ? `VALUES(${column(name)})` : `new.${column(name)}`),
        (name) => `${spec.table}.${column(name)}`,
      );
      // LAST_INSERT_ID(id) first: the statement then says the row's id whether it inserted or updated it.
      const id = spec.id ? 'id = LAST_INSERT_ID(id), ' : '';
      const values = `VALUES (${placeholders(spec.columns.length)})${mariadb ? '' : ' AS new'}`;
      return `INSERT INTO ${spec.table} (${spec.columns.map(column).join(', ')}) ${values} ON DUPLICATE KEY UPDATE ${id}${set}`;
    },
    insertOrIgnore: (table, columns) =>
      `INSERT INTO ${table} (${columns.map(column).join(', ')}) VALUES (${placeholders(columns.length)})`,
    // An index hint, which UPDATE takes in both (a single-table DELETE takes none).
    throughIndex: (table, index) => `${table} FORCE INDEX (${index})`,
  };
}

/** The dialect of a database: SQLite, PostgreSQL, or MySQL / MariaDB (which of the two the server said). */
export function dialectOf(dialect: Dialect, product: string): SqlDialect {
  if (dialect === 'sqlite') return SQLITE;
  if (dialect === 'postgres') return POSTGRES;
  return mysqlDialect(product === 'MariaDB');
}
