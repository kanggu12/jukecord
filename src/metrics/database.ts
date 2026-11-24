/**
 * The database's families, made from what its executor reports (ExecutorReport, in src/store/sql.ts): each statement
 * as it ends (its kind, how long it took, whether it failed), each transaction whole, and how its connections stand.
 * The executors of SQLite, PostgreSQL and MySQL report through the same three calls, so their numbers are the same
 * families.
 *
 * A statement's time counts from the call to its end, the wait for the connection included: what the caller waited.
 * The kind is the statement's first word (select, insert, update, delete), so a label never carries a statement's
 * text; a whole transaction, from its start to its commit or rollback, is one of kind `transaction`.
 */
// The report's shape belongs to the store, which calls it; this file only turns the calls into families.
import type { ExecutorReport, StatementKind } from '../store/sql.ts';
import { type Gauge, type Metrics, SECONDS_BUCKETS } from './registry.ts';

// A SQLite statement takes microseconds and a network database's a millisecond or more: the buckets start lower than
// the requests' and reach the time a stuck lock waits.
const QUERY_BUCKETS = [0.0001, 0.0005, ...SECONDS_BUCKETS.filter((bound) => bound <= 10)];

// The kinds, each with its labels made once (a report comes for every statement).
const KINDS: readonly StatementKind[] = ['select', 'insert', 'update', 'delete', 'transaction', 'other'];
const LABELS = new Map(KINDS.map((kind) => [kind, { operation: kind }] as const));

/** Declares the database's families and gives the report an executor calls. */
export function databaseReport(metrics: Metrics): ExecutorReport {
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
