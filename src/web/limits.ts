/**
 * How fast changes may come, and when jukecord turns work away because it has fallen behind.
 *
 * Every change through the API takes one token from the bucket of its login and one from the bucket of its address;
 * a bucket refills at a steady rate up to a small burst, so a person clicking quickly or a script doing a few things at
 * once is not slowed, while a loop sending hundreds a second is told to wait (429, with Retry-After). The changes that
 * start a fetch somebody waits for (skip, play now, jump, drop) have a second, tighter bucket: each one starts yt-dlp
 * and ffmpeg. The host (its own command line, its login links) is not limited.
 *
 * The buckets live in the shared cache (src/cache/): in this process's memory by default, on Redis or Valkey when
 * several edges serve the browsers, so a login spread over them is counted once.
 *
 * Shedding: when the event loop has fallen behind (the 99th percentile of its delay over the last second is above a
 * limit), the work that can wait (sending audio, changes from anyone but the host) is answered with 503 and a
 * Retry-After at once, so what is already running (the voice of every server, the panels' live updates) catches up.
 * The health checks, logging in and what a panel reads to come back are never turned away.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Cache } from '../cache/cache.ts';
import type { Logger } from '../log.ts';

/** A steady rate (tokens a second) and the most that may be spent at once. */
export interface Rate {
  readonly perSecond: number;
  readonly burst: number;
}

/** Changes per login and per address: ten a second on average, twenty at once. */
export const CHANGES: Rate = { perSecond: 10, burst: 20 };

/** Changes that start a fetch now (skip, play now, jump, drop): two a second, five at once. */
export const FETCHES: Rate = { perSecond: 2, burst: 5 };

/**
 * Searches, per login and per address, on top of the reads': each one starts yt-dlp (a second or two of a process).
 * One a second, five at once: the panel searches a moment after typing stops, and Discord's suggestions come one
 * per pause too.
 */
export const SEARCHES: Rate = { perSecond: 1, burst: 5 };

/**
 * Reads: thirty a second, sixty at once. A panel reads a handful when it opens and gets the rest over its live
 * connection; a burst of the heavier reads (a year of statistics, a thousand-track queue) sent in one go would hold the
 * event loop for as long as the work takes.
 */
export const READS: Rate = { perSecond: 30, burst: 60 };

/**
 * Covers jukecord must fetch before it can send them (src/media/covers.ts): ten a second, sixty at once. A panel shows
 * a few dozen at most when it opens; a cached cover takes nothing from this.
 */
export const COVERS: Rate = { perSecond: 10, burst: 60 };

/**
 * One kind of request's rate, its buckets kept in the shared cache by family ("changes", "reads" ...), so the buckets
 * of two kinds never mix and several edges count one login together.
 */
export class Limit {
  private readonly cache: Cache;
  private readonly family: string;
  private readonly rate: Rate;
  private readonly log: Logger | null;
  // When the log last said the cache could not count, so an outage is one line a minute.
  private failedToldAt = Number.NEGATIVE_INFINITY;

  constructor(cache: Cache, family: string, rate: Rate, log: Logger | null = null) {
    this.cache = cache;
    this.family = family;
    this.rate = rate;
    this.log = log;
  }

  /**
   * Takes a token from each key's bucket, from all of them or from none: 0 when taken, otherwise how many milliseconds
   * until every one has a token again. A cache that cannot be reached counts nothing and lets the request through: the
   * rates keep a flood from drowning jukecord, and turning everyone away while the cache is down would be the flood's
   * own effect.
   */
  async spend(keys: readonly string[]): Promise<number> {
    try {
      return await this.cache.spend(this.named(keys), this.rate);
    } catch (error) {
      this.failed(error);
      return 0;
    }
  }

  /** Gives back the token a request took (one refused afterwards); nothing when the cache cannot be reached. */
  async refund(keys: readonly string[]): Promise<void> {
    try {
      await this.cache.refund(this.named(keys), this.rate);
    } catch (error) {
      this.failed(error);
    }
  }

  // The keys as the cache keeps them: under this kind's family.
  private named(keys: readonly string[]): string[] {
    return keys.map((key) => `limits ${this.family} ${key}`);
  }

  private failed(error: unknown): void {
    if (Date.now() - this.failedToldAt < 60_000) return;
    this.failedToldAt = Date.now();
    this.log?.warn('the rates could not be counted (the shared cache does not answer); requests go through meanwhile', {
      error,
    });
  }
}

/** How far behind the event loop is, measured every second; `behind` when the last second's 99th percentile is over. */
export class Pressure {
  private readonly limitMs: number;
  private readonly histogram = monitorEventLoopDelay({ resolution: 10 });
  private readonly timer: NodeJS.Timeout;
  private lastMs = 0;

  constructor(options: { limitMs?: number; everyMs?: number } = {}) {
    this.limitMs = options.limitMs ?? 200;
    this.histogram.enable();
    this.timer = setInterval(() => {
      // The delays of the last second (nanoseconds), then a fresh start: a busy moment ends when it is over.
      this.lastMs = this.histogram.percentile(99) / 1e6;
      this.histogram.reset();
    }, options.everyMs ?? 1000);
    // Measuring must not keep the process alive.
    this.timer.unref();
  }

  /** The 99th percentile of the event loop's delay over the last second, in milliseconds. */
  get delayMs(): number {
    return this.lastMs;
  }

  /** Whether jukecord is so far behind that work which can wait should be turned away. */
  get behind(): boolean {
    return this.lastMs > this.limitMs;
  }

  stop(): void {
    clearInterval(this.timer);
    this.histogram.disable();
  }
}
