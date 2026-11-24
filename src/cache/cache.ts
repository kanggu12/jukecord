/**
 * The cache port: short-lived shared state, kept apart from the database.
 *
 * What jukecord keeps here can be lost without harm (a restart or an eviction only costs a lookup again, or a login
 * link that must be made again), but must be the same for every process that serves a browser once there are several:
 * the rate limits of an address, the login failures of a name, a one-time login link made by one edge and used on
 * another, the short memory of a search. One process uses the memory adapter (src/cache/memory.ts) and nothing else
 * runs; several share a Redis or Valkey server through the Redis adapter.
 *
 * Values are strings: a caller that keeps an object writes JSON. Keys are the caller's own words; the adapter puts its
 * prefix in front, so several jukecords may share one server.
 */

/** A steady rate (tokens a second) and the most that may be spent at once: a token bucket's shape. */
export interface TokenRate {
  readonly perSecond: number;
  readonly burst: number;
}

/** Which adapter answers, for the startup line, the health check and the metrics. */
export type CacheKind = 'memory' | 'redis';

export interface Cache {
  readonly kind: CacheKind;
  /** The value under the key, or null when there is none or it has expired. */
  get(key: string): Promise<string | null>;
  /** Keeps the value under the key for at most `ttlMs`, replacing what was there. */
  set(key: string, value: string, ttlMs: number): Promise<void>;
  /** Keeps the value only when the key holds nothing: true when it was kept (the first of several to ask wins). */
  add(key: string, value: string, ttlMs: number): Promise<boolean>;
  /** Removes the key and gives what it held, in one step: a one-time code is used once, whoever asks at once. */
  take(key: string): Promise<string | null>;
  /** Removes the key; nothing happens when it holds nothing. */
  delete(key: string): Promise<void>;
  /**
   * Adds `by` to a counter and gives its new value; a counter that did not exist starts at zero and expires `ttlMs`
   * after it was made (a later increment does not move that), so a window of counting closes by itself.
   */
  increment(key: string, ttlMs: number, by?: number): Promise<number>;
  /**
   * Takes one token from each bucket named, all or none: 0 when taken, otherwise how many milliseconds until every one
   * of them has a token again (nothing is taken then). A bucket not seen before is full.
   */
  spend(keys: readonly string[], rate: TokenRate): Promise<number>;
  /** Gives one token back to each bucket named that exists (a token taken for a request that was then refused). */
  refund(keys: readonly string[], rate: TokenRate): Promise<void>;
  /** Whether the cache answers now: always for memory, a round trip for a server (the readiness check asks). */
  ping(): Promise<boolean>;
  /** Lets go of the connection, if there is one; calls after it fail. */
  close(): Promise<void>;
}
