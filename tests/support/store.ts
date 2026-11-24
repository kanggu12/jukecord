/**
 * Throwaway databases filled with made-up tracks, for tests.
 */
import type { Track } from '../../src/core/types.ts';
import type { RunResult, SqlExecutor, SqlRow, SqlValue } from '../../src/store/sql.ts';
import { SqliteExecutor } from '../../src/store/sqlite.ts';
import { Store } from '../../src/store/store.ts';

/** An in-memory database at the latest schema; `now` fixes the timestamps it writes. */
export function memoryStore(now: () => number = () => Date.UTC(2026, 10, 11)): Promise<Store> {
  return Store.open(':memory:', { now });
}

/**
 * An in-memory database whose every statement waits a turn of the event loop first, as a network database's answer
 * does: what interleaves at an await does interleave here, so a test sees what the server's lanes keep apart.
 */
export function slowMemoryStore(now: () => number = () => Date.UTC(2026, 10, 11)): Promise<Store> {
  return Store.open(slowly(SqliteExecutor.open(':memory:')), { now });
}

// An executor that answers like the one it wraps, a turn of the event loop later.
function slowly(sql: SqlExecutor): SqlExecutor {
  const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    dialect: sql.dialect,
    get isOpen() {
      return sql.isOpen;
    },
    all: async (text: string, params?: readonly SqlValue[]): Promise<SqlRow[]> => {
      await turn();
      return sql.all(text, params);
    },
    get: async (text: string, params?: readonly SqlValue[]): Promise<SqlRow | undefined> => {
      await turn();
      return sql.get(text, params);
    },
    run: async (text: string, params?: readonly SqlValue[]): Promise<RunResult> => {
      await turn();
      return sql.run(text, params);
    },
    exec: async (text: string): Promise<void> => {
      await turn();
      return sql.exec(text);
    },
    transaction: (fn) => sql.transaction(fn),
    close: () => sql.close(),
  };
}

/** `fn` for each item, one after the other (each waits for the one before), with the answers in order. */
export async function inOrder<T, U>(items: readonly T[], fn: (item: T, index: number) => Promise<U> | U): Promise<U[]> {
  const answers: U[] = [];
  for (const [index, item] of items.entries()) answers.push(await fn(item, index));
  return answers;
}

/** Stores `count` tracks named "Track 1".. with example.com addresses and a 3-minute length. */
export async function addTracks(store: Store, count: number, prefix = 'v'): Promise<Track[]> {
  const tracks: Track[] = [];
  // One after the other, so the IDs follow the names.
  for (let index = 0; index < count; index += 1) {
    tracks.push(
      await store.tracks.upsert({
        // example.com: test data must not point at real pages.
        source: `https://example.com/watch?v=${prefix}${index + 1}`,
        url: `https://example.com/watch?v=${prefix}${index + 1}`,
        title: `Track ${index + 1}`,
        uploader: 'Example',
        durationMs: 180_000,
        thumbnail: null,
      }),
    );
  }
  return tracks;
}
