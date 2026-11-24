/**
 * The cache on a Redis or Valkey server (JUKECORD_CACHE_URL): what several edges must count together, and what is
 * worth keeping past a restart of the core.
 *
 * Every key goes under the prefix (JUKECORD_KEY_PREFIX, "jukecord" by default), so several jukecords can share one
 * server: `<prefix>:cache:<key>` for values and counters, `<prefix>:bucket:<key>` for token buckets. A bucket is a
 * small hash (tokens, and when it held them, on the server's clock: every edge counts by the same clock), worked out
 * in one Lua script, so a request that takes a token from several buckets takes from all or from none, whatever the
 * other edges do at the same moment; it expires once it would be full again. One-time values are taken with GETDEL,
 * so two edges that ask at once cannot both have one: the server must be Redis 6.2 or newer, or any Valkey.
 *
 * Calls while the server is away fail at once (the connection queues nothing): the callers decide what that means
 * (the rate limits let a request through, a lookup simply finds nothing). Each read is reported as found or not, and
 * each call that fails as a failure (src/metrics/services.ts), as the memory adapter reports its reads.
 */
import { connectRedis, type RedisConnection, runScript, type Script } from '../bus/redis.ts';
import type { Logger } from '../log.ts';
import { NO_SHARED_CACHE_REPORT, type SharedCacheReport } from '../metrics/services.ts';
import type { Cache, TokenRate } from './cache.ts';

// Takes a token from every bucket or from none: 0, or how many milliseconds until every one has a token again.
// ARGV: tokens a second, the burst, how long a bucket lives after its last use (ms).
const SPEND: Script = {
  text: `local now = redis.call('TIME')
local ms = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local longest = 0
local levels = {}
for i, key in ipairs(KEYS) do
  local held = redis.call('HMGET', key, 't', 'a')
  local level = burst
  if held[1] then
    level = math.min(burst, tonumber(held[1]) + math.max(0, ms - tonumber(held[2])) / 1000 * rate)
  end
  levels[i] = level
  if level < 1 then
    local wait = math.ceil((1 - level) * 1000 / rate)
    if wait > longest then longest = wait end
  end
end
if longest > 0 then return longest end
for i, key in ipairs(KEYS) do
  redis.call('HSET', key, 't', tostring(math.max(0, levels[i] - 1)), 'a', tostring(ms))
  redis.call('PEXPIRE', key, ARGV[3])
end
return 0`,
  sha: null,
};

// Gives one token back to every bucket that exists, up to the burst.
const REFUND: Script = {
  text: `local now = redis.call('TIME')
local ms = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
for _, key in ipairs(KEYS) do
  local held = redis.call('HMGET', key, 't', 'a')
  if held[1] then
    local level = math.min(burst, tonumber(held[1]) + math.max(0, ms - tonumber(held[2])) / 1000 * rate)
    redis.call('HSET', key, 't', tostring(math.min(burst, level + 1)), 'a', tostring(ms))
    redis.call('PEXPIRE', key, ARGV[3])
  end
end
return 0`,
  sha: null,
};

// Adds to a counter; a counter just made (no expiry yet) gets its window, a later increment does not move it.
const INCREMENT: Script = {
  text: `local value = redis.call(ARGV[3], KEYS[1], ARGV[1])
if redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return tostring(value)`,
  sha: null,
};

export class RedisCache implements Cache {
  readonly kind = 'redis';
  private readonly client: RedisConnection;
  private readonly prefix: string;
  private readonly report: SharedCacheReport;

  private constructor(client: RedisConnection, prefix: string, report: SharedCacheReport) {
    this.client = client;
    this.prefix = prefix;
    this.report = report;
  }

  /** Connects to the server at `url`, waiting for it up to `waitMs` (60 s by default). */
  static async open(
    url: string,
    options: { prefix: string; log: Logger; service: string; report?: SharedCacheReport; waitMs?: number },
  ): Promise<RedisCache> {
    const client = await connectRedis(url, {
      log: options.log,
      name: `jukecord-${options.service}-cache`,
      ...(options.waitMs !== undefined ? { waitMs: options.waitMs } : {}),
    });
    return new RedisCache(client, options.prefix, options.report ?? NO_SHARED_CACHE_REPORT);
  }

  async get(key: string): Promise<string | null> {
    const value = await this.call(this.client.sendCommand(['GET', this.entry(key)]));
    const found = typeof value === 'string' ? value : null;
    this.report.lookup(found !== null);
    return found;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    await this.call(this.client.sendCommand(['SET', this.entry(key), value, 'PX', String(ttl(ttlMs))]));
  }

  async add(key: string, value: string, ttlMs: number): Promise<boolean> {
    // OK when it was free (and is now this value's); null when it held something.
    const answer = await this.call(
      this.client.sendCommand(['SET', this.entry(key), value, 'NX', 'PX', String(ttl(ttlMs))]),
    );
    return answer === 'OK';
  }

  async take(key: string): Promise<string | null> {
    const value = await this.call(this.client.sendCommand(['GETDEL', this.entry(key)]));
    const found = typeof value === 'string' ? value : null;
    this.report.lookup(found !== null);
    return found;
  }

  async delete(key: string): Promise<void> {
    await this.call(this.client.sendCommand(['DEL', this.entry(key)]));
  }

  async increment(key: string, ttlMs: number, by = 1): Promise<number> {
    // Whole steps as integers; a fraction (none of jukecord's counters has one) as a float.
    const command = Number.isInteger(by) ? 'INCRBY' : 'INCRBYFLOAT';
    return Number(await this.call(runScript(this.client, INCREMENT, [this.entry(key)], [by, ttl(ttlMs), command])));
  }

  async spend(keys: readonly string[], rate: TokenRate): Promise<number> {
    if (keys.length === 0) return 0;
    const buckets = keys.map((key) => this.bucket(key));
    return Number(
      await this.call(runScript(this.client, SPEND, buckets, [rate.perSecond, rate.burst, lifetime(rate)])),
    );
  }

  async refund(keys: readonly string[], rate: TokenRate): Promise<void> {
    if (keys.length === 0) return;
    const buckets = keys.map((key) => this.bucket(key));
    await this.call(runScript(this.client, REFUND, buckets, [rate.perSecond, rate.burst, lifetime(rate)]));
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.ping();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => this.client.destroy());
  }

  // A call to the server, reported when it fails (the server out of reach, or an error answer); passed on either way.
  private async call<T>(work: Promise<T>): Promise<T> {
    try {
      return await work;
    } catch (error) {
      this.report.failed();
      throw error;
    }
  }

  private entry(key: string): string {
    return `${this.prefix}:cache:${key}`;
  }

  private bucket(key: string): string {
    return `${this.prefix}:bucket:${key}`;
  }
}

// An age as the server takes it: whole milliseconds, at least one (PX 0 is an error).
function ttl(ms: number): number {
  return Math.max(1, Math.ceil(ms));
}

// How long a bucket is kept after its last use: until it would be full again, and a second more.
function lifetime(rate: TokenRate): number {
  return Math.ceil((rate.burst / rate.perSecond) * 1000) + 1000;
}
