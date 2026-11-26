/**
 * The cache in this process's memory: the default, and all one process needs.
 *
 * Bounded twice, so nothing that asks often can grow it without limit: every entry expires by itself, and beyond
 * `capacity` entries the least recently used goes first (a scan from many addresses costs a few evictions, not memory).
 * Expired entries leave when they are next looked at, and a sweep once a minute takes the ones nobody looks at again.
 *
 * Counters (increment) are kept apart from the entries, with a bound of their own: what anyone can make many of (a
 * login's state at the provider, a search's memory) never pushes out the failed logins that hold a name back. Beyond
 * `counters`, the smallest counts go first, the oldest of them first: a count that blocks (twenty failures) is pushed
 * out only by as many counts as large, each of which took as many failures.
 */
import { steadyNow } from '../core/clock.ts';
import type { SharedCacheReport } from '../metrics/services.ts';
import type { Cache, TokenRate } from './cache.ts';

/** A stored value and the moment it stops counting (on the steady clock). */
interface Entry {
  value: string;
  expiresAt: number;
}

/** A counter: its count, the end of its window, and the tier it is kept in (see tierOf). */
interface Counter {
  count: number;
  expiresAt: number;
  tier: number;
}

// How many tiers the counters are kept in by the size of their count.
const TIERS = 8;

// A count's tier: 0 for 1 or less, then one for each doubling (2-3, 4-7, 8-15, 16-31 ...), the last for every larger
// count. The lowest tier that has counters gives up its oldest first.
function tierOf(count: number): number {
  return count < 2 ? 0 : Math.min(TIERS - 1, Math.floor(Math.log2(count)));
}

/** A token bucket: what it held at `at`, and when that was. */
interface Bucket {
  tokens: number;
  at: number;
}

export interface MemoryCacheOptions {
  /** The most entries kept, counters and buckets apart (10,000 by default). */
  readonly capacity?: number;
  /** The most counters kept (10,000 by default). */
  readonly counters?: number;
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
  private readonly counterCapacity: number;
  private readonly bucketCapacity: number;
  private readonly now: () => number;
  // Insertion order is the order of last use, oldest first: refreshed by moving an entry to the end.
  private readonly entries = new Map<string, Entry>();
  // The counters by key, and their keys by tier, each tier in the order of their last change (the oldest first).
  private readonly counters = new Map<string, Counter>();
  private readonly tiers: Set<string>[] = Array.from({ length: TIERS }, () => new Set<string>());
  private readonly tokenBuckets = new Map<string, Bucket>();
  // The minute's sweep; unref'd, so an idle cache never keeps the process alive.
  private readonly sweeper: NodeJS.Timeout;
  private closed = false;
  private readonly report: SharedCacheReport | null;

  constructor(options: MemoryCacheOptions = {}) {
    this.capacity = options.capacity ?? 10_000;
    this.counterCapacity = options.counters ?? 10_000;
    this.bucketCapacity = options.buckets ?? 10_000;
    this.now = options.now ?? steadyNow;
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
    this.report = options.report ?? null;
    // Its size, read when the metrics are written.
    this.report?.entries(() => this.size);
  }

  async get(key: string): Promise<string | null> {
    this.open();
    // A counter reads as its count, as a server's does.
    const counter = this.liveCounter(key);
    if (counter !== null) {
      this.report?.lookup(true);
      return String(counter.count);
    }
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
    // A value replaces a counter under its key, as on a server.
    this.dropCounter(key);
    this.keep(key, { value, expiresAt: this.now() + ttlMs });
  }

  async add(key: string, value: string, ttlMs: number): Promise<boolean> {
    this.open();
    // A key whose entry expired holds nothing, so it may be taken again; one that holds a counter is taken.
    if (this.live(key) !== null || this.liveCounter(key) !== null) return false;
    this.keep(key, { value, expiresAt: this.now() + ttlMs });
    return true;
  }

  async take(key: string): Promise<string | null> {
    this.open();
    const counter = this.liveCounter(key);
    this.dropCounter(key);
    const entry = this.live(key);
    this.report?.lookup(entry !== null || counter !== null);
    this.entries.delete(key);
    return counter !== null ? String(counter.count) : (entry?.value ?? null);
  }

  async delete(key: string): Promise<void> {
    this.open();
    this.entries.delete(key);
    this.dropCounter(key);
  }

  async increment(key: string, ttlMs: number, by = 1): Promise<number> {
    this.open();
    const counter = this.liveCounter(key);
    // A value kept under the key (none of jukecord's) starts the count from its number and keeps its end.
    const entry = counter === null ? this.live(key) : null;
    // Taking back never makes a counter: one that is gone (its window closed) has nothing to take back.
    if (counter === null && entry === null && by < 0) return 0;
    // A new counter starts its window now; an existing one keeps the end it was given when it was made.
    const count = (counter?.count ?? (entry === null ? 0 : Number(entry.value))) + by;
    const expiresAt = counter?.expiresAt ?? entry?.expiresAt ?? this.now() + ttlMs;
    if (entry !== null) this.entries.delete(key);
    this.dropCounter(key);
    const tier = tierOf(count);
    this.counters.set(key, { count, expiresAt, tier });
    this.tiers[tier]?.add(key);
    // Beyond the bound: the oldest counter of the lowest tier that has any.
    while (this.counters.size > this.counterCapacity) {
      const oldest = this.tiers
        .find((keys) => keys.size > 0)
        ?.values()
        .next().value;
      if (oldest === undefined) break;
      this.dropCounter(oldest);
    }
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
    this.counters.clear();
    for (const keys of this.tiers) keys.clear();
    this.tokenBuckets.clear();
  }

  /** How many entries and counters are kept now, expired ones not yet swept included (for tests and the metrics). */
  get size(): number {
    return this.entries.size + this.counters.size;
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

  // The counter under the key while its window is open; an expired one is dropped on the way.
  private liveCounter(key: string): Counter | null {
    const counter = this.counters.get(key);
    if (counter === undefined) return null;
    if (counter.expiresAt <= this.now()) {
      this.dropCounter(key);
      return null;
    }
    return counter;
  }

  // Forgets a counter, from its tier too.
  private dropCounter(key: string): void {
    const counter = this.counters.get(key);
    if (counter === undefined) return;
    this.tiers[counter.tier]?.delete(key);
    this.counters.delete(key);
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

  // Drops every expired entry and counter: the ones nobody asks for again would otherwise wait for an eviction.
  private sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
    for (const [key, counter] of this.counters) if (counter.expiresAt <= now) this.dropCounter(key);
  }
}
