/**
 * The player of one server: which track is current, where in it we are, and what happens next.
 *
 * It is the clock everyone follows. The voice connection and the browsers do not decide where the song is; they are
 * told by this object, so a browser that joins late and the voice channel play the same second. Every change goes
 * through one of the methods below and ends in emit(), which bumps the version, tells the bus and saves the state.
 *
 * States: idle (nothing current) -> loading (fetching the current track) -> playing <-> paused -> next track or idle.
 * A failed load moves on to the next track. Each start of the outputs gets a new session number; anything that
 * arrives for an older session (an "ended" from a stream already replaced) is ignored. That number replaces the
 * flags the old code used to tell its own seeks apart from real changes.
 *
 * Every change takes the server's turn (core/lanes.ts), so two changes of one player never interleave. A change does
 * its database work first (writing the play into the history, taking the next item out of the queue), then changes
 * what the player holds in one go, then saves and tells: whoever reads the player meanwhile (a panel asking what
 * plays) sees it before the change or after it, never halfway. What a timer, a fetch or an output starts later takes
 * a turn of its own, and checks on its turn that it still belongs to the load or the play it was for.
 */
import type { Logger } from '../log.ts';
import type { AutoplayMode, HistoryRepository, PlayerStateRepository, RepeatMode } from '../store/store.ts';
import type { Bus } from './bus.ts';
import type { Clock, TimerHandle } from './clock.ts';
import { type GuildLanes, throwFromTimer } from './lanes.ts';
import type { QueueService } from './queue.ts';
import { permanentFailure, plainReason } from './reasons.ts';
import type { QueueItem, Track } from './types.ts';

/** What the player is doing. */
export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused';

/** A track made ready to play: a local file and its real length. */
export interface PreparedMedia {
  /** The Ogg/Opus file the outputs read. */
  readonly file: string;
  /** The length measured from the file; the site's figure can be missing or a little off. */
  readonly durationMs: number;
  /**
   * Whether it came from the cache, not from the site just now: a track from the cache says nothing about whether
   * the site works (a looping queue counts only tracks really fetched, see Player.failed).
   */
  readonly fromCache?: boolean;
}

/** Gets a track ready (fetch, convert, measure). Implemented by the media module; faked in tests. */
export interface MediaPreparer {
  /**
   * Must stop work and reject soon after `signal` aborts: a skipped track should not keep downloading. `priority` says
   * whether somebody waits for the track ('now', the default) or it is fetched ahead of time ('ahead'). `onWaiting`
   * hears true when the fetch has to wait for its place among the fetches of every server, and false when it starts.
   */
  prepare(
    track: Track,
    signal: AbortSignal,
    onProgress?: (fraction: number) => void,
    priority?: 'now' | 'ahead',
    onWaiting?: (waiting: boolean) => void,
  ): Promise<PreparedMedia>;
}

/**
 * Something that makes sound from the player's media: the voice connection of the server.
 *
 * Browsers are not outputs; they follow the snapshots on the bus and fetch the stream themselves. An output calls
 * Player.outputEnded(session) when its stream finishes, with the session number it was started with.
 */
export interface PlayerOutput {
  readonly name: string;
  start(media: PreparedMedia, offsetMs: number, session: number): void;
  pause(): void;
  resume(): void;
  stop(): void;
}

/** What the panel, the bot and the API are told after every change. */
export interface PlayerSnapshot {
  readonly guildId: string;
  readonly status: PlayerStatus;
  readonly track: Track | null;
  readonly addedBy: string | null;
  /** Where the track was at time `at`. While playing, a client adds the time passed since `at`. */
  readonly positionMs: number;
  readonly at: number;
  /** The length of the current track when known. */
  readonly durationMs: number | null;
  /** The last failure ("could not fetch ..."), cleared when a track starts playing. */
  readonly error: string | null;
  /** What happens at the end of a track (see Player.setRepeat). */
  readonly repeat: RepeatMode;
  /** How much of the current track is downloaded (0 to 1) while it is loading; null otherwise or when unknown. */
  readonly progress: number | null;
  /** Grows by one with every snapshot, so clients can ignore one that arrives out of order. */
  readonly version: number;
  /**
   * What the player did by itself that people would not see otherwise ("Title: taken out of the looping queue"), in
   * the actions' plain English like `error`; kept until a person changes the player.
   */
  readonly notice: string | null;
  /** Whether the loading track's fetch waits for its turn among the fetches of every server (no progress yet). */
  readonly waiting: boolean;
  /** Whether the player stops when the current track ends (see Player.setStopAfter). */
  readonly stopAfter: boolean;
  /** What happens when the queue runs out (see Player.setAutoplay). */
  readonly autoplay: AutoplayMode;
}

