/**
 * Autoplay: when a server's queue is about to run out, one more track, picked by the server's own mode.
 *
 * - history: one of the tracks the server played (within the history kept), drawn at random with more weight for
 *   the ones played more and liked by more people, none of the last thirty plays, none queued, not the one playing.
 * - related: the first track of YouTube's mix of the track playing (one yt-dlp listing, kept for a while) that was not
 *   played lately; the server's history when the track is not on YouTube or the mix has nothing new.
 *
 * The track is queued when the last one in the queue starts (it loads), so the prefetcher fetches it while that one
 * plays and the music goes on without a gap. Its row says "autoplay" where a person's ID would be. One pick per start
 * of a track: a person who removes the pick, or clears the queue, is not overruled until the next track starts. A
 * person's Stop ends it: a pick under way is dropped and nothing is picked until a track starts again; a stop asked for
 * after this track (the player's stop-after) is a Stop too, when it comes. Nothing is picked while a repeat is on (the
 * queue does not run out then), and nothing while the music does not go on: a player paused by a person, or resting
 * with nobody listening (app/rest.ts), gets its pick when it plays again, and a pick that comes back to a paused player
 * is made again then. A pick that comes after the last track ended by itself starts the player again; one that comes
 * after a Stop does not.
 */
import type { Bus } from '../core/bus.ts';
import type { Clock, TimerHandle } from '../core/clock.ts';
import type { PlayerSnapshot } from '../core/player.ts';
import type { Players } from '../core/players.ts';
import type { QueueService } from '../core/queue.ts';
import { AUTOPLAY, type NewTrack, type Track } from '../core/types.ts';
import type { Logger } from '../log.ts';
import type { AddressCheck } from '../media/address.ts';
import type { Resolver } from '../media/resolver.ts';
import { youtubeVideoId } from '../media/source.ts';
import type { YtDlp } from '../media/ytdlp.ts';
import type { Store } from '../store/store.ts';

/** How many of a server's newest plays a pick stays clear of. */
export const AUTOPLAY_RECENT = 30;

// How much a like weighs against a play when a track is drawn from the history.
const LIKE_WEIGHT = 2;
// How long a YouTube mix is kept (the same track playing again soon asks no second time), and how many are kept.
const MIX_KEEP_MS = 6 * 3_600_000;
const MIXES_KEPT = 200;
// How many tracks of a mix are listed (the first ones are the most related).
const MIX_SIZE = 25;
// A burst of changes (a track starting sends a few snapshots, the queue a message) is looked at once, a moment later.
const SETTLE_MS = 300;

export interface AutoplayOptions {
  readonly bus: Bus;
  readonly players: Players;
  readonly queue: QueueService;
  readonly store: Store;
  /** The lookup slots shared with the resolver and the search: a mix is one listing in one of them. */
  readonly slots: Pick<Resolver, 'run'>;
  /** YouTube's mix of a video (absent: "related" picks from the history). */
  readonly ytdlp?: Pick<YtDlp, 'mix'> | null;
  /** The check every address added goes through (private networks refused); none: all pass. */
  readonly checkAddress?: AddressCheck;
  readonly clock: Clock;
  readonly log: Logger;
  /** The longest track that may be added (JUKECORD_TRACK_MAX); longer ones are not picked. */
  readonly trackMaxMs: number;
  /** A random number in [0, 1), for the draw from the history (tests fix it). */
  readonly random?: () => number;
}

// What autoplay keeps per server: the starts of tracks seen, the start a pick was made for, a pick under way, whether
// a person stopped the music, the pending look, the last status seen (a new start is a change into loading), and
// whether a stop was asked for after the track (the player going idle then is a person's Stop).
interface ServerState {
  starts: number;
  pickedFor: string | null;
  picking: AbortController | null;
  stopped: boolean;
  timer: TimerHandle | null;
  status: PlayerSnapshot['status'] | null;
  track: number | null;
  stopAfter: boolean;
}

export class Autoplay {
  private readonly options: AutoplayOptions;
  private readonly servers = new Map<string, ServerState>();
  // YouTube's mixes by video ID, oldest first.
  private readonly mixes = new Map<string, { at: number; tracks: NewTrack[] }>();
  private started = false;

  constructor(options: AutoplayOptions) {
    this.options = options;
  }

