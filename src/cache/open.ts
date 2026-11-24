/**
 * The cache a process uses: in its memory (one process, the default), or on a Redis or Valkey server when one is named
 * (JUKECORD_CACHE_URL; a split jukecord takes its bus's server unless told otherwise). Either way it is counted in the
 * metrics (metered.ts).
 */
import type { Logger } from '../log.ts';
import type { Metrics } from '../metrics/registry.ts';
import type { Cache } from './cache.ts';
import { MemoryCache } from './memory.ts';
import { MeteredCache } from './metered.ts';
import { RedisCache } from './redis.ts';

/**
 * The memory cache's bounds in a jukecord process: what its users kept apart before they shared one cache, added up
 * (the searches' 300 answers and 3,000 results, 5,000 matches of other services' tracks, 10,000 addresses' failed
 * logins and the login links), and room for every rate limit's 10,000 buckets (five of them).
 */
export const MEMORY_ENTRIES = 25_000;
export const MEMORY_BUCKETS = 50_000;

export interface OpenCacheOptions {
  /** "memory", or a redis://, rediss://, valkey:// or valkeys:// address. */
  readonly url: string;
  /** What every key goes under on a server shared with others (JUKECORD_KEY_PREFIX). */
  readonly prefix: string;
  readonly log: Logger;
  /** Which service connects, for the server's list of clients ("core", "edge-3f9a..."). */
  readonly service: string;
  readonly metrics?: Metrics;
  /** How long to wait for the server at the start (60 s by default). */
  readonly waitMs?: number;
}

/** Opens the cache the settings name, counted in the metrics. */
export async function openCache(options: OpenCacheOptions): Promise<Cache> {
  const inner =
    options.url === 'memory'
      ? new MemoryCache({ capacity: MEMORY_ENTRIES, buckets: MEMORY_BUCKETS })
      : await RedisCache.open(options.url, {
          prefix: options.prefix,
          log: options.log,
          service: options.service,
          ...(options.waitMs !== undefined ? { waitMs: options.waitMs } : {}),
        });
  return new MeteredCache(inner, options.metrics);
}
