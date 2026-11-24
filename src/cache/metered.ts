/**
 * The cache with its numbers counted: every call by operation and outcome (a hit or a miss for a lookup, a token
 * taken or refused for a rate, an error), and how long it took. The same for both adapters, so a dashboard compares a
 * memory cache with a Redis one; the names say "shared cache" to tell it from the media cache on disk.
 */
import { type Counter, type Histogram, type Metrics, NO_METRICS } from '../metrics/registry.ts';
import type { Cache, CacheKind, TokenRate } from './cache.ts';

export class MeteredCache implements Cache {
  private readonly inner: Cache;
  private readonly operations: Counter;
  private readonly seconds: Histogram;

  constructor(inner: Cache, metrics: Metrics = NO_METRICS) {
    this.inner = inner;
    this.operations = metrics.counter(
      'jukecord_shared_cache_operations_total',
      'Calls to the shared cache (memory, or Redis/Valkey), by operation and outcome.',
      ['operation', 'result'],
    );
    this.seconds = metrics.histogram(
      'jukecord_shared_cache_operation_duration_seconds',
      'How long calls to the shared cache took, by operation.',
      ['operation'],
    );
  }

  get kind(): CacheKind {
    return this.inner.kind;
  }

  get(key: string): Promise<string | null> {
    return this.measure('get', this.inner.get(key), (value) => (value === null ? 'miss' : 'hit'));
  }

  set(key: string, value: string, ttlMs: number): Promise<void> {
    return this.measure('set', this.inner.set(key, value, ttlMs), () => 'ok');
  }

  add(key: string, value: string, ttlMs: number): Promise<boolean> {
    return this.measure('add', this.inner.add(key, value, ttlMs), (kept) => (kept ? 'kept' : 'held'));
  }

  take(key: string): Promise<string | null> {
    return this.measure('take', this.inner.take(key), (value) => (value === null ? 'miss' : 'hit'));
  }

  delete(key: string): Promise<void> {
    return this.measure('delete', this.inner.delete(key), () => 'ok');
  }

  increment(key: string, ttlMs: number, by?: number): Promise<number> {
    return this.measure('increment', this.inner.increment(key, ttlMs, by), () => 'ok');
  }

  spend(keys: readonly string[], rate: TokenRate): Promise<number> {
    return this.measure('spend', this.inner.spend(keys, rate), (wait) => (wait === 0 ? 'taken' : 'refused'));
  }

  refund(keys: readonly string[], rate: TokenRate): Promise<void> {
    return this.measure('refund', this.inner.refund(keys, rate), () => 'ok');
  }

  ping(): Promise<boolean> {
    return this.inner.ping();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  // Counts one call when it settles: its outcome, or an error; and its time either way.
  private async measure<T>(operation: string, call: Promise<T>, outcome: (value: T) => string): Promise<T> {
    const done = this.seconds.time({ operation });
    try {
      const value = await call;
      this.operations.inc({ operation, result: outcome(value) });
      return value;
    } catch (error) {
      this.operations.inc({ operation, result: 'error' });
      throw error;
    } finally {
      done();
    }
  }
}
