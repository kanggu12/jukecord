/**
 * The reports other parts make into the metrics: the database executor's statements, transactions and connection
 * (SQLite's here; PostgreSQL's and MySQL's report the same way), the bus's commands, and the shared cache's reads.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MemoryCache } from '../../src/cache/memory.ts';
import { databaseReport, queryKind } from '../../src/metrics/database.ts';
import { MetricsRegistry } from '../../src/metrics/registry.ts';
import { busReport, sharedCacheReport } from '../../src/metrics/services.ts';
import { SqliteExecutor } from '../../src/store/sqlite.ts';
import { Store } from '../../src/store/store.ts';
import { API, OPERATIONS } from '../../src/web/api.ts';
import { parseExposition } from '../support/exposition.ts';

// The value of one series in the text format, or undefined when it is not there.
function seriesValue(text: string, series: string): number | undefined {
  const line = text.split('\n').find((entry) => entry.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
}

describe('the database report', () => {
  it("names a statement's kind by its first word, never by its text", () => {
    assert.equal(queryKind('SELECT * FROM tracks WHERE id = ?'), 'select');
    assert.equal(queryKind('\n   with recent AS (SELECT 1) SELECT * FROM recent'), 'select');
    assert.equal(queryKind('INSERT INTO likes (owner, track_id) VALUES (?, ?)'), 'insert');
    assert.equal(queryKind('REPLACE INTO x VALUES (1)'), 'insert');
    assert.equal(queryKind('UPDATE queue_items SET position = ?'), 'update');
    assert.equal(queryKind('DELETE FROM sessions WHERE expires_at <= ?'), 'delete');
    assert.equal(queryKind('SAVEPOINT sp1'), 'transaction');
    assert.equal(queryKind('PRAGMA user_version'), 'other');
    assert.equal(queryKind('VACUUM INTO ?'), 'other');
    assert.equal(queryKind(''), 'other');
  });

  it('counts each statement by kind as it ends, a transaction whole, and a failure as one', async () => {
    const registry = new MetricsRegistry();
    const store = await Store.open(SqliteExecutor.open(':memory:', { report: databaseReport(registry) }));
    try {
      // Opening ran the migrations; from here, counted on top of them.
      const before = registry.render();
      const selects = seriesValue(before, 'jukecord_database_query_duration_seconds_count{operation="select"}') ?? 0;
      const transactions =
        seriesValue(before, 'jukecord_database_query_duration_seconds_count{operation="transaction"}') ?? 0;
      await store.sql.get('SELECT 1 AS one');
      await store.sql.transaction(async () => {
        await store.sql.run("INSERT INTO users (id, name, avatar, updated_at) VALUES ('1', 'A', NULL, 0)");
        await store.sql.run("UPDATE users SET name = 'B' WHERE id = '1'");
      });
      await assert.rejects(store.sql.get('SELECT nothing FROM nowhere'));
      await assert.rejects(
        store.sql.transaction(async () => {
          await store.sql.run("DELETE FROM users WHERE id = '1'");
          throw new Error('changed my mind');
        }),
      );
      const text = registry.render();
      parseExposition(text);
      assert.equal(
        seriesValue(text, 'jukecord_database_query_duration_seconds_count{operation="select"}'),
        selects + 2,
      );
      assert.equal(seriesValue(text, 'jukecord_database_query_errors_total{operation="select"}'), 1);
      assert.equal(seriesValue(text, 'jukecord_database_query_duration_seconds_count{operation="insert"}'), 1);
      assert.equal(seriesValue(text, 'jukecord_database_query_duration_seconds_count{operation="update"}'), 1);
      assert.equal(seriesValue(text, 'jukecord_database_query_duration_seconds_count{operation="delete"}'), 1);
      // Two transactions, the one that threw a failure; the rollback undid its delete.
      assert.equal(
        seriesValue(text, 'jukecord_database_query_duration_seconds_count{operation="transaction"}'),
        transactions + 2,
      );
      assert.equal(seriesValue(text, 'jukecord_database_query_errors_total{operation="transaction"}'), 1);
      assert.equal((await store.sql.get("SELECT name FROM users WHERE id = '1'"))?.name, 'B');
    } finally {
      await store.close();
    }
  });

  it('times a statement around its work, adding no turn of the event loop to it', async () => {
    const seen: string[] = [];
    const executor = SqliteExecutor.open(':memory:', {
      report: { query: (kind) => seen.push(kind), connections: () => {} },
    });
    try {
      const answer = executor.get('SELECT 1 AS one');
      // Reported before the promise was even looked at: the statement ran, and was timed, in the call.
      assert.deepEqual(seen, ['select']);
      assert.equal((await answer)?.one, 1);
    } finally {
      await executor.close();
    }
  });

  it("tells the connection's state: busy while a transaction holds it, with those waiting in line", async () => {
    const registry = new MetricsRegistry();
    const executor = SqliteExecutor.open(':memory:', { report: databaseReport(registry) });
    try {
      assert.match(registry.render(), /^jukecord_database_connections\{state="idle"\} 1$/m);
      let finish: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const transaction = executor.transaction(async () => {
        await held;
      });
      // A statement from outside waits for the transaction's end.
      const waiting = executor.get('SELECT 1 AS one');
      await new Promise((resolve) => setImmediate(resolve));
      const busy = registry.render();
      assert.match(busy, /^jukecord_database_connections\{state="busy"\} 1$/m);
      assert.match(busy, /^jukecord_database_connections\{state="idle"\} 0$/m);
      assert.match(busy, /^jukecord_database_waiting_queries 1$/m);
      finish();
      await transaction;
      await waiting;
      assert.match(registry.render(), /^jukecord_database_waiting_queries 0$/m);
    } finally {
      await executor.close();
    }
    // Closed: no connection at all.
    assert.match(registry.render(), /^jukecord_database_connections\{state="idle"\} 0$/m);
  });
});

describe('the bus report', () => {
  it('counts commands by name and outcome, with any name off the list as "other"', () => {
    const registry = new MetricsRegistry();
    const report = busReport(registry, OPERATIONS);
    report.command('skip', 0.004, 'ok');
    report.command('skip', 0.002, 'error');
    report.command('queue', 5, 'timeout');
    report.command('queue', 0, 'unavailable');
    report.command('/guilds/100000000000000001/skip', 0.001, 'ok');
    const text = registry.render();
    parseExposition(text);
    assert.ok('skip' in API && 'queue' in API);
    assert.equal(seriesValue(text, 'jukecord_bus_commands_total{command="skip",outcome="ok"}'), 1);
    assert.equal(seriesValue(text, 'jukecord_bus_commands_total{command="skip",outcome="error"}'), 1);
    assert.equal(seriesValue(text, 'jukecord_bus_commands_total{command="queue",outcome="timeout"}'), 1);
    assert.equal(seriesValue(text, 'jukecord_bus_commands_total{command="other",outcome="ok"}'), 1);
    assert.equal(seriesValue(text, 'jukecord_bus_command_duration_seconds_count{command="skip"}'), 2);
    assert.doesNotMatch(text, /100000000000000001/);
  });
});

describe('the shared cache report', () => {
  it("counts the memory adapter's reads as hits and misses, and its size", async () => {
    const registry = new MetricsRegistry();
    const cache = new MemoryCache({ report: sharedCacheReport(registry) });
    try {
      await cache.set('a', '1', 60_000);
      await cache.get('a');
      await cache.get('b');
      await cache.take('a');
      await cache.take('a');
      const text = registry.render();
      parseExposition(text);
      assert.equal(seriesValue(text, 'jukecord_shared_cache_lookups_total{result="hit"}'), 2);
      assert.equal(seriesValue(text, 'jukecord_shared_cache_lookups_total{result="miss"}'), 2);
      assert.equal(seriesValue(text, 'jukecord_shared_cache_entries'), 0);
      assert.equal(seriesValue(text, 'jukecord_shared_cache_errors_total'), 0);
    } finally {
      await cache.close();
    }
  });
});
