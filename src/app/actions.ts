/**
 * Everything a person can do with jukecord, in one place.
 *
 * The panel, the slash commands, the HTTP API and the CLI are four ways in; each of them only reads its input, calls
 * one of these actions, and shows the result. That is what keeps them in step: a feature exists when it is an action,
 * and a test checks that every action is reachable from all four (see ACTIONS and tests/unit/parity.test.ts).
 */
import type { PlayerSnapshot } from '../core/player.ts';
import type { Players } from '../core/players.ts';
import type { InsertAt, QueueService } from '../core/queue.ts';
import type { HistoryEntry, Playlist, QueueItem, Track } from '../core/types.ts';
import type { Logger } from '../log.ts';
import type { Resolver } from '../media/resolver.ts';
import type { RepeatMode, Store } from '../store/store.ts';
import { StoreError } from '../store/store.ts';
import { VERSION } from '../version.ts';

/**
 * Every action by name. The four ways in each declare which of these they offer; the parity test fails when one is
 * missing somewhere, so a new feature cannot land in the panel alone.
 */
export const ACTIONS = [
  'add',
  'play-now',
  'skip',
  'remove-current',
  'pause',
  'resume',
  'seek',
  'repeat',
  'stop',
  'now-playing',
  'queue',
  'remove',
  'move',
  'shuffle',
  'dedupe',
  'clear',
  'history',
  'playlists',
  'playlist-save',
  'playlist-load',
  'playlist-rename',
  'playlist-delete',
  'join',
  'leave',
  'status',
] as const;

export type ActionName = (typeof ACTIONS)[number];

/** Who is acting and in which server. Built by each way in from its own login (Discord member, panel session, token). */
export interface ActionContext {
  readonly guildId: string;
  /** The Discord user ID, or null for the CLI on the host and a panel without a Discord login. */
  readonly userId: string | null;
  /** Whether this person may change the queue (the server's DJ role, when one is set, decides). */
  readonly mayControl: boolean;
}

/** Why an action could not be done; the ways in turn the code into an HTTP status, an ephemeral reply or an exit code. */
export type ActionErrorCode = 'invalid' | 'not-found' | 'forbidden' | 'conflict' | 'unavailable';

export class ActionError extends Error {
  override name = 'ActionError';
  readonly code: ActionErrorCode;