  /** Starts listening to the players and the queues. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.options.bus.on('player', (snapshot) => {
      const state = this.stateOf(snapshot.guildId);
      // A track starting: the player goes into loading with it (from idle, or from another track). A person's Stop
      // counts until then.
      const starting =
        snapshot.status === 'loading' &&
        snapshot.track !== null &&
        (state.status !== 'loading' || state.track !== snapshot.track.id);
      if (starting) {
        state.starts += 1;
        state.stopped = false;
      }
      // The track a stop was asked for after has ended, and the player stopped with it: that is a person's Stop.
      if (snapshot.status === 'idle' && state.stopAfter) this.stopped(snapshot.guildId);
      state.stopAfter = snapshot.stopAfter;
      state.status = snapshot.status;
      state.track = snapshot.track?.id ?? null;
      this.schedule(snapshot.guildId);
    });
    this.options.bus.on('queue', (change) => this.schedule(change.guildId));
  }

  /** A person stopped the music: a pick under way is dropped, and nothing is picked until a track starts again. */
  stopped(guildId: string): void {
    const state = this.stateOf(guildId);
    state.stopped = true;
    state.picking?.abort();
    state.picking = null;
  }

  /** Looks at a server now (for tests; the bus does it a moment after each change). */
  async check(guildId: string): Promise<void> {
    const state = this.stateOf(guildId);
    if (state.timer !== null) {
      this.options.clock.clearTimeout(state.timer);
      state.timer = null;
    }
    const player = this.options.players.existing(guildId);
    if (!player) return;
    const snapshot = player.snapshot();
    // Off, or a repeat that keeps the queue from running out: a pick under way is not wanted any more.
    if (snapshot.autoplay === 'off' || snapshot.repeat !== 'off') {
      state.picking?.abort();
      state.picking = null;
      return;
    }
    // Picked when a track is current and nothing waits after it; once per start; not after a person's Stop.
    if (!snapshot.track || state.stopped || state.picking) return;
    // Only while the music goes on (a track loading or playing), and not when it stops after this track: a paused
    // player (a person's pause, or resting with nobody listening) is looked at again when it plays on.
    if ((snapshot.status !== 'loading' && snapshot.status !== 'playing') || snapshot.stopAfter) return;
    if (this.options.queue.size(guildId) > 0) return;
    const start = `${snapshot.track.id}:${state.starts}`;
    if (state.pickedFor === start) return;
    state.pickedFor = start;
    const stop = new AbortController();
    state.picking = stop;
    try {
      const pick = await this.pick(guildId, snapshot, stop.signal);
      if (stop.signal.aborted) return;
      if (!pick) {
        this.options.log.info('autoplay found nothing to play', { guild: guildId, mode: snapshot.autoplay });
        return;
      }
      // Still wanted? Nothing queued meanwhile, the same mode, no Stop, and the player still on this start or idle
      // after it (the track ended, or was skipped, before the pick came).
      const now = player.snapshot();
      // Paused meanwhile (by a person, or resting with nobody listening), or asked to stop after this track: nothing is
      // queued now, and the pick is made again when the music goes on.
      if (now.status === 'paused' || now.stopAfter) {
        if (state.pickedFor === start) state.pickedFor = null;
        return;
      }
      const sameStart = now.track !== null && `${now.track.id}:${state.starts}` === start;
      if (
        this.options.queue.size(guildId) > 0 ||
        now.autoplay === 'off' ||
        now.repeat !== 'off' ||
        state.stopped ||
        !(sameStart || now.status === 'idle')
      )
        return;
      this.options.queue.add(guildId, [pick.id], 'end', AUTOPLAY);
      this.options.log.info('autoplay queued a track', { guild: guildId, mode: snapshot.autoplay, track: pick.url });
      // Ended by itself before the pick came: the music goes on.
      if (now.status === 'idle') player.play();
    } catch (error) {
      if (!stop.signal.aborted)
        this.options.log.info('autoplay could not pick a track', {
          guild: guildId,
          reason: error instanceof Error ? error.message : String(error),
        });
    } finally {
      if (state.picking === stop) state.picking = null;
    }
  }

