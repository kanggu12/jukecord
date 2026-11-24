/**
 * The cache in this process's memory: the default, and all one process needs.
 *
 * Bounded twice, so nothing that asks often can grow it without limit: every entry expires by itself, and beyond
 * `capacity` entries the least recently used goes first (a scan from many addresses costs a few evictions, not memory).
 * Expired entries leave when they are next looked at, and a sweep once a minute takes the ones nobody looks at again.
 */
import { steadyNow } from '../core/clock.ts';
import type { SharedCacheReport } from '../metrics/services.ts';
import type { Cache, TokenRate } from './cache.ts';

/** A stored value and the moment it stops counting (on the steady clock). */
interface Entry {
  value: string;
  expiresAt: number;
}

/** A token bucket: what it held at `at`, and when that was. */
interface Bucket {
  tokens: number;
  at: number;
}

export interface MemoryCacheOptions {
  /** The most entries kept, buckets apart (10,000 by default). */
  readonly capacity?: number;
  /** The most token buckets kept (10,000 by default, as the rate limiter kept before). */
  readonly buckets?: number;
  /** The clock, for tests; the steady one by default, so a system clock set back expires nothing early. */
  readonly now?: () => number;
  /** Where its reads and its size are reported (the metrics); nowhere by default. */
  readonly report?: SharedCacheReport;
}

export class MemoryCache implements Cache {
  readonly kind = 'memory';
  private readonly capacity: number;
  private readonly bucketCapacity: number;
  private readonly now: () => number;
  // Insertion order is the order of last use, oldest first: refreshed by moving an entry to the end.
  private readonly entries = new Map<string, Entry>();
  private readonly tokenBuckets = new Map<string, Bucket>();
  // The minute's sweep; unref'd, so an idle cache never keeps the process alive.
  private readonly sweeper: NodeJS.Timeout;
  private closed = false;
  private readonly report: SharedCacheReport | null;

  constructor(options: MemoryCacheOptions = {}) {
    this.capacity = options.capacity ?? 10_000;
    this.bucketCapacity = options.buckets ?? 10_000;
    this.now = options.now ?? steadyNow;
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
    this.report = options.report ?? null;
    // Its size, read when the metrics are written.
    this.report?.entries(() => this.entries.size);
  }

  async get(key: string): Promise<string | null> {
    this.open();
    const entry = this.live(key);
    this.report?.lookup(entry !== null);
    if (entry === null) return null;
    // Used now: moved to the end, the last to be evicted.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.open();
    this.keep(key, { value, expiresAt: this.now() + ttlMs });
  }

  async add(key: string, value: string, ttlMs: number): Promise<boolean> {
    this.open();
    // A key whose entry expired holds nothing, so it may be taken again.
    if (this.live(key) !== null) return false;
    this.keep(key, { value, expiresAt: this.now() + ttlMs });
    return true;
  }

  async take(key: string): Promise<string | null> {
    this.open();
    const entry = this.live(key);
    this.report?.lookup(entry !== null);
    this.entries.delete(key);
    return entry?.value ?? null;
  }

  async delete(key: string): Promise<void> {
    this.open();
    this.entries.delete(key);
  }

  async increment(key: string, ttlMs: number, by = 1): Promise<number> {
    this.open();
    const entry = this.live(key);
    // A new counter starts its window now; an existing one keeps the end it was given when it was made.
    const count = (entry === null ? 0 : Number(entry.value)) + by;
    this.keep(key, { value: String(count), expiresAt: entry?.expiresAt ?? this.now() + ttlMs });
    return count;
  }

  async spend(keys: readonly string[], rate: TokenRate): Promise<number> {
    this.open();
    // First whether every bucket has a token: none is taken unless all can give one.
    let longest = 0;
    for (const key of keys) {
      const tokens = this.level(key, rate);
      // The time the missing part of one token takes to come back at the steady rate.
      if (tokens < 1) longest = Math.max(longest, Math.ceil(((1 - tokens) * 1000) / rate.perSecond));
    }
    if (longest > 0) return longest;
    const now = this.now();
    for (const key of keys) {
      const tokens = this.level(key, rate);
      // Moved to the end: the most recently used, the last to be dropped.
      this.tokenBuckets.delete(key);
      this.tokenBuckets.set(key, { tokens: Math.max(0, tokens - 1), at: now });
    }
    // Beyond the limit the buckets used longest ago go (they are full again by now, or nearly).
    while (this.tokenBuckets.size > this.bucketCapacity) {
      const oldest = this.tokenBuckets.keys().next().value;
      if (oldest === undefined) break;
      this.tokenBuckets.delete(oldest);
    }
    return 0;
  }

  async refund(keys: readonly string[], rate: TokenRate): Promise<void> {
    this.open();
    const now = this.now();
    for (const key of keys) {
      // A bucket that was dropped meanwhile is full already: nothing to give back.
      if (!this.tokenBuckets.has(key)) continue;
      this.tokenBuckets.set(key, { tokens: Math.min(rate.burst, this.level(key, rate) + 1), at: now });
    }
  }

  async ping(): Promise<boolean> {
    return !this.closed;
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.sweeper);
    this.entries.clear();
    this.tokenBuckets.clear();
  }

  /** How many entries are kept now, expired ones not yet swept included (for tests and the metrics). */
  get size(): number {
    return this.entries.size;
  }

  // Calls after close() fail, as a server's would.
  private open(): void {
    if (this.closed) throw new Error('the cache is closed');
  }

  // The entry under the key while it counts; an expired one is dropped on the way.
  private live(key: string): Entry | null {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }

  // Stores an entry as the most recently used, then drops the least recently used beyond the capacity.
  private keep(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  // What a bucket holds now: what it held, plus what came back since, up to the burst. A new one is full.
  private level(key: string, rate: TokenRate): number {
    const bucket = this.tokenBuckets.get(key);
    if (bucket === undefined) return rate.burst;
    const back = ((this.now() - bucket.at) / 1000) * rate.perSecond;
    return Math.min(rate.burst, bucket.tokens + back);
  }

  // Drops every expired entry: the ones nobody asks for again would otherwise wait for an eviction.
  private sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
  }
}
