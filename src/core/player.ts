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
 */
import type { Logger } from '../log.ts';
import type { HistoryRepository, PlayerStateRepository, RepeatMode } from '../store/store.ts';
import type { Bus } from './bus.ts';
import type { Clock, TimerHandle } from './clock.ts';
import type { QueueService } from './queue.ts';
import { permanentFailure, plainReason } from './reasons.ts';
import type { Track } from './types.ts';

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

  // Playing: the timer that ends the track if no output reports the end.
  private endTimer: TimerHandle | null = null;

  // Seeking: when the last seek ran, and the target waiting for the cooldown to pass.
  private lastSeekAt = Number.NEGATIVE_INFINITY;
  private pendingSeekMs: number | null = null;
  private seekTimer: TimerHandle | null = null;

  // Outputs and the session each was last started with. An output whose session is older than the player's
  // (attached while paused, or paused through a seek) is started afresh on resume instead of resumed.
  private readonly outputs = new Map<PlayerOutput, number>();

  constructor(options: PlayerOptions) {
    this.options = options;
    this.guildId = options.guildId;
    this.seekCooldownMs = options.seekCooldownMs ?? 400;
    this.endGraceMs = options.endGraceMs ?? 5000;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Reading

  /** Where the current track is now, in milliseconds. */
  position(): number {
    if (this.status !== 'playing') return this.offsetMs;
    const elapsed = this.options.clock.steady() - this.anchor;
    // Never past the end: between the end and the moment the next track starts, the bar stays full.
    const end = this.media?.durationMs ?? Number.POSITIVE_INFINITY;
    return Math.min(this.offsetMs + elapsed, end);
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
    };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Commands (each returns whether it changed anything, so the API can say "nothing was playing")

  /** Starts the next track if nothing is current; called after tracks are added. */
  play(): boolean {
    if (this.status !== 'idle') return false;
    // Nothing queued: nothing starts, and no snapshot is sent for a change that did not happen.
    if (this.options.queue.size(this.guildId) === 0) return false;
    this.failedInRow = [];
    this.notice = null;
    return this.advance(false);
  }

  /** Moves to the next track; the current one goes into the history if it played long enough. */
  skip(): boolean {
    if (this.status === 'idle') return false;
    this.failedInRow = [];
    this.notice = null;
    // With the queue on repeat, a skipped track stays in the loop: it goes back to the end like a finished one.
    const current = this.current;
    if (this.repeat === 'queue' && current)
      this.options.queue.add(this.guildId, [current.track.id], 'end', current.addedBy);
    return this.advance(true);
  }

  /** Drops the current track without recording it (the "this was a mistake" button) and moves on. */
  removeCurrent(): boolean {
    if (this.status === 'idle') return false;
    this.failedInRow = [];
    this.notice = null;
    return this.advance(false);
  }

  /** Stops playing; the queue stays as it is. */
  stop(): boolean {
    if (this.status === 'idle') return false;
    this.failedInRow = [];
    this.notice = null;
    this.finishCurrent(true);
    this.goIdle();
    return true;
  }

  /** Pauses. While loading, the track will start paused when it is ready. */
  pause(): boolean {
    return this.pauseSaying(null);
  }

  /**
   * Pauses because nobody hears it anywhere (see app/rest.ts), and says so in the notice; a person plays on. Only a
   * player that plays or gets a track ready rests.
   */
  rest(): boolean {
    return this.pauseSaying('paused with nobody listening');
  }

  /** Resumes after a pause (or cancels the "start paused" of a loading track). */
  resume(): boolean {
    if (this.status === 'loading') {
      if (!this.startPaused) return false;
      this.startPaused = false;
      this.notice = null;
      this.emit();
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
    this.emit();
    return true;
  }

  /**
   * Moves to a place in the current track.
   *
   * The first seek runs at once; seeks that follow within the cooldown are merged and only the last one runs when
   * the cooldown ends. Dragging the bar sends a seek per pixel, and each one restarts ffmpeg for the voice stream.
   */
  seek(targetMs: number): boolean {
    if (this.status === 'idle') return false;
    this.notice = null;
    // On the steady clock: a seek after the system clock was set back an hour was otherwise held for that hour.
    const now = this.options.clock.steady();
    const wait = this.lastSeekAt + this.seekCooldownMs - now;
    if (wait <= 0) {
      this.applySeek(targetMs);
      return true;
    }
    // Inside the cooldown: remember the newest target and run it when the cooldown is over.
    this.pendingSeekMs = targetMs;
    if (this.seekTimer === null) {
      this.seekTimer = this.options.clock.setTimeout(() => {
        this.seekTimer = null;
        const pending = this.pendingSeekMs;
        this.pendingSeekMs = null;
        if (pending !== null && this.status !== 'idle') this.applySeek(pending);
      }, wait);
    }
    return true;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Outputs

  /** Adds an output (the bot joined a voice channel). It starts at once if a track is playing. */
  attach(output: PlayerOutput): void {
    if (this.outputs.has(output)) return;
    // Session -1 marks "never started", so a later resume starts it rather than resuming nothing.
    this.outputs.set(output, -1);
    if (this.status === 'playing') this.startOutput(output);
    // With an output the end timer waits a grace period for the output's own end; reschedule with that.
    if (this.status === 'playing') this.scheduleEnd();
  }

  /** Removes an output (the bot left the channel); the player keeps going for the browsers. */
  detach(output: PlayerOutput): void {
    if (!this.outputs.delete(output)) return;
    output.stop();
    // Without outputs the end timer is the only thing that ends the track; it should fire exactly at the end now.
    if (this.status === 'playing') this.scheduleEnd();
  }

  /**
   * Called by an output when its stream finished. Only the current session counts, and only an end near the clock's
   * end ends the track: an output that stops earlier has failed (a file gone, an ffmpeg that died), and the track is
   * not over for the browsers. That output is started again where the clock is, twice at most per session; after that
   * the clock alone ends the track (the end timer), so a broken output can never make tracks fly by.
   */
  outputEnded(session: number, output?: PlayerOutput): void {
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
    this.ended();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Saving and restoring

  /**
   * Sets what happens when a track ends by itself: 'off' moves on, 'track' plays the same track again, 'queue' puts
   * it back at the end of the queue (so the queue loops). Skipping always moves on, whatever the mode; with 'queue'
   * the skipped track goes back to the end too, so it stays in the loop.
   */
  setRepeat(mode: RepeatMode): boolean {
    if (mode === this.repeat) return false;
    this.repeat = mode;
    this.notice = null;
    // The failures of an earlier loop do not count against a later one.
    this.failedLastPass.clear();
    this.emit();
    return true;
  }

  /** Writes the current position, so a restart comes back here. Called on shutdown. */
  checkpoint(): void {
    this.persist();
  }

  /**
   * Brings back what this server was playing before a restart: the same track, paused at the saved place.
   *
   * Never comes back playing: sound starting by itself after an update or a reboot surprises people in the channel.
   */
  restore(track: Track | null, addedBy: string | null, positionMs: number): void {
    if (!track) return;
    this.failedInRow = [];
    this.notice = null;
    this.current = { track, addedBy, startedAt: null };
    this.load(positionMs, true);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Internals

  // Pauses (a loading track starts paused when it is ready) with this notice: none for a person's pause, which clears
  // what the player said before, or what the player says about pausing by itself.
  private pauseSaying(notice: string | null): boolean {
    if (this.status === 'loading') {
      if (this.startPaused) return false;
      this.startPaused = true;
      this.notice = notice;
      this.emit();
      return true;
    }
    if (this.status !== 'playing') return false;
    this.notice = notice;
    // Freeze the position first, then stop the clock-driven timer and the sound.
    this.offsetMs = this.position();
    this.status = 'paused';
    this.cancelEndTimer();
    for (const output of this.outputs.keys()) output.pause();
    this.emit();
    return true;
  }

  // Finishes the current track and starts the next one in the queue (held paused if `paused`), or goes idle when
  // there is none.
  private advance(record: boolean, paused = false): boolean {
    this.finishCurrent(record);
    const next = this.options.queue.shift(this.guildId);
    if (!next) {
      this.goIdle();
      return true;
    }
    this.current = { track: next.track, addedBy: next.addedBy, startedAt: null };
    this.load(0, paused);
    return true;
  }

  // A track ended by itself: the repeat mode decides what comes next.
  private ended(): void {
    const current = this.current;
    if (this.repeat === 'track' && current && this.media) {
      // The same track again from the top: it is still prepared, so nothing is fetched.
      this.record();
      current.startedAt = this.options.clock.now();
      this.offsetMs = 0;
      this.anchor = this.options.clock.steady();
      this.session += 1;
      for (const output of this.outputs.keys()) this.startOutput(output);
      this.scheduleEnd();
      this.emit();
      return;
    }
    // The queue loops: the finished track goes back to the end, added by the same person.
    if (this.repeat === 'queue' && current)
      this.options.queue.add(this.guildId, [current.track.id], 'end', current.addedBy);
    this.advance(true);
  }

  // Writes the current track into the history if it was listened to (see MIN_HISTORY_MS).
  private record(): void {
    const current = this.current;
    if (!current || current.startedAt === null) return;
    const playedMs = Math.round(this.position());
    if (playedMs < MIN_HISTORY_MS) return;
    this.options.history.add({
      guildId: this.guildId,
      trackId: current.track.id,
      addedBy: current.addedBy,
      playedAt: current.startedAt,
      playedMs,
    });
  }

  // Ends the current track: stops loading or sound, cancels timers, and records it if it was listened to.
  private finishCurrent(record: boolean): void {
    const current = this.current;
    if (record) this.record();
    this.cancelLoad();
    this.cancelEndTimer();
    this.cancelSeek();
    // A new session makes any late "ended" from the old stream harmless.
    this.session += 1;
    // Only a track that was current has a stream to stop; an idle output is left alone.
    if (current) for (const output of this.outputs.keys()) output.stop();
    this.current = null;
    this.media = null;
    this.offsetMs = 0;
  }

  // Nothing to play: the outputs are already stopped by finishCurrent.
  private goIdle(): void {
    this.status = 'idle';
    this.startPaused = false;
    this.emit();
  }

  // Fetches the current track and starts it at `startAtMs`, paused if `paused`.
  private load(startAtMs: number, paused: boolean): void {
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
      this.loadTimer = this.options.clock.setTimeout(() => {
        this.loadTimer = null;
        controller.abort();
        this.failed(current.track, 'getting it took too long');
      }, limitMs);
    };
    giveUpLater();
    // The time a fetch waits for its place among the fetches of every server (other servers fetching long tracks on a
    // small machine) is not its own: the limit counts from when it starts. Without that, a server whose turn had not
    // come failed three tracks in a row as too slow, and stopped, before any of them was fetched.
    // People see that it waits for its turn ("Getting it ready" with no progress said nothing about why).
    const onWaiting = (waiting: boolean): void => {
      if (session !== this.session || this.status !== 'loading') return;
      if (!waiting) {
        giveUpLater();
      } else if (this.loadTimer !== null) {
        this.options.clock.clearTimeout(this.loadTimer);
        this.loadTimer = null;
      }
      if (this.waiting === waiting) return;
      this.waiting = waiting;
      this.emit();
    };
    this.emit();
    // Progress is shown while loading; a burst of reports is sent at most four times a second.
    const onProgress = (fraction: number): void => {
      if (session !== this.session || this.status !== 'loading') return;
      this.progress = Math.max(0, Math.min(1, fraction));
      if (this.progressTimer !== null) return;
      this.progressTimer = this.options.clock.setTimeout(() => {
        this.progressTimer = null;
        if (session === this.session && this.status === 'loading') this.emit();
      }, 250);
    };
    this.options.media.prepare(current.track, controller.signal, onProgress, 'now', onWaiting).then(
      (media) => {
        // Skipped, stopped or timed out meanwhile: this result belongs to a load that no longer matters.
        if (session !== this.session || controller.signal.aborted) return;
        this.ready(media);
      },
      (error: unknown) => {
        if (session !== this.session || controller.signal.aborted) return;
        this.failed(current.track, error instanceof Error ? error.message : String(error));
      },
    );
  }

  /**
   * A track of this server was fetched from its site ahead of its turn (the prefetcher): the site works, as when the
   * player fetches one itself. The prefetched track reaches the player from the cache later, which shows nothing; not
   * counted, a looping queue's track that failed on its own was fetched again on every pass, never taken out.
   */
  fetchedAhead(): void {
    this.readyCount += 1;
  }

  // The current track is ready: start it (or hold it paused) at the place asked for.
  private ready(media: PreparedMedia): void {
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
      this.emit();
      return;
    }
    this.status = 'playing';
    this.anchor = this.options.clock.steady();
    this.session += 1;
    for (const output of this.outputs.keys()) this.startOutput(output);
    this.scheduleEnd();
    this.emit();
  }

  // A track could not be got ready: say why and move on (the failed track is not recorded as played). A track that
  // was to start paused (after a restart, or paused while loading) passes that on to the next one. Several failures
  // in a row stop the player and leave the queue as it is: the cause is then the network or the site, not the track.
  private failed(track: Track, reason: string): void {
    this.options.log.warn('skipping a track that could not be got ready', {
      guild: this.guildId,
      track: track.url,
      reason,
    });
    // People see the title and a short reason (core/reasons.ts); the full text is in the line logged above.
    this.error = `${track.title}: ${plainReason(reason)}`;
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
      if (!permanent && (before === undefined || before === this.readyCount)) {
        this.options.queue.add(this.guildId, [track.id], 'end', addedBy);
        this.failedLastPass.set(track.id, this.readyCount);
      } else {
        this.failedLastPass.delete(track.id);
        this.options.log.info('took a track out of the looping queue', {
          guild: this.guildId,
          track: track.url,
          why: permanent ? 'it will not work' : 'it failed on two passes in a row',
        });
        // Said to people too, and kept past the next track (which clears the failure itself): a track leaving a loop
        // is otherwise seen by nobody. And to the server's alerts channel, when it has one.
        this.notice = `${track.title}: taken out of the looping queue`;
        this.options.onLeftLoop?.(this.guildId, track, reason);
      }
    }
    this.failedInRow.push({ track, addedBy, putBack: !looping });
    // Three in a row, or a queue that ran out on failures (one or two tracks during an outage), stops the player
    // instead of moving on: moving on would leave an empty queue and lose the tracks that failed.
    const ranOut = this.options.queue.size(this.guildId) === 0;
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
        this.options.queue.add(this.guildId, [entry.track.id], 'next', entry.addedBy);
      this.finishCurrent(false);
      this.goIdle();
      return;
    }
    this.advance(false, this.startPaused);
  }

  // Runs a seek: restarts the sound at the new place while playing, or just moves the place otherwise.
  private applySeek(targetMs: number): void {
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
    this.emit();
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
    this.endTimer = this.options.clock.setTimeout(() => {
      this.endTimer = null;
      if (session !== this.session || this.status !== 'playing') return;
      if (this.outputs.size > 0) {
        this.options.log.warn('no output reported the end of the track; moving on by the clock', {
          guild: this.guildId,
        });
      }
      this.ended();
    }, remaining + grace);
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
  private persist(): void {
    this.options.state.save({
      guildId: this.guildId,
      trackId: this.current?.track.id ?? null,
      addedBy: this.current?.addedBy ?? null,
      // A loading track is saved as paused: it was meant to play, and restore always brings it back paused anyway.
      status: this.status === 'idle' ? 'idle' : this.status === 'playing' ? 'playing' : 'paused',
      positionMs: this.position(),
      repeat: this.repeat,
    });
  }

  // Every change ends here: one version step, one event, one save.
  private emit(): void {
    this.version += 1;
    this.persist();
    this.options.bus.emit('player', this.snapshot());
  }
}