  // The track to queue for the server's mode, or null.
  private async pick(guildId: string, snapshot: PlayerSnapshot, signal: AbortSignal): Promise<Track | null> {
    const current = snapshot.track;
    // Clear of the newest plays, of what waits (nothing, but a person may add meanwhile), and of the track playing.
    const avoid = new Set(this.options.store.history.recentTrackIds(guildId, AUTOPLAY_RECENT));
    for (const item of this.options.queue.list(guildId)) avoid.add(item.track.id);
    if (current) avoid.add(current.id);
    if (snapshot.autoplay === 'related' && current) {
      try {
        const related = await this.related(guildId, current, avoid, signal);
        if (related) return related;
      } catch (error) {
        if (signal.aborted) throw error;
        // No mix this time (YouTube refusing, every lookup slot taken): the server's own plays instead.
        this.options.log.info('autoplay could not get the mix; picking from the history', {
          guild: guildId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return this.fromHistory(guildId, avoid);
  }

  /** A track drawn from the server's plays, weighted by how often it played and how many liked it; null for none. */
  fromHistory(guildId: string, avoid: ReadonlySet<number>): Track | null {
    const candidates = this.options.store.history
      .playCounts(guildId)
      .filter(
        (entry) =>
          !avoid.has(entry.trackId) && (entry.durationMs === null || entry.durationMs <= this.options.trackMaxMs),
      );
    if (candidates.length === 0) return null;
    const weights = candidates.map((entry) => entry.plays + LIKE_WEIGHT * entry.likes);
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let left = (this.options.random ?? Math.random)() * total;
    for (const [index, entry] of candidates.entries()) {
      left -= weights[index] ?? 0;
      if (left < 0) return this.options.store.tracks.get(entry.trackId);
    }
    // Rounding at the very end of the draw: the last one.
    const last = candidates.at(-1);
    return last ? this.options.store.tracks.get(last.trackId) : null;
  }

  // The first track of YouTube's mix of the playing track that was not played lately, stored as a track; null when
  // the track is not a YouTube video or the mix has nothing new.
  private async related(
    guildId: string,
    current: Track,
    avoid: ReadonlySet<number>,
    signal: AbortSignal,
  ): Promise<Track | null> {
    const ytdlp = this.options.ytdlp;
    let address: URL;
    try {
      address = new URL(current.url);
    } catch {
      return null;
    }
    const id = youtubeVideoId(address);
    if (!ytdlp || !id) return null;
    let mix = this.mixes.get(id);
    if (!mix || this.options.clock.now() - mix.at > MIX_KEEP_MS) {
      // In one of the lookup slots, counted for the server (jukecord asks, not a person).
      const tracks = await this.options.slots.run(null, guildId, () => ytdlp.mix(id, MIX_SIZE, signal));
      mix = { at: this.options.clock.now(), tracks };
      this.mixes.delete(id);
      this.mixes.set(id, mix);
      while (this.mixes.size > MIXES_KEPT) {
        const oldest = this.mixes.keys().next().value;
        if (oldest === undefined) break;
        this.mixes.delete(oldest);
      }
    }
    for (const entry of mix.tracks) {
      if (signal.aborted) return null;
      if (entry.source === current.source) continue;
      if (entry.durationMs !== null && entry.durationMs > this.options.trackMaxMs) continue;
      const known = this.options.store.tracks.bySource(entry.source);
      if (known && avoid.has(known.id)) continue;
      // The same check as any address added: a mix lists YouTube's own pages, but nothing is taken on trust.
      try {
        await this.options.checkAddress?.(new URL(entry.url));
      } catch {
        continue;
      }
      return this.options.store.tracks.upsert(entry);
    }
    return null;
  }

  // Looks at a server a moment after the first change of a burst.
  private schedule(guildId: string): void {
    const state = this.stateOf(guildId);
    if (state.timer !== null) return;
    state.timer = this.options.clock.setTimeout(() => {
      state.timer = null;
      void this.check(guildId);
    }, SETTLE_MS);
  }

  private stateOf(guildId: string): ServerState {
    let state = this.servers.get(guildId);
    if (!state) {
      state = {
        starts: 0,
        pickedFor: null,
        picking: null,
        stopped: false,
        timer: null,
        status: null,
        track: null,
        stopAfter: false,
      };
      this.servers.set(guildId, state);
    }
    return state;
  }
}
