/**
 * What the parts shared between services report: the bus's commands (an edge asking the core to do something, and
 * the answer coming back) and the shared cache's reads (memory in one process, Redis or Valkey for several). Their
 * adapters (in-process, Redis) call these, so whichever is in use, its numbers are the same families.
 */
import type { Metrics } from './registry.ts';

/**
 * How a command ended: answered, answered with an error (the action's own refusal, or the core's failure), not
 * answered in time, not sent at all (no core, the bus down) or refused when the core was lost, or given up by its
 * caller (the browser went away; the core stops the work if it can).
 */
export type CommandOutcome = 'ok' | 'error' | 'timeout' | 'unavailable' | 'cancelled';

/** Where a bus adapter reports its commands. */
export interface BusReport {
  /**
   * A command ended, `seconds` after it was sent: its name (an operation's, from a list that does not grow; any other
   * counts as "other"), and how it ended.
   */
  command(name: string, seconds: number, outcome: CommandOutcome): void;
}

/** A report that keeps nothing. */
export const NO_BUS_REPORT: BusReport = { command: () => {} };

// Commands wait at most a few seconds for the core before they count as not answered.
const COMMAND_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** Declares the bus's families; `names` is every command there is (the API's operations), the only names a label takes. */
export function busReport(metrics: Metrics, names: readonly string[]): BusReport {
  const known = new Set(names);
  const commands = metrics.counter(
    'jukecord_bus_commands_total',
    'Commands sent over the bus to the core, by command and how they ended: ok, error (the action refused), timeout, unavailable, cancelled.',
    ['command', 'outcome'],
  );
  const duration = metrics.histogram(
    'jukecord_bus_command_duration_seconds',
    'How long a command sent over the bus took to be answered, by command.',
    ['command'],
    COMMAND_BUCKETS,
  );
  return {
    command: (name, seconds, outcome) => {
      // A name not on the list is a mistake somewhere; it must not make a series of its own.
      const command = known.has(name) ? name : 'other';
      commands.inc({ command, outcome });
      duration.observe(seconds, { command });
    },
  };
}

/** Where a shared cache adapter reports. */
export interface SharedCacheReport {
  /** A read (get, take) found a value, or nothing. */
  lookup(found: boolean): void;
  /** A call to the cache's server failed: it could not be reached, or answered with an error. */
  failed(): void;
  /** Reads how many entries the cache holds, each time the metrics are written (the memory adapter knows). */
  entries(read: () => number): void;
}

/** A report that keeps nothing. */
export const NO_SHARED_CACHE_REPORT: SharedCacheReport = { lookup: () => {}, failed: () => {}, entries: () => {} };

// The two results, made once (every read is counted).
const HIT = { result: 'hit' } as const;
const MISS = { result: 'miss' } as const;

/** Declares the shared cache's families. */
export function sharedCacheReport(metrics: Metrics): SharedCacheReport {
  const lookups = metrics.counter(
    'jukecord_shared_cache_lookups_total',
    'Reads of the shared cache (rate limits, logins, short answers): a value found (hit), or nothing (miss).',
    ['result'],
  );
  const errors = metrics.counter(
    'jukecord_shared_cache_errors_total',
    "Calls to the shared cache's server that failed.",
  );
  const entries = metrics.gauge(
    'jukecord_shared_cache_entries',
    'Entries the shared cache holds (the memory adapter).',
  );
  // Both results named from the start, at zero.
  lookups.inc(HIT, 0);
  lookups.inc(MISS, 0);
  return {
    lookup: (found) => lookups.inc(found ? HIT : MISS),
    failed: () => errors.inc(),
    entries: (read) => metrics.collect(() => entries.set(read())),
  };
}
