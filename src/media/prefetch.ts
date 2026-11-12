/**
 * Fetching the next tracks while the current one plays, so the next song starts without a wait.
 *
 * After every change of a server's queue or player, the prefetcher works out which tracks that server will need soon
 * (the current one and the next few), pins them in the cache so eviction leaves them alone, and fetches the missing
 * ones one at a time. One at a time on purpose: several parallel downloads from the same site look like a bot and
 * slow the one that matters. A player with nothing current (stopped, or in a server that removed the bot) needs
 * nothing soon: its fetch stops and its pins go.
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

// A burst of changes (adding a playlist sends one event per batch, a drag sends several) is planned once, this long
// after its first change. The wait is not started again by every change: a loading track reports its progress four
// times a second, and waiting for a quiet moment would put off the plan until the track had loaded.
const SETTLE_MS = 300;

// A track that failed to fetch is not tried again by the prefetcher for this long (the player will say why).
const FAILED_RETRY_MS = 60_000;

// What one server's prefetching holds: its pinned keys, its running fetch and which track that is, its pending plan,
// the tracks that failed lately, and the track the player last had, so a snapshot that only moves the time or the
// progress does not plan again.
interface GuildPlan {
  pinned: Set<string>;
  abort: AbortController | null;
  fetching: string | null;
  timer: TimerHandle | null;
  failed: Map<string, number>;
  player: string;
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
    this.options.bus.on('player', (snapshot) => {
      // Only another track (or none, after a stop) changes what is wanted; a pause, a seek or a progress report does
      // not, and a loading track sends a progress report four times a second.
      const said = String(snapshot.track?.id ?? 'none');
      const plan = this.planOf(snapshot.guildId);
      if (plan.player === said) return;
      plan.player = said;
      this.schedule(snapshot.guildId);
    });
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

  // Plans a server again a moment after the first change of a burst; the changes after it are read by that plan.
  private schedule(guildId: string): void {
    if (this.stopped) return;
    const plan = this.planOf(guildId);
    if (plan.timer !== null) return;
    plan.timer = this.options.clock.setTimeout(() => {
      plan.timer = null;
      void this.run(guildId);
    }, SETTLE_MS);
  }

  private planOf(guildId: string): GuildPlan {
    let plan = this.plans.get(guildId);
    if (!plan) {
      plan = { pinned: new Set(), abort: null, fetching: null, timer: null, failed: new Map(), player: '' };
      this.plans.set(guildId, plan);
    }
    return plan;
  }

  /**
   * The tracks a server will need soon: the current one, then the next `count` in the queue. Nothing for a player
   * with nothing current: it was stopped (by a person, by failures, or because the server removed the bot), and its
   * queue waits for someone to press play.
   */
  wanted(guildId: string): Track[] {
    // existing(): asking must not make a player for a server that never had one.
    const current = this.options.players.existing(guildId)?.snapshot().track ?? null;
    if (!current) return [];
    const next = this.options.queue
      .list(guildId)
      .slice(0, this.options.count)
      .map((item) => item.track);
    return [current, ...next];
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
    if (keys.size === 0) {
      // Nothing wanted: the running fetch stops (the player no longer waits on it either), and the plan is forgotten,
      // apart from what failed lately, which a plan made soon after still needs to know.
      plan.abort?.abort();
      plan.abort = null;
      if (plan.failed.size === 0 && plan.timer === null) this.plans.delete(guildId);
      return;
    }
    // A fetch still wanted goes on: a pause, a seek or a new track at the end changes nothing about the next song,
    // and stopping its download would only start it again. The running loop reads the new plan when it is done.
    if (plan.fetching !== null && keys.has(plan.fetching)) return;
    // Otherwise the old loop stops (its download too, unless the player waits on it) and a new one starts.
    plan.abort?.abort();
    const abort = new AbortController();
    plan.abort = abort;
    const clock = this.options.clock;
    // One track at a time, the plan read again after each: the first wanted track that is not cached, not done in this
    // loop, and has not failed lately.
    const done = new Set<string>();
    while (!abort.signal.aborted && !this.stopped) {
      const next = this.wanted(guildId).find((track) => {
        const key = MediaCache.keyOf(track.source);
        const failedAt = plan.failed.get(key);
        const failedLately = failedAt !== undefined && clock.steady() - failedAt <= FAILED_RETRY_MS;
        return !this.options.cache.has(key) && !done.has(key) && !failedLately;
      });
      if (!next) break;
      const key = MediaCache.keyOf(next.source);
      plan.fetching = key;
      try {
        // Ahead of time: it takes its turn among every server's fetches, after any track somebody waits for.
        const media = await this.options.media.prepare(next, abort.signal, undefined, 'ahead');
        done.add(key);
        // Fetched from its site just now (not found in the cache meanwhile): the server's player counts it as proof that
        // the site works, as one it fetched itself (see Player.fetchedAhead).
        if (!media.fromCache) this.options.players.existing(guildId)?.fetchedAhead();
      } catch (error) {
        if (abort.signal.aborted) return;
        plan.failed.set(key, clock.steady());
        // The player will say what is wrong when it gets there; here it is only worth a debug line.
        this.options.log.debug('prefetch failed', { guild: guildId, track: next.url, error });
      } finally {
        if (plan.fetching === key) plan.fetching = null;
      }
    }
  }
}
