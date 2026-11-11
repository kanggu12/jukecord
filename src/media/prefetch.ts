/**
 * Fetching the next tracks while the current one plays, so the next song starts without a wait.
 *
 * After every change of a server's queue or player, the prefetcher works out which tracks that server will need soon
 * (the current one and the next few), pins them in the cache so eviction leaves them alone, and fetches the missing
 * ones one at a time. One at a time on purpose: several parallel downloads from the same site look like a bot and
 * slow the one that matters.
 */
import type { Bus } from '../core/bus.ts';
import type { Clock, TimerHandle } from '../core/clock.ts';
import type { MediaPreparer } from '../core/player.ts';
import type { Players } from '../core/players.ts';
import type { QueueService } from '../core/queue.ts';
import type { Track } from '../core/types.ts';
import type { Logger } from '../log.ts';
import { MediaCache } from './cache.ts';

export interface PrefetcherOptions {
  readonly bus: Bus;
  readonly players: Players;
  readonly queue: QueueService;
  readonly media: MediaPreparer;
  readonly cache: MediaCache;
  readonly clock: Clock;
  readonly log: Logger;
  /** How many tracks after the current one are fetched ahead. */
  readonly count: number;
}

// A burst of changes (adding a playlist sends one event per batch, a drag sends several) is planned once, after it.
const SETTLE_MS = 300;

// What one server's prefetching holds: its pinned keys, its running fetch, its pending plan.
interface GuildPlan {
  pinned: Set<string>;
  abort: AbortController | null;
  timer: TimerHandle | null;
}

export class Prefetcher {
  private readonly options: PrefetcherOptions;
  private readonly plans = new Map<string, GuildPlan>();
  private stopped = false;

  constructor(options: PrefetcherOptions) {
    this.options = options;
  }

  /** Starts listening for changes. */
  start(): void {
    this.options.bus.on('queue', (event) => this.schedule(event.guildId));
    this.options.bus.on('player', (snapshot) => this.schedule(snapshot.guildId));
  }

  /** Cancels every fetch and drops every pin (shutting down). */
  stop(): void {
    this.stopped = true;
    for (const plan of this.plans.values()) {
      plan.abort?.abort();
      if (plan.timer !== null) this.options.clock.clearTimeout(plan.timer);
      for (const key of plan.pinned) this.options.cache.unpin(key);
      plan.pinned.clear();
    }
  }

  // Plans a server again once the burst of changes is over.
  private schedule(guildId: string): void {
    if (this.stopped) return;
    const plan = this.planOf(guildId);
    if (plan.timer !== null) this.options.clock.clearTimeout(plan.timer);
    plan.timer = this.options.clock.setTimeout(() => {
      plan.timer = null;
      void this.run(guildId);
    }, SETTLE_MS);
  }

  private planOf(guildId: string): GuildPlan {
    let plan = this.plans.get(guildId);
    if (!plan) {
      plan = { pinned: new Set(), abort: null, timer: null };
      this.plans.set(guildId, plan);
    }
    return plan;
  }

  /** The tracks a server will need soon: the current one, then the next `count` in the queue. */
  wanted(guildId: string): Track[] {
    const current = this.options.players.get(guildId).snapshot().track;
    const next = this.options.queue
      .list(guildId)
      .slice(0, this.options.count)
      .map((item) => item.track);
    return current ? [current, ...next] : next;
  }

  // Pins what is wanted, unpins what is not, and fetches the missing tracks in order.
  private async run(guildId: string): Promise<void> {
    const plan = this.planOf(guildId);
    const tracks = this.wanted(guildId);
    const keys = new Set(tracks.map((track) => MediaCache.keyOf(track.source)));
    // Pin the new set before unpinning the old, so a key in both is never briefly unprotected.
    for (const key of keys) if (!plan.pinned.has(key)) this.options.cache.pin(key);
    for (const key of plan.pinned) if (!keys.has(key)) this.options.cache.unpin(key);
    plan.pinned = keys;
    // A plan that changed replaces the fetch of the old one (the shared download keeps going if the player waits on it).
    plan.abort?.abort();
    const abort = new AbortController();
    plan.abort = abort;
    for (const track of tracks) {
      if (abort.signal.aborted) return;
      if (this.options.cache.has(MediaCache.keyOf(track.source))) continue;
      try {
        await this.options.media.prepare(track, abort.signal);
      } catch (error) {
        if (abort.signal.aborted) return;
        // The player will say what is wrong when it gets there; here it is only worth a debug line.
        this.options.log.debug('prefetch failed', { guild: guildId, track: track.url, error });
      }
    }
  }
}