export interface PlayerOptions {
  readonly guildId: string;
  readonly queue: QueueService;
  readonly media: MediaPreparer;
  readonly history: HistoryRepository;
  readonly state: PlayerStateRepository;
  readonly bus: Bus;
  readonly clock: Clock;
  readonly log: Logger;
  /** The servers' lanes, which every change of a server takes its turn in (shared with the actions and the queue). */
  readonly lanes: GuildLanes;
  /** Longest a track may take to get ready before it is skipped. */
  readonly fetchTimeoutMs: number;
  /** Seeks closer together than this are merged into the last one (dragging the bar sends dozens). */
  readonly seekCooldownMs?: number;
  /** How long past the end the player waits for an output to report the end before moving on by itself. */
  readonly endGraceMs?: number;
  /** Hears that a track was taken out of a looping queue, with the full text of its failure (for app/alerts.ts). */
  readonly onLeftLoop?: (guildId: string, track: Track, reason: string) => void;
}

// A track counts as listened to (and goes into the history) once it has played this long; a skip right after the
// start is a "not this one", not a listen.
const MIN_HISTORY_MS = 1000;

// Seeking to the very end would start a stream that ends at once; the last half second is the latest place allowed.
const SEEK_END_MARGIN_MS = 500;

// An output that reports its end this long before the clock's end has failed (a file gone, an ffmpeg that died), it
// has not finished; see outputEnded.
const EARLY_END_MS = 2000;

/** The time limit for getting a track ready: the base limit, and a tenth of the track's length on top. */
export function fetchLimitMs(baseMs: number, durationMs: number | null): number {
  return baseMs + Math.round((durationMs ?? 0) / 10);
}

// After this many tracks in a row could not be got ready, the player stops instead of emptying the queue through a
// network outage or a site that refuses the server.
const FAILURES_BEFORE_STOP = 3;

// The track currently held by the player, with when it started for the history.
interface Current {
  readonly track: Track;
  readonly addedBy: string | null;
  /** When it first started playing; null while it is still loading for the first time. */
  startedAt: number | null;
}

export class Player {
  readonly guildId: string;
  private readonly options: PlayerOptions;
  private readonly seekCooldownMs: number;
  private readonly endGraceMs: number;

  private status: PlayerStatus = 'idle';
  private current: Current | null = null;
  private media: PreparedMedia | null = null;
  // The position at steady time `anchor` (the clock's steady(), never the date: a system clock set back an hour made
  // the place an hour before the start). While playing the position is offsetMs + (steady now - anchor); otherwise
  // offsetMs.
  private offsetMs = 0;
  private anchor = 0;
  // Bumped on every start of the outputs and every change of track; see the module comment.
  private session = 0;
  private version = 0;
  private error: string | null = null;
  // See PlayerSnapshot.notice: set by the player itself, cleared by any change a person makes.
  private notice: string | null = null;
  private repeat: RepeatMode = 'off';
  // What happens when the queue runs out; the autoplay module (app/autoplay.ts) reads it and does the work.
  private autoplay: AutoplayMode = 'off';
  // Download progress of the loading track, and the timer that sends it at most four times a second.
  private progress: number | null = null;
  // Whether the loading track's fetch waits for its place among every server's fetches (see load).
  private waiting = false;
  private progressTimer: TimerHandle | null = null;

  // Loading: the running fetch, its timeout, and how to start once it is done.
  private loadAbort: AbortController | null = null;
  private loadTimer: TimerHandle | null = null;
  private startAtMs = 0;
  private startPaused = false;
  // The tracks in a row that could not be got ready (see FAILURES_BEFORE_STOP), with who added them and whether a stop
  // should put them back (one already back in a looping queue, or gone from it for good, is not put back twice). A
  // person's action (play, skip, stop ...) starts the count again.
  private failedInRow: { track: Track; addedBy: string | null; putBack: boolean }[] = [];
  // The tracks of a looping queue that failed on their last pass and went back for one more (see failed): by track
  // id, how many tracks had got ready when it failed. Tracks got ready so far, counted for that: only those really
  // fetched from their site, not those found in the cache.
  private failedLastPass = new Map<number, number>();
  private readyCount = 0;
  // Restarts of outputs that ended early, counted per session (see outputEnded).
  private earlySession = -1;
  private earlyRestarts = 0;
  // Whether the player stops when the current track ends by itself (see setStopAfter). Any end of the current track
  // clears it (finishCurrent): the end it was waiting for, a skip, a jump, a stop.
  private stopAfter = false;

  // Playing: the timer that ends the track if no output reports the end.
  private endTimer: TimerHandle | null = null;

  // Seeking: when the last seek ran, and the target waiting for the cooldown to pass.
  private lastSeekAt = Number.NEGATIVE_INFINITY;
  private pendingSeekMs: number | null = null;
  private seekTimer: TimerHandle | null = null;

  // Outputs and the session each was last started with. An output whose session is older than the player's
  // (attached while paused, or paused through a seek) is started afresh on resume instead of resumed.
  private readonly outputs = new Map<PlayerOutput, number>();