  constructor(code: ActionErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Joining and leaving voice, which only the Discord side can do; absent when jukecord runs without a bot token. */
export interface VoiceControl {
  /** Joins a voice channel of the server (the caller's own channel when `channelId` is null). */
  join(guildId: string, channelId: string | null, userId: string | null): Promise<{ channelId: string; name: string }>;
  /** Leaves the server's voice channel; false when it was not in one. */
  leave(guildId: string): boolean;
  /** The voice channel the bot is in, or null. */
  channel(guildId: string): { channelId: string; name: string } | null;
}

/** What the status action reports. */
export interface Status {
  readonly version: string;
  /** Whether the Discord bot is connected (false in browser-only mode or while connecting). */
  readonly discord: boolean;
  readonly uptimeMs: number;
}

export interface ActionsOptions {
  readonly store: Store;
  readonly queue: QueueService;
  readonly players: Players;
  readonly resolver: Resolver;
  readonly log: Logger;
  /** Set once the bot logs in; null in browser-only mode. */
  voice?: VoiceControl | null;
  /** Whether the bot is connected right now. */
  discordReady?: () => boolean;
  readonly startedAt?: number;
  /** The most tracks a server's queue may hold (default 1000). */
  readonly queueMax?: number;
  /** The longest track that may be added, in milliseconds (default 3 hours). */
  readonly trackMaxMs?: number;
}

/** What an add did: the new queue items, and how many tracks were left out and why. */
export interface AddResult {
  readonly items: QueueItem[];
  /** Tracks longer than the limit (JUKECORD_TRACK_MAX). */
  readonly skippedTooLong: number;
  /** Tracks that did not fit because the queue reached its limit (JUKECORD_QUEUE_MAX). */
  readonly skippedFull: number;
}

/** The repeat modes, for checking input from the panel, the API and the CLI. */
export const REPEAT_MODES: readonly RepeatMode[] = ['off', 'track', 'queue'];

export class Actions {
  private readonly options: ActionsOptions;

  constructor(options: ActionsOptions) {
    this.options = options;
  }

  /** Called by the Discord side once it is up, so join and leave start working. */
  setVoice(voice: VoiceControl | null, ready: () => boolean): void {
    this.options.voice = voice;
    this.options.discordReady = ready;
  }

  // Refuses a change from someone who may not make it.
  private control(context: ActionContext): void {
    if (!context.mayControl)
      throw new ActionError('forbidden', 'only members with the DJ role can change the music here');
  }

  // Looks up an input and turns lookup failures into errors people can act on.
  private async lookup(input: string, signal?: AbortSignal): Promise<Track[]> {
    try {
      return await this.options.resolver.resolve(input, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ActionError(/nothing to add/.test(message) ? 'invalid' : 'not-found', message);
    }
  }

  /** Adds what an address or search finds (all of a playlist) and starts playing if nothing was. */
  async add(context: ActionContext, input: string, at: InsertAt = 'end', signal?: AbortSignal): Promise<AddResult> {
    this.control(context);
    const result = this.enqueue(context, await this.lookup(input, signal), at);
    this.options.players.get(context.guildId).play();
    return result;
  }

  // Queues what fits: tracks over the length limit are left out, and the rest up to the queue limit. Nothing fitting
  // at all is an error, so a person does not see "added" for an add that did nothing.
  private enqueue(context: ActionContext, tracks: readonly Track[], at: InsertAt): AddResult {
    const trackMax = this.options.trackMaxMs ?? 3 * 3_600_000;
    const queueMax = this.options.queueMax ?? 1000;
    // Unknown lengths pass: most such tracks are ordinary songs from sites that do not say.
    const short = tracks.filter((track) => track.durationMs === null || track.durationMs <= trackMax);
    const room = Math.max(0, queueMax - this.options.queue.size(context.guildId));
    const fitting = short.slice(0, room);
    const skippedTooLong = tracks.length - short.length;
    const skippedFull = short.length - fitting.length;
    if (fitting.length === 0) {
      if (skippedFull > 0) throw new ActionError('conflict', `the queue is full (${queueMax} tracks)`);
      throw new ActionError('invalid', `longer than the ${Math.round(trackMax / 60_000)} minute limit`);
    }
    const items = this.options.queue.add(
      context.guildId,
      fitting.map((track) => track.id),
      at,
      context.userId,
    );
    return { items, skippedTooLong, skippedFull };
  }

  /** Puts what an input finds first and plays it now; the current track is skipped. */
  async playNow(context: ActionContext, input: string, signal?: AbortSignal): Promise<AddResult> {
    this.control(context);
    const result = this.enqueue(context, await this.lookup(input, signal), 'next');
    const player = this.options.players.get(context.guildId);
    // Idle: play starts the first of the new items. Otherwise skipping moves on to it.
    if (!player.play()) player.skip();
    return result;
  }

  /** Sets what happens at the end of a track: off, the same track again, or the queue looping. */
  repeat(context: ActionContext, mode: string): PlayerSnapshot {
    this.control(context);
    if (!REPEAT_MODES.includes(mode as RepeatMode))
      throw new ActionError('invalid', `repeat is one of ${REPEAT_MODES.join(', ')}`);
    const player = this.options.players.get(context.guildId);
    player.setRepeat(mode as RepeatMode);
    return player.snapshot();
  }

  skip(context: ActionContext): PlayerSnapshot {
    this.control(context);
    const player = this.options.players.get(context.guildId);
    if (!player.skip()) throw new ActionError('conflict', 'nothing is playing');
    return player.snapshot();
  }

  /** Drops the current track without counting it as played. */
  removeCurrent(context: ActionContext): PlayerSnapshot {
    this.control(context);
    const player = this.options.players.get(context.guildId);
    if (!player.removeCurrent()) throw new ActionError('conflict', 'nothing is playing');
    return player.snapshot();
  }

  pause(context: ActionContext): PlayerSnapshot {
    this.control(context);
    const player = this.options.players.get(context.guildId);
    if (!player.pause()) throw new ActionError('conflict', 'nothing is playing');
    return player.snapshot();
  }

  resume(context: ActionContext): PlayerSnapshot {
    this.control(context);
    const player = this.options.players.get(context.guildId);
    if (!player.resume()) throw new ActionError('conflict', 'nothing is paused');
    return player.snapshot();
  }

  /** Moves to a place in the current track, in milliseconds from the start. */
  seek(context: ActionContext, positionMs: number): PlayerSnapshot {
    this.control(context);
    if (!Number.isFinite(positionMs) || positionMs < 0)
      throw new ActionError('invalid', 'the position must be 0 or more');
    const player = this.options.players.get(context.guildId);
    if (!player.seek(positionMs)) throw new ActionError('conflict', 'nothing is playing');
    return player.snapshot();
  }

  /** Stops playing; the queue stays. */
  stop(context: ActionContext): PlayerSnapshot {
    this.control(context);
    const player = this.options.players.get(context.guildId);
    if (!player.stop()) throw new ActionError('conflict', 'nothing is playing');
    return player.snapshot();
  }

  /** What plays now and where (anyone may look). */
  nowPlaying(context: ActionContext): PlayerSnapshot {
    return this.options.players.get(context.guildId).snapshot();
  }

  /** The queue in play order, with its change counter. */
  queue(context: ActionContext): { items: QueueItem[]; version: number } {
    return { items: this.options.queue.list(context.guildId), version: this.options.queue.version(context.guildId) };
  }

  remove(context: ActionContext, itemId: number): void {
    this.control(context);
    if (!this.options.queue.remove(context.guildId, itemId))
      throw new ActionError('not-found', 'that track is no longer in the queue');
  }

  /** Moves a queued track to a position (0 is next). */
  move(context: ActionContext, itemId: number, index: number): void {
    this.control(context);
    try {
      this.options.queue.move(context.guildId, itemId, index);
    } catch (error) {
      throw this.fromStore(error);
    }
  }

  shuffle(context: ActionContext): void {
    this.control(context);
    this.options.queue.shuffle(context.guildId);
  }

  /** Removes later copies of tracks queued twice; returns how many went. */
  dedupe(context: ActionContext): number {
    this.control(context);
    return this.options.queue.dedupe(context.guildId);
  }

  /** Empties the queue; returns how many tracks were in it. */
  clear(context: ActionContext): number {
    this.control(context);
    return this.options.queue.clear(context.guildId);
  }

  /** Played tracks, newest first; `beforeId` pages back. */
  history(context: ActionContext, limit = 50, beforeId?: number): HistoryEntry[] {
    // Bounded: a client asking for a million rows gets a page.
    const bounded = Math.min(Math.max(1, Math.floor(limit)), 200);
    return this.options.store.history.list(context.guildId, bounded, beforeId);
  }

  playlists(context: ActionContext): Playlist[] {
    return this.options.store.playlists.list(context.guildId);
  }

  /** Saves the current track and the queue, in play order, under a name (replacing a list of that name). */
  playlistSave(context: ActionContext, name: string): Playlist {
    this.control(context);
    const current = this.options.players.get(context.guildId).snapshot().track;
    const queued = this.options.queue.list(context.guildId).map((item) => item.track.id);
    const ids = current ? [current.id, ...queued] : queued;
    if (ids.length === 0) throw new ActionError('invalid', 'there is nothing to save: the queue is empty');
    try {
      return this.options.store.playlists.save(context.guildId, name, ids, context.userId);
    } catch (error) {
      throw this.fromStore(error);
    }
  }

  /** Adds a saved list to the queue and starts playing if nothing was. */
  playlistLoad(context: ActionContext, name: string, at: InsertAt = 'end'): AddResult {
    this.control(context);
    const playlist = this.options.store.playlists.find(context.guildId, name);
    if (!playlist) throw new ActionError('not-found', `there is no playlist named "${name.trim()}"`);
    const result = this.enqueue(context, this.options.store.playlists.tracks(playlist.id), at);
    this.options.players.get(context.guildId).play();
    return result;
  }

  playlistRename(context: ActionContext, name: string, newName: string): Playlist {
    this.control(context);
    const playlist = this.options.store.playlists.find(context.guildId, name);
    if (!playlist) throw new ActionError('not-found', `there is no playlist named "${name.trim()}"`);
    try {
      return this.options.store.playlists.rename(playlist.id, newName);
    } catch (error) {
      throw this.fromStore(error);
    }
  }

  playlistDelete(context: ActionContext, name: string): void {
    this.control(context);
    const playlist = this.options.store.playlists.find(context.guildId, name);
    if (!playlist || !this.options.store.playlists.remove(playlist.id)) {
      throw new ActionError('not-found', `there is no playlist named "${name.trim()}"`);
    }
  }

  /** Joins a voice channel (the caller's own when none is named). */
  async join(context: ActionContext, channelId: string | null): Promise<{ channelId: string; name: string }> {
    this.control(context);
    const voice = this.options.voice;
    if (!voice)
      throw new ActionError('unavailable', 'jukecord runs without a Discord bot here, so it cannot join voice');
    return voice.join(context.guildId, channelId, context.userId);
  }

  leave(context: ActionContext): void {
    this.control(context);
    const voice = this.options.voice;
    if (!voice?.leave(context.guildId)) throw new ActionError('conflict', 'the bot is not in a voice channel');
  }

  /** The version and whether Discord is connected (anyone may look; no server needed). */
  status(): Status {
    return {
      version: VERSION,
      discord: this.options.discordReady?.() ?? false,
      uptimeMs: Date.now() - (this.options.startedAt ?? Date.now()),
    };
  }

  // Store errors are mistakes in the request (an unknown item, a name taken); they become "invalid" or "conflict".
  private fromStore(error: unknown): unknown {
    if (!(error instanceof StoreError)) return error;
    return new ActionError(/exists/.test(error.message) ? 'conflict' : 'invalid', error.message);
  }
}
