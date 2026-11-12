/**
 * How fast changes may come, and when jukecord turns work away because it has fallen behind.
 *
 * Every change through the API takes one token from the bucket of its login and one from the bucket of its address;
 * a bucket refills at a steady rate up to a small burst, so a person clicking quickly or a script doing a few things at
 * once is not slowed, while a loop sending hundreds a second is told to wait (429, with Retry-After). The changes that
 * start a fetch somebody waits for (skip, play now, jump, drop) have a second, tighter bucket: each one starts yt-dlp
 * and ffmpeg. The host (its own command line, its login links) is not limited.
 *
 * Shedding: when the event loop has fallen behind (the 99th percentile of its delay over the last second is above a
 * limit), the work that can wait (sending audio, changes from anyone but the host) is answered with 503 and a
 * Retry-After at once, so what is already running (the voice of every server, the panels' live updates) catches up.
 * The health checks, logging in and what a panel reads to come back are never turned away.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { steadyNow } from '../core/clock.ts';

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

// One bucket: what it held at time `at`.
interface Bucket {
  tokens: number;
  at: number;
}

/** Token buckets by key, the least recently used dropped beyond `capacity` (a scan from many addresses cannot grow it). */
export class Buckets {
  private readonly rate: Rate;
  private readonly now: () => number;
  private readonly capacity: number;
  // Insertion order is the order of last use, oldest first.
  private readonly buckets = new Map<string, Bucket>();

  constructor(rate: Rate, options: { now?: () => number; capacity?: number } = {}) {
    this.rate = rate;
    // The steady clock: a system clock set back would otherwise leave every bucket empty for that long.
    this.now = options.now ?? steadyNow;
    this.capacity = options.capacity ?? 10_000;
  }

  /** How many milliseconds until every one of these keys has a token: 0 when they all have one now. */
  wait(keys: readonly string[]): number {
    let longest = 0;
    for (const key of keys) {
      const tokens = this.level(key);
      // The time the missing part of one token takes to come back at the steady rate.
      if (tokens < 1) longest = Math.max(longest, Math.ceil(((1 - tokens) * 1000) / this.rate.perSecond));
    }
    return longest;
  }

  /** Takes a token from each key (after wait() said 0). */
  take(keys: readonly string[]): void {
    const now = this.now();
    for (const key of keys) {
      const tokens = this.level(key);
      // Moved to the end: the most recently used.
      this.buckets.delete(key);
      this.buckets.set(key, { tokens: Math.max(0, tokens - 1), at: now });
    }
    while (this.buckets.size > this.capacity) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
  }

  /** Gives a token back to each key that has a bucket (one taken for a request that was then refused). */
  give(keys: readonly string[]): void {
    const now = this.now();
    for (const key of keys) {
      if (!this.buckets.has(key)) continue;
      this.buckets.set(key, { tokens: Math.min(this.rate.burst, this.level(key) + 1), at: now });
    }
  }

  // What a key's bucket holds now: what it held, plus what came back since, up to the burst. A new key is full.
  private level(key: string): number {
    const bucket = this.buckets.get(key);
    if (!bucket) return this.rate.burst;
    const back = ((this.now() - bucket.at) / 1000) * this.rate.perSecond;
    return Math.min(this.rate.burst, bucket.tokens + back);
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