  // Grows by one at the end of every play of a track: a skip, a stop, the end, a failure, and the same track starting
  // again by repeat. What belongs to one play (the votes to skip it, src/app/votes.ts) ends when it changes.
  private plays = 0;

  constructor(options: PlayerOptions) {
    this.options = options;
    this.guildId = options.guildId;
    this.seekCooldownMs = options.seekCooldownMs ?? 400;
    this.endGraceMs = options.endGraceMs ?? 5000;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Reading (no turn needed: between two changes what the player holds is whole)

  /** Where the current track is now, in milliseconds. */
  position(): number {
    if (this.status !== 'playing') return this.offsetMs;
    const elapsed = this.options.clock.steady() - this.anchor;
    // Never past the end: between the end and the moment the next track starts, the bar stays full.
    const end = this.media?.durationMs ?? Number.POSITIVE_INFINITY;
    return Math.min(this.offsetMs + elapsed, end);
  }

  /** Which play of a track is current: a number that changes whenever one ends (see `plays`). */
  playNumber(): number {
    return this.plays;
  }

  /** The state as clients see it. */
  snapshot(): PlayerSnapshot {
    return {
      guildId: this.guildId,
      status: this.status,
      track: this.current?.track ?? null,
      addedBy: this.current?.addedBy ?? null,
      positionMs: Math.round(this.position()),
      at: this.options.clock.now(),
      durationMs: this.media?.durationMs ?? this.current?.track.durationMs ?? null,
      error: this.error,
      repeat: this.repeat,
      progress: this.status === 'loading' ? this.progress : null,
      version: this.version,
      notice: this.notice,
      waiting: this.status === 'loading' && this.waiting,
      stopAfter: this.stopAfter,
      autoplay: this.autoplay,
    };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Commands (each returns whether it changed anything, so the API can say "nothing was playing"). Each takes the
  // server's turn; an action holding it already goes on in it.

  /** Starts the next track if nothing is current; called after tracks are added. */
  play(): Promise<boolean> {
    return this.turn(async () => {
      if (this.status !== 'idle') return false;
      // Nothing queued: nothing starts, and no snapshot is sent for a change that did not happen.
      if ((await this.options.queue.size(this.guildId)) === 0) return false;
      const next = await this.takeNext(false);
      this.failedInRow = [];
      this.notice = null;
      return this.moveTo(next, false);
    });
  }

  /** Moves to the next track; the current one goes into the history if it played long enough. */
  skip(): Promise<boolean> {
    return this.turn(async () => {
      if (this.status === 'idle') return false;
      // With the queue on repeat, a skipped track stays in the loop: it goes back to the end like a finished one.
      const current = this.current;
      if (this.repeat === 'queue' && current)
        await this.options.queue.add(this.guildId, [current.track.id], 'end', current.addedBy);
      const next = await this.takeNext(true);
      this.failedInRow = [];
      this.notice = null;
      return this.moveTo(next, false);
    });
  }

  /** Drops the current track without recording it (the "this was a mistake" button) and moves on. */
  removeCurrent(): Promise<boolean> {
    return this.turn(async () => {
      if (this.status === 'idle') return false;
      const next = await this.takeNext(false);
      this.failedInRow = [];
      this.notice = null;
      return this.moveTo(next, false);
    });
  }

  /** Stops playing; the queue stays as it is. */
  stop(): Promise<boolean> {
    return this.turn(async () => {
      if (this.status === 'idle') return false;
      // Its play goes into the history first; then the player lets it go and goes idle, in one step.
      await this.record();
      this.failedInRow = [];
      this.notice = null;
      this.finishCurrent();
      await this.goIdle();
      return true;
    });
  }

  /** Pauses. While loading, the track will start paused when it is ready. */
  pause(): Promise<boolean> {
    return this.turn(() => this.pauseSaying(null));
  }

  /**
   * Pauses because nobody hears it anywhere (see app/rest.ts), and says so in the notice; a person plays on. Only a
   * player that plays or gets a track ready rests.
   */
  rest(): Promise<boolean> {
    return this.turn(() => this.pauseSaying('paused with nobody listening'));
  }

  /** Resumes after a pause (or cancels the "start paused" of a loading track). */
  resume(): Promise<boolean> {
    return this.turn(async () => {
      if (this.status === 'loading') {
        if (!this.startPaused) return false;
        this.startPaused = false;
        this.notice = null;
        await this.emit();
        return true;
      }
      if (this.status !== 'paused' || !this.media) return false;
      this.notice = null;
      this.status = 'playing';
      this.anchor = this.options.clock.steady();
      // Outputs started with this session pick up where they paused; any other output starts at the position now.
      for (const [output, session] of this.outputs) {
        if (session === this.session) output.resume();
        else this.startOutput(output);
      }
      this.scheduleEnd();
      await this.emit();
      return true;
    });
  }

  /**
   * Moves to a place in the current track.
   *
   * The first seek runs at once; seeks that follow within the cooldown are merged and only the last one runs when
   * the cooldown ends. Dragging the bar sends a seek per pixel, and each one restarts ffmpeg for the voice stream.
   */
  seek(targetMs: number): Promise<boolean> {
    return this.turn(async () => {
      if (this.status === 'idle') return false;
      this.notice = null;
      // On the steady clock: a seek after the system clock was set back an hour was otherwise held for that hour.
      const now = this.options.clock.steady();
      const wait = this.lastSeekAt + this.seekCooldownMs - now;
      if (wait <= 0) {
        await this.applySeek(targetMs);
        return true;
      }
      // Inside the cooldown: remember the newest target and run it when the cooldown is over.
      this.pendingSeekMs = targetMs;
      if (this.seekTimer === null) {
        const timer = this.options.clock.setTimeout(() => {
          void this.fromTimer(async () => {
            // Cancelled, or another timer set, while this one waited for its turn (the track ended): not its own.
            if (this.seekTimer !== timer) return;
            this.seekTimer = null;
            const pending = this.pendingSeekMs;
            this.pendingSeekMs = null;
            if (pending !== null && this.status !== 'idle') await this.applySeek(pending);
          });
        }, wait);
        this.seekTimer = timer;
      }
      return true;
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Outputs

  /** Adds an output (the bot joined a voice channel). It starts at once if a track is playing. */
  attach(output: PlayerOutput): Promise<void> {
    return this.turn(() => {
      if (this.outputs.has(output)) return;
      // Session -1 marks "never started", so a later resume starts it rather than resuming nothing.
      this.outputs.set(output, -1);
      if (this.status === 'playing') this.startOutput(output);
      // With an output the end timer waits a grace period for the output's own end; reschedule with that.
      if (this.status === 'playing') this.scheduleEnd();
    });
  }

  /**
   * Starts the outputs again where the track is now, because how they make their sound changed (the voice channel's
   * volume or preset, which an output takes when it starts). The place, the clock and the browsers stay as they are: no
   * snapshot is sent. Loading or idle, there is nothing to start again: an output takes the sound at its next start.
   */
  restartOutputs(): Promise<void> {
    return this.turn(() => {
      if (this.status === 'playing' && this.media) {
        // A new session: an "ended" from the stream replaced is not taken for the end of the track.
        this.session += 1;
        for (const output of this.outputs.keys()) this.startOutput(output);
        this.scheduleEnd();
      } else if (this.status === 'paused') {
        // Paused: the outputs start afresh on resume, with the new sound (their session is an older one then).
        this.session += 1;
        for (const output of this.outputs.keys()) output.stop();
      }
    });
  }

  /** Removes an output (the bot left the channel); the player keeps going for the browsers. */
  detach(output: PlayerOutput): Promise<void> {
    return this.turn(() => {
      if (!this.outputs.delete(output)) return;
      output.stop();
      // Without outputs the end timer is the only thing that ends the track; it should fire exactly at the end now.
      if (this.status === 'playing') this.scheduleEnd();
    });
  }

  /**
   * Called by an output when its stream finished. Only the current session counts, and only an end near the clock's
   * end ends the track: an output that stops earlier has failed (a file gone, an ffmpeg that died), and the track is
   * not over for the browsers. That output is started again where the clock is, twice at most per session; after that
   * the clock alone ends the track (the end timer), so a broken output can never make tracks fly by. The end of a
   * stream is an event of its own: it takes a turn of its own, and settles when that turn is over.
   */
  outputEnded(session: number, output?: PlayerOutput): Promise<void> {
    return this.fromTimer(async () => {
      if (session !== this.session || this.status !== 'playing') return;
      const duration = this.media?.durationMs ?? 0;
      const left = duration - this.position();
      if (duration > 0 && left > EARLY_END_MS) {
        if (this.earlySession !== session) {
          this.earlySession = session;
          this.earlyRestarts = 0;
        }
        this.options.log.warn('an output stopped before the end of the track', {
          guild: this.guildId,
          output: output?.name ?? 'unknown',
          leftMs: Math.round(left),
        });
        if (output && this.outputs.has(output) && this.earlyRestarts < 2) {
          this.earlyRestarts += 1;
          this.startOutput(output);
        }
        return;
      }
      this.options.log.debug('the output reported the end of the track', { guild: this.guildId, session });
      await this.ended();
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Saving and restoring

  /**
   * Sets what happens when a track ends by itself: 'off' moves on, 'track' plays the same track again, 'queue' puts
   * it back at the end of the queue (so the queue loops). Skipping always moves on, whatever the mode; with 'queue'
   * the skipped track goes back to the end too, so it stays in the loop.
   */
  setRepeat(mode: RepeatMode): Promise<boolean> {
    return this.turn(async () => {
      if (mode === this.repeat) return false;
      this.repeat = mode;
      this.notice = null;
      // The failures of an earlier loop do not count against a later one.
      this.failedLastPass.clear();
      await this.emit();
      return true;
    });
  }

  /**
   * Stops the player when the current track ends by itself, the queue left as it is (on), or plays on after it (off).
   * Only for a track that is current: another track (a skip, a jump, play now) or a stop clears it, so it never
   * stops a track nobody chose it for. Not kept across a restart, which comes back paused anyway.
   */
  setStopAfter(on: boolean): Promise<boolean> {
    return this.turn(async () => {
      if (on && this.status === 'idle') return false;
      if (on === this.stopAfter) return false;
      this.stopAfter = on;
      await this.emit();
      return true;
    });
  }

  /** Writes the current position, so a restart comes back here. Called on shutdown. */
  checkpoint(): Promise<void> {
    return this.turn(() => this.persist());
  }

  /**
   * Sets what happens when the queue runs out: nothing ('off'), or a track picked by autoplay ('history', 'related').
   * The player only keeps and tells the choice, like the repeat mode; app/autoplay.ts picks the tracks.
   */
  setAutoplay(mode: AutoplayMode): Promise<boolean> {
    return this.turn(async () => {
      if (mode === this.autoplay) return false;
      this.autoplay = mode;
      await this.emit();
      return true;
    });
  }

  /**
   * Brings back what this server was playing before a restart: the same track, paused at the saved place.
   *
   * Never comes back playing: sound starting by itself after an update or a reboot surprises people in the channel.
   */
  restore(track: Track | null, addedBy: string | null, positionMs: number): Promise<void> {
    return this.turn(async () => {
      if (!track) return;
      this.failedInRow = [];
      this.notice = null;
      this.current = { track, addedBy, startedAt: null };
      await this.load(positionMs, true);
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Internals

  // A change of this player, in the server's turn (see core/lanes.ts): a caller holding the turn goes on in it.
  private turn<T>(task: () => T | Promise<T>): Promise<T> {
    return this.options.lanes.run(this.guildId, task);
  }

  // What a timer or an output's end starts: a turn of its own, never the turn that set it up. A failure is thrown out
  // of the event loop, as it was when this work ran in the timer itself. Settles when the turn is over.
  private fromTimer(task: () => Promise<void> | void): Promise<void> {
    return this.options.lanes.later(this.guildId, task).catch(throwFromTimer);
  }

  // What a fetch's answer starts: a turn of its own. A failure is the fetch promise's, unhandled (logged, the music
  // goes on), as it was when this work ran in the fetch's then().
  private fromFetch(task: () => Promise<void> | void): void {
    void this.options.lanes.later(this.guildId, task);
  }

  // Pauses (a loading track starts paused when it is ready) with this notice: none for a person's pause, which clears
  // what the player said before, or what the player says about pausing by itself.
  private async pauseSaying(notice: string | null): Promise<boolean> {
    if (this.status === 'loading') {
      if (this.startPaused) return false;
      this.startPaused = true;
      this.notice = notice;
      await this.emit();
      return true;
    }
    if (this.status !== 'playing') return false;
    this.notice = notice;
    // Freeze the position first, then stop the clock-driven timer and the sound.
    this.offsetMs = this.position();
    this.status = 'paused';
    this.cancelEndTimer();
    for (const output of this.outputs.keys()) output.pause();
    await this.emit();
    return true;
  }

  // The database work of moving on, done before anything changes in memory: the current track into the history when
  // it counts as played (`record`), and the next item out of the queue (null when there is none).
  private async takeNext(record: boolean): Promise<QueueItem | null> {
    if (record) await this.record();
    return this.options.queue.shift(this.guildId);
  }

  // Finishes the current track and starts `next` (held paused if `paused`), or goes idle when there is none.
  private async moveTo(next: QueueItem | null, paused: boolean): Promise<boolean> {
    this.finishCurrent();
    if (!next) {
      await this.goIdle();
      return true;
    }
    this.current = { track: next.track, addedBy: next.addedBy, startedAt: null };
    await this.load(0, paused);
    return true;
  }

  // A track ended by itself: the repeat mode decides what comes next, unless the player was asked to stop after it.
  private async ended(): Promise<void> {
    const current = this.current;
    if (this.stopAfter) {
      // It played to its end and goes into the history; a looping queue keeps it at its end, as after any track.
      if (this.repeat === 'queue' && current)
        await this.options.queue.add(this.guildId, [current.track.id], 'end', current.addedBy);
      await this.record();
      this.finishCurrent();
      await this.goIdle();
      return;
    }
    if (this.repeat === 'track' && current && this.media) {
      // The same track again from the top: it is still prepared, so nothing is fetched. It is a new play.
      await this.record();
      this.plays += 1;
      current.startedAt = this.options.clock.now();
      this.offsetMs = 0;
      this.anchor = this.options.clock.steady();
      this.session += 1;
      for (const output of this.outputs.keys()) this.startOutput(output);
      this.scheduleEnd();
      await this.emit();
      return;
    }
    // The queue loops: the finished track goes back to the end, added by the same person.
    if (this.repeat === 'queue' && current)
      await this.options.queue.add(this.guildId, [current.track.id], 'end', current.addedBy);
    await this.moveTo(await this.takeNext(true), false);
  }

  // Writes the current track into the history if it was listened to (see MIN_HISTORY_MS).
  private async record(): Promise<void> {
    const current = this.current;
    if (!current || current.startedAt === null) return;
    const playedMs = Math.round(this.position());
    if (playedMs < MIN_HISTORY_MS) return;
    await this.options.history.add({
      guildId: this.guildId,
      trackId: current.track.id,
      addedBy: current.addedBy,
      playedAt: current.startedAt,
      playedMs,
    });
  }

  // Ends the current track: stops loading or sound and cancels timers. Its play went into the history before, by
  // whoever ends it, when it counts as played (record).
  private finishCurrent(): void {
    const current = this.current;
    // The play of the current track (if any) is over.
    this.plays += 1;
    this.cancelLoad();
    this.cancelEndTimer();
    this.cancelSeek();
    // A new session makes any late "ended" from the old stream harmless.
    this.session += 1;
    // Asked of the track that ends here; the next one plays on unless asked again.
    this.stopAfter = false;
    // Only a track that was current has a stream to stop; an idle output is left alone.
    if (current) for (const output of this.outputs.keys()) output.stop();
    this.current = null;
    this.media = null;
    this.offsetMs = 0;
  }

  // Nothing to play: the outputs are already stopped by finishCurrent.
  private async goIdle(): Promise<void> {
    this.status = 'idle';
    this.startPaused = false;
    await this.emit();
  }

  // Fetches the current track and starts it at `startAtMs`, paused if `paused`.
  private async load(startAtMs: number, paused: boolean): Promise<void> {
    const current = this.current;
    if (!current) return;
    this.cancelLoad();
    this.status = 'loading';
    this.startAtMs = startAtMs;
    this.startPaused = paused;
    this.media = null;
    this.offsetMs = startAtMs;
    this.progress = null;
    this.waiting = false;
    const session = ++this.session;
    const controller = new AbortController();
    this.loadAbort = controller;
    // Give up on a fetch that takes too long: a stuck download must not block the queue. A long track takes longer to
    // download and encode, so it gets a tenth of its length on top (three hours: 18 more minutes).
    const limitMs = fetchLimitMs(this.options.fetchTimeoutMs, current.track.durationMs);
    const giveUpLater = (): void => {
      if (this.loadTimer !== null) this.options.clock.clearTimeout(this.loadTimer);
      const timer = this.options.clock.setTimeout(() => {
        void this.fromTimer(async () => {
          // Cancelled or put off while this waited for its turn (the track got ready, the fetch waits for its place
          // again): not this timer's to act on.
          if (this.loadTimer !== timer) return;
          this.loadTimer = null;
          controller.abort();
          await this.failed(current.track, 'getting it took too long');
        });
      }, limitMs);
      this.loadTimer = timer;
    };
    giveUpLater();
    // The time a fetch waits for its place among the fetches of every server (other servers fetching long tracks on a
    // small machine) is not its own: the limit counts from when it starts. Without that, a server whose turn had not
    // come failed three tracks in a row as too slow, and stopped, before any of them was fetched.
    // People see that it waits for its turn ("Getting it ready" with no progress said nothing about why).
    // Whether a waiting to say came while prepare() itself ran (a fetch that waits from the start): that is part of
    // this change, told once prepare() returns, as its own snapshot after the one of the loading.
    let preparing = true;
    let saidWhilePreparing = false;
    // Takes in a waiting (or its end) and says whether the snapshot changed with it.
    const takeWaiting = (waiting: boolean): boolean => {
      if (!waiting) {
        giveUpLater();
      } else if (this.loadTimer !== null) {
        this.options.clock.clearTimeout(this.loadTimer);
        this.loadTimer = null;
      }
      if (this.waiting === waiting) return false;
      this.waiting = waiting;
      return true;
    };
    const onWaiting = (waiting: boolean): void => {
      if (preparing) {
        if (takeWaiting(waiting)) saidWhilePreparing = true;
        return;
      }
      // Said later (its place came): a turn of its own, for this load if it is still the current one.
      this.fromFetch(async () => {
        if (session !== this.session || this.status !== 'loading') return;
        if (takeWaiting(waiting)) await this.emit();
      });
    };
    await this.emit();
    // Progress is shown while loading; a burst of reports is sent at most four times a second. A report changes one
    // number and nothing else, so it is taken in at once, outside any turn, for the load it is for.
    const onProgress = (fraction: number): void => {
      if (session !== this.session || this.status !== 'loading') return;
      this.progress = Math.max(0, Math.min(1, fraction));
      if (this.progressTimer !== null) return;
      this.progressTimer = this.options.clock.setTimeout(() => {
        this.progressTimer = null;
        void this.fromTimer(async () => {
          if (session === this.session && this.status === 'loading') await this.emit();
        });
      }, 250);
    };
    const fetching = this.options.media.prepare(current.track, controller.signal, onProgress, 'now', onWaiting);
    preparing = false;
    fetching.then(
      (media) => {
        this.fromFetch(async () => {
          // Skipped, stopped or timed out meanwhile: this result belongs to a load that no longer matters.
          if (session !== this.session || controller.signal.aborted) return;
          await this.ready(media);
        });
      },
      (error: unknown) => {
        this.fromFetch(async () => {
          if (session !== this.session || controller.signal.aborted) return;
          await this.failed(current.track, error instanceof Error ? error.message : String(error));
        });
      },
    );
    if (saidWhilePreparing) await this.emit();
  }

  /**
   * A track of this server was fetched from its site ahead of its turn (the prefetcher): the site works, as when the
   * player fetches one itself. The prefetched track reaches the player from the cache later, which shows nothing; not
   * counted, a looping queue's track that failed on its own was fetched again on every pass, never taken out. A count
   * and nothing else: taken in at once, outside any turn.
   */
  fetchedAhead(): void {
    this.readyCount += 1;
  }

  // The current track is ready: start it (or hold it paused) at the place asked for.
  private async ready(media: PreparedMedia): Promise<void> {
    this.cancelLoad();
    this.media = media;
    // A track got ready: the count of failures in a row starts again, and a failure of this one on an earlier pass of
    // a looping queue is forgotten.
    this.failedInRow = [];
    // Only a track fetched from its site just now shows that the site works; one from the cache shows nothing about
    // it. Counted as proof, a cached track let a track that failed during a YouTube bot check, or an outage, leave the
    // loop after two passes, as if the site worked and that track did not.
    if (!media.fromCache) this.readyCount += 1;
    if (this.current) this.failedLastPass.delete(this.current.track.id);
    // A restored position past the end of the file (the file changed) starts from the top instead.
    this.offsetMs = this.startAtMs < media.durationMs ? this.startAtMs : 0;
    this.error = null;
    if (this.current && this.current.startedAt === null) this.current.startedAt = this.options.clock.now();
    if (this.startPaused) {
      // Held paused: outputs are started on resume (their session stays older than the player's).
      this.status = 'paused';
      this.startPaused = false;
      await this.emit();
      return;
    }
    this.status = 'playing';
    this.anchor = this.options.clock.steady();
    this.session += 1;
    for (const output of this.outputs.keys()) this.startOutput(output);
    this.scheduleEnd();
    await this.emit();
  }

  // A track could not be got ready: say why and move on (the failed track is not recorded as played). A track that
  // was to start paused (after a restart, or paused while loading) passes that on to the next one. Several failures
  // in a row stop the player and leave the queue as it is: the cause is then the network or the site, not the track.
  // The queue is changed first; what people see (the reason, a notice) changes with the move to the next track.
  private async failed(track: Track, reason: string): Promise<void> {
    this.options.log.warn('skipping a track that could not be got ready', {
      guild: this.guildId,
      track: track.url,
      reason,
    });
    // People see the title and a short reason (core/reasons.ts); the full text is in the line logged above.
    const error = `${track.title}: ${plainReason(reason)}`;
    let notice: string | null = null;
    const addedBy = this.current?.addedBy ?? null;
    // A looping queue keeps a track that failed once (a network blip, a site's bad minute): it goes back to the end,
    // as a finished one would. A failure that will not change (removed, private, not playable) takes it out of the
    // loop for good, and so does a second failure of the same track on its next pass while other tracks got ready
    // meanwhile: the site works, but not for this one, and it would otherwise be fetched again on every pass for as
    // long as the loop runs. When nothing got ready in between, the trouble is the network or the site, which the
    // count of failures in a row below is for. Either way a stop below has nothing more to put back for it.
    const looping = this.repeat === 'queue';
    if (looping) {
      const permanent = permanentFailure(reason);
      const before = this.failedLastPass.get(track.id);
      // The tracks got ready so far, read once: a prefetch that gets one ready while the queue is written counts
      // after this failure, not halfway through it.
      const ready = this.readyCount;
      if (!permanent && (before === undefined || before === ready)) {
        await this.options.queue.add(this.guildId, [track.id], 'end', addedBy);
        this.failedLastPass.set(track.id, ready);
      } else {
        this.failedLastPass.delete(track.id);
        this.options.log.info('took a track out of the looping queue', {
          guild: this.guildId,
          track: track.url,
          why: permanent ? 'it will not work' : 'it failed on two passes in a row',
        });
        // Said to people too, and kept past the next track (which clears the failure itself): a track leaving a loop
        // is otherwise seen by nobody. And to the server's alerts channel, when it has one.
        notice = `${track.title}: taken out of the looping queue`;
        this.options.onLeftLoop?.(this.guildId, track, reason);
      }
    }
    this.failedInRow.push({ track, addedBy, putBack: !looping });
    // Three in a row, or a queue that ran out on failures (one or two tracks during an outage), stops the player
    // instead of moving on: moving on would leave an empty queue and lose the tracks that failed.
    const ranOut = (await this.options.queue.size(this.guildId)) === 0;
    if (this.failedInRow.length >= FAILURES_BEFORE_STOP || ranOut) {
      this.options.log.warn('stopped after tracks in a row could not be got ready', {
        guild: this.guildId,
        failures: this.failedInRow.length,
      });
      // The cause is the network or the site, not these tracks: they go back to the front of the queue, in their
      // order, for when it works again.
      const failed = this.failedInRow.filter((entry) => entry.putBack);
      this.failedInRow = [];
      this.failedLastPass.clear();
      for (const entry of [...failed].reverse())
        await this.options.queue.add(this.guildId, [entry.track.id], 'next', entry.addedBy);
      this.error = error;
      if (notice !== null) this.notice = notice;
      this.finishCurrent();
      await this.goIdle();
      return;
    }
    const next = await this.takeNext(false);
    this.error = error;
    if (notice !== null) this.notice = notice;
    await this.moveTo(next, this.startPaused);
  }

  // Runs a seek: restarts the sound at the new place while playing, or just moves the place otherwise.
  private async applySeek(targetMs: number): Promise<void> {
    this.lastSeekAt = this.options.clock.steady();
    const duration = this.media?.durationMs ?? this.current?.track.durationMs ?? null;
    // Keep the target inside the track (see SEEK_END_MARGIN_MS).
    const max = duration === null ? Number.POSITIVE_INFINITY : Math.max(0, duration - SEEK_END_MARGIN_MS);
    const target = Math.min(Math.max(0, Math.round(targetMs)), max);
    if (this.status === 'loading') {
      // Not ready yet: start there when it is.
      this.startAtMs = target;
      this.offsetMs = target;
    } else if (this.status === 'paused') {
      // Paused: move the place; the outputs restart there on resume because the session changes now.
      this.offsetMs = target;
      this.session += 1;
      for (const output of this.outputs.keys()) output.stop();
    } else if (this.status === 'playing' && this.media) {
      this.offsetMs = target;
      this.anchor = this.options.clock.steady();
      this.session += 1;
      for (const output of this.outputs.keys()) this.startOutput(output);
      this.scheduleEnd();
    }
    await this.emit();
  }

  // Starts one output at the current position with the current session.
  private startOutput(output: PlayerOutput): void {
    if (!this.media) return;
    this.outputs.set(output, this.session);
    output.start(this.media, this.position(), this.session);
  }

  // Ends the track by the clock if nothing else does: at the end exactly without outputs (the browsers follow the
  // clock), or a grace period later with outputs, whose own end report is more accurate.
  private scheduleEnd(): void {
    this.cancelEndTimer();
    if (!this.media) return;
    const remaining = Math.max(0, this.media.durationMs - this.position());
    const grace = this.outputs.size > 0 ? this.endGraceMs : 0;
    const session = this.session;
    const timer = this.options.clock.setTimeout(() => {
      void this.fromTimer(async () => {
        // Cancelled or set again while this waited for its turn (a pause, a seek, another track): not its own.
        if (this.endTimer !== timer) return;
        this.endTimer = null;
        if (session !== this.session || this.status !== 'playing') return;
        if (this.outputs.size > 0) {
          this.options.log.warn('no output reported the end of the track; moving on by the clock', {
            guild: this.guildId,
          });
        }
        await this.ended();
      });
    }, remaining + grace);
    this.endTimer = timer;
  }

  private cancelEndTimer(): void {
    if (this.endTimer !== null) this.options.clock.clearTimeout(this.endTimer);
    this.endTimer = null;
  }

  private cancelLoad(): void {
    if (this.loadTimer !== null) this.options.clock.clearTimeout(this.loadTimer);
    this.loadTimer = null;
    this.loadAbort?.abort();
    this.loadAbort = null;
    if (this.progressTimer !== null) this.options.clock.clearTimeout(this.progressTimer);
    this.progressTimer = null;
    this.progress = null;
  }

  private cancelSeek(): void {
    if (this.seekTimer !== null) this.options.clock.clearTimeout(this.seekTimer);
    this.seekTimer = null;
    this.pendingSeekMs = null;
  }

  // Saves the state for a restart (see restore): the track, whether it played, and where.
  private persist(): Promise<void> {
    return this.options.state.save({
      guildId: this.guildId,
      trackId: this.current?.track.id ?? null,
      addedBy: this.current?.addedBy ?? null,
      // A loading track is saved as paused: it was meant to play, and restore always brings it back paused anyway.
      status: this.status === 'idle' ? 'idle' : this.status === 'playing' ? 'playing' : 'paused',
      positionMs: this.position(),
      repeat: this.repeat,
      autoplay: this.autoplay,
    });
  }

  // Every change ends here: one version step, one save, one event.
  private async emit(): Promise<void> {
    this.version += 1;
    await this.persist();
    this.options.bus.emit('player', this.snapshot());
  }
}
