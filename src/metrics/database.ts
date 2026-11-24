/**
 * What a database executor reports: each statement as it ends (its kind, how long it took, whether it failed), each
 * transaction whole, and how its connections stand. The SQLite executor reports into it (src/store/sqlite.ts); so do
 * the executors of PostgreSQL and MySQL, through the same three calls, and their numbers are the same families.
 *
 * A statement's time counts from the call to its end, the wait for the connection included: what the caller waited.
 * The kind is the statement's first word (select, insert, update, delete), so a label never carries a statement's
 * text; a whole transaction, from its start to its commit or rollback, is one of kind `transaction`.
 */
import { type Gauge, type Metrics, SECONDS_BUCKETS } from './registry.ts';

/** What a statement does, by its first word. */
export type QueryKind = 'select' | 'insert' | 'update' | 'delete' | 'transaction' | 'other';

/** How the connections stand: lent out to a statement or a transaction, idle, and callers waiting for one. */
export interface ConnectionCounts {
  readonly busy: number;
  readonly idle: number;
  readonly waiting: number;
}

/** Where an executor reports. */
export interface DatabaseReport {
  /** A statement (or a whole transaction) ended, `seconds` after it was asked for; `failed` when it threw. */
  query(kind: QueryKind, seconds: number, failed: boolean): void;
  /** Reads the connections' state each time the metrics are written (an executor calls this once, when it opens). */
  connections(read: () => ConnectionCounts): void;
}

/** A report that keeps nothing: executors made without metrics (tests, the command line's own). */
export const NO_DATABASE_REPORT: DatabaseReport = {
  query: () => {},
  connections: () => {},
};

// A SQLite statement takes microseconds and a network database's a millisecond or more: the buckets start lower than
// the requests' and reach the time a stuck lock waits.
const QUERY_BUCKETS = [0.0001, 0.0005, ...SECONDS_BUCKETS.filter((bound) => bound <= 10)];

// The kinds, each with its labels made once (a report comes for every statement).
const KINDS: readonly QueryKind[] = ['select', 'insert', 'update', 'delete', 'transaction', 'other'];
const LABELS = new Map(KINDS.map((kind) => [kind, { operation: kind }] as const));

/** A statement's kind, by its first word; WITH counts as a select (jukecord's are), REPLACE as an insert. */
export function queryKind(sql: string): QueryKind {
  // The first word, past spaces and line breaks; what follows it does not matter.
  const word = /^\s*([A-Za-z]+)/.exec(sql)?.[1]?.toLowerCase();
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
    case 'commit':
    case 'rollback':
    case 'savepoint':
    case 'release':
      return 'transaction';
    default:
      return 'other';
  }
}

/** Declares the database's families and gives the report an executor calls. */
export function databaseReport(metrics: Metrics): DatabaseReport {
  const duration = metrics.histogram(
    'jukecord_database_query_duration_seconds',
    'How long database statements took, the wait for a connection included, by operation (a whole transaction is one).',
    ['operation'],
    QUERY_BUCKETS,
  );
  const errors = metrics.counter(
    'jukecord_database_query_errors_total',
    'Database statements (or whole transactions) that failed, by operation.',
    ['operation'],
  );
  const connections: Gauge = metrics.gauge(
    'jukecord_database_connections',
    "The database's connections: busy (held by a statement or a transaction) or idle.",
    ['state'],
  );
  const waiting = metrics.gauge(
    'jukecord_database_waiting_queries',
    'Statements and transactions waiting for a database connection.',
  );
  // Every operation named from the start, at zero, so a rate() of each starts with the first scrape.
  for (const labels of LABELS.values()) errors.inc(labels, 0);
  return {
    query: (kind, seconds, failed) => {
      const labels = LABELS.get(kind) ?? { operation: 'other' };
      duration.observe(seconds, labels);
      if (failed) errors.inc(labels);
    },
    connections: (read) => {
      metrics.collect(() => {
        const counts = read();
        connections.set(counts.busy, { state: 'busy' });
        connections.set(counts.idle, { state: 'idle' });
        waiting.set(counts.waiting);
      });
    },
  };
}
