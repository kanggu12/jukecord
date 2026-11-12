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
import { plainReason, REASONS } from '../core/reasons.ts';
import type { HistoryEntry, Playlist, QueueItem, Track } from '../core/types.ts';
import type { Logger } from '../log.ts';
import { AddressError } from '../media/address.ts';
import { BusyError } from '../media/busy.ts';
import type { Resolver } from '../media/resolver.ts';
import type { CommunitySettings, HistoryStats, RepeatMode, Store } from '../store/store.ts';
import { StoreError } from '../store/store.ts';
import { VERSION } from '../version.ts';
import type { SkipVotes, VotesView } from './votes.ts';

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
  'jump',
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
  'voice-channels',
  'stats',
  'settings',
  'dj-role',
  'status',
  'stay',
  'vote-skip',
  'take-turns',
  'turns-now',
  'person-limit',
] as const;

export type ActionName = (typeof ACTIONS)[number];

/** Who is acting and in which server. Built by each way in from its own login (Discord member, panel session, token). */
export interface ActionContext {
  readonly guildId: string;
  /** The Discord user ID, or null for the CLI on the host and a panel without a Discord login. */
  readonly userId: string | null;
  /** Whether this person may change the queue (the server's DJ role, when one is set, decides). */
  readonly mayControl: boolean;
  /** Whether this person may change the server's jukecord settings (Manage Server in Discord, or the host). */
  readonly mayManage: boolean;
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
  /**
   * The server's voice channels the bot may join, in Discord's order, as one viewer may see them: a member sees the
   * channels they can see themselves, anyone else (the panels' shared updates) the ones everybody in the server can
   * see, and `all` (the host) every one.
   */
  channels(guildId: string, viewer: { userId: string | null; all: boolean }): VoiceChannelInfo[];
  /** The server's stay setting changed: the bot looks again at whether it is alone and counts down to leaving. */
  stayChanged?(guildId: string): void;
}

/** A voice channel, for choosing where the bot goes. */
export interface VoiceChannelInfo {
  readonly id: string;
  readonly name: string;
  /** How many people (not bots) are in it now. */
  readonly people: number;
}

/** A Discord server the bot is in. */
export interface GuildInfo {
  readonly id: string;
  readonly name: string;
  /** The icon's hash (the panel builds the address), or null. */
  readonly icon: string | null;
}

/** A role of a server, for choosing the DJ role. */
export interface RoleInfo {
  readonly id: string;
  readonly name: string;
  /** The role's colour as a number (0 for none), shown beside its name. */
  readonly color: number;
}

/** What jukecord needs to know about a member to decide what they may do. */
export interface MemberInfo {
  readonly roles: readonly string[];
  /** Whether they have Manage Server (or are the owner, or an administrator). */
  readonly manage: boolean;
}

/** What jukecord can learn from Discord: the servers, their roles, and who is a member. Absent in browser-only mode. */
export interface Directory {
  /** The bot's own account (name and avatar for the panel's header), or null before it has logged in. */
  self(): { readonly id: string; readonly name: string; readonly avatar: string | null } | null;
  /** Whether Discord has sent the server list yet: false for the first seconds after jukecord starts. */
  loaded(): boolean;
  guilds(): GuildInfo[];
  roles(guildId: string): RoleInfo[];
  /** The member's roles and rights, or null when they are not in the server. */
  member(guildId: string, userId: string): Promise<MemberInfo | null>;
}

/** A server's jukecord settings as the panel and the commands show them: the DJ role, and how people share the music. */
export interface SettingsView extends CommunitySettings {
  /** The role that may change the music, or null for everyone. */
  readonly djRoleId: string | null;
  /** The server's roles to choose from (empty in browser-only mode). */
  readonly roles: readonly RoleInfo[];
}

/** Listening figures over a span of days, with every day present (days without plays count zero). */
export interface StatsView extends Omit<HistoryStats, 'days'> {
  readonly days: readonly { readonly day: string; readonly plays: number; readonly playedMs: number }[];
  /** The span, in days, and the first day of it (YYYY-MM-DD in the viewer's time zone). */
  readonly span: number;
  readonly from: string;
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
  /** What Discord says about servers, roles and members; null in browser-only mode. */
  directory?: Directory | null;
  /** Whether the bot is connected right now. */
  discordReady?: () => boolean;
  readonly startedAt?: number;
  /** The most tracks a server's queue may hold (default 1000). */
  readonly queueMax?: number;
  /** The longest track that may be added, in milliseconds (default 3 hours). */
  readonly trackMaxMs?: number;
  /** The votes to skip; without them (tests that do not care) Skip needs the DJ role, as it did before votes. */
  readonly votes?: SkipVotes;
}

/** What a skip did: the player after it, and how the vote stands when it was a vote the track did not go by. */
export interface SkipResult {
  readonly snapshot: PlayerSnapshot;
  /** Null when the track went: a skip by someone who may change the music, or the vote that made it go. */
  readonly votes: { readonly votes: number; readonly needed: number } | null;
}

/** What an add did: the new queue items, and how many tracks were left out and why. */
export interface AddResult {
  readonly items: QueueItem[];
  /** Tracks longer than the limit (JUKECORD_TRACK_MAX). */
  readonly skippedTooLong: number;
  /** Tracks that did not fit because the queue reached its limit (JUKECORD_QUEUE_MAX). */
  readonly skippedFull: number;
  /** Tracks that did not fit because the person reached the server's limit of tracks per person. */
  readonly skippedLimit: number;
}

/**
 * The DJ role that applies: the one chosen, unless it no longer exists in the server (deleted in Discord since), which
 * counts as no DJ role at all. Otherwise nobody but the managers could change the music, and nothing in jukecord would
 * say why. `roles` is the server's roles as Discord says now, or null when that is not known (no bot, or a server the
 * bot does not see): then the role chosen stands.
 */
export function djRoleNow(chosen: string | null, roles: readonly RoleInfo[] | null): string | null {
  if (chosen === null || roles === null) return chosen;
  return roles.some((role) => role.id === chosen) ? chosen : null;
}

/** The repeat modes, for checking input from the panel, the API and the CLI. */
export const REPEAT_MODES: readonly RepeatMode[] = ['off', 'track', 'queue'];

export class Actions {
  private readonly options: ActionsOptions;

  constructor(options: ActionsOptions) {
    this.options = options;
  }

  /** Called by the Discord side once it is up, so join and leave start working. */
  setVoice(voice: VoiceControl | null, ready: () => boolean, directory: Directory | null = null): void {
    this.options.voice = voice;
    this.options.discordReady = ready;
    this.options.directory = directory;
  }

  // Refuses a change from someone who may not make it.
  private control(context: ActionContext): void {
    if (!context.mayControl)
      throw new ActionError('forbidden', 'only members with the DJ role can change the music here');
  }

  // Looks up an input and turns lookup failures into errors people can act on.
  private async lookup(input: string, signal: AbortSignal | undefined, context: ActionContext): Promise<Track[]> {
    try {
      // Counted against the person's share and the server's share of the lookups (see Resolver).
      return await this.options.resolver.resolve(input, signal, context.userId, context.guildId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof AddressError) throw new ActionError('invalid', REASONS.privateNetwork);
      if (error instanceof BusyError) throw new ActionError('unavailable', message);
      // Nothing typed: said as it is. Anything else: the short reason (the resolver logged the full text).
      if (/nothing to add/.test(message)) throw new ActionError('invalid', message);
      throw new ActionError('not-found', plainReason(message));
    }
  }

  /** Adds what an address or search finds (all of a playlist) and starts playing if nothing was. */
  async add(context: ActionContext, input: string, at: InsertAt = 'end', signal?: AbortSignal): Promise<AddResult> {
    this.control(context);
    const result = this.enqueue(context, await this.lookup(input, signal, context), at);
    this.options.players.get(context.guildId).play();
    return result;
  }

  // Queues what fits: tracks over the length limit are left out, the rest up to the queue limit, and then up to the
  // person's own limit where the server has one. Nothing fitting at all is an error, so a person does not see "added"
  // for an add that did nothing. Where the server's people take turns, tracks added at the end go in turn.
  private enqueue(context: ActionContext, tracks: readonly Track[], at: InsertAt): AddResult {
    const trackMax = this.options.trackMaxMs ?? 3 * 3_600_000;
    const queueMax = this.options.queueMax ?? 1000;
    // Unknown lengths pass: most such tracks are ordinary songs from sites that do not say.
    const short = tracks.filter((track) => track.durationMs === null || track.durationMs <= trackMax);
    const room = Math.max(0, queueMax - this.options.queue.size(context.guildId));
    const roomy = short.slice(0, room);
    // A person's own room under the server's limit of tracks per person; the host (no Discord ID) has none.
    const community = this.options.store.settings.community(context.guildId);
    const limit = community.personLimit;
    const own =
      context.userId !== null && limit > 0
        ? Math.max(0, limit - this.options.queue.countBy(context.guildId, context.userId))
        : Number.POSITIVE_INFINITY;
    const fitting = roomy.slice(0, own);
    const skippedTooLong = tracks.length - short.length;
    const skippedFull = short.length - roomy.length;
    const skippedLimit = roomy.length - fitting.length;
    if (fitting.length === 0) {
      if (skippedFull > 0 && roomy.length === 0)
        throw new ActionError('conflict', `the queue is full (${queueMax} tracks)`);
      if (skippedLimit > 0) throw new ActionError('conflict', `each person may have ${limit} tracks in the queue here`);
      throw new ActionError('invalid', `longer than the ${Math.round(trackMax / 60_000)} minute limit`);
    }
    const ids = fitting.map((track) => track.id);
    // In turns: the track playing counts as its person's turn under way.
    const snapshot = this.options.players.get(context.guildId).snapshot();
    const items =
      at === 'end' && community.takeTurns
        ? this.options.queue.addInTurns(
            context.guildId,
            ids,
            context.userId,
            snapshot.track ? { owner: snapshot.addedBy } : null,
          )
        : this.options.queue.add(context.guildId, ids, at, context.userId);
    return { items, skippedTooLong, skippedFull, skippedLimit };
  }

  /** Puts what an input finds first and plays it now; the current track is skipped. */
  async playNow(context: ActionContext, input: string, signal?: AbortSignal): Promise<AddResult> {
    this.control(context);
    const result = this.enqueue(context, await this.lookup(input, signal, context), 'next');
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

  /**
   * Moves to the next track. Where the server has a DJ role and votes on, Skip from someone without the role is a vote
   * instead (see app/votes.ts): the track goes once half of the people listening have voted.
   */
  skip(context: ActionContext): SkipResult {
    const player = this.options.players.get(context.guildId);
    const votes = this.options.votes;
    // Someone without the DJ role where Skip is a vote: a vote, which skips the track once there are enough.
    if (!context.mayControl && votes && context.userId !== null && this.voteSkipApplies(context.guildId)) {
      if (player.snapshot().track === null) throw new ActionError('conflict', 'nothing is playing');
      const result = votes.vote(context.guildId, context.userId);
      return {
        snapshot: player.snapshot(),
        votes: result.skipped ? null : { votes: result.votes, needed: result.needed },
      };
    }
    // Anyone else without the DJ role is refused, as for every other change of the music.
    this.control(context);
    if (!player.skip()) throw new ActionError('conflict', 'nothing is playing');
    return { snapshot: player.snapshot(), votes: null };
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

  /**
   * Plays on: a paused track continues, and with nothing playing (after a stop, or a restart that found nothing) the
   * queue starts. One action for the one play key people expect.
   */
  resume(context: ActionContext): PlayerSnapshot {
    this.control(context);
    const player = this.options.players.get(context.guildId);
    if (player.resume() || player.play()) return player.snapshot();
    // Neither worked: either something is already playing, or there is nothing to start.
    const idle = player.snapshot().status === 'idle';
    throw new ActionError('conflict', idle ? 'the queue is empty' : 'it is already playing');
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

  /** Plays a queued track now: it moves to the front and the current track is skipped. */
  jump(context: ActionContext, itemId: number): PlayerSnapshot {
    this.control(context);
    const player = this.options.players.get(context.guildId);
    try {
      this.options.queue.move(context.guildId, itemId, 0);
    } catch (error) {
      throw this.fromStore(error);
    }
    // Idle: play starts it. Otherwise skipping moves on to it, now first in the queue.
    if (!player.play()) player.skip();
    return player.snapshot();
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

  /** The voice channels the bot could join, and which one it is in (anyone may look). */
  voiceChannels(context: ActionContext): {
    current: { channelId: string; name: string } | null;
    channels: VoiceChannelInfo[];
  } {
    const voice = this.options.voice;
    // Browser-only: there are no channels, which is an answer, not an error (the panel shows "no Discord").
    if (!voice) return { current: null, channels: [] };
    // The host (no Discord user, may manage) sees every channel; a member, the ones they can see themselves.
    const viewer = { userId: context.userId, all: context.userId === null && context.mayManage };
    const channels = voice.channels(context.guildId, viewer);
    const current = voice.channel(context.guildId);
    // The bot's own channel is named only to those who can see it; the others learn that it is in voice, not where.
    const hidden = current !== null && !viewer.all && !channels.some((channel) => channel.id === current.channelId);
    return { current: hidden ? { channelId: current.channelId, name: '' } : current, channels };
  }

  /**
   * Listening figures for the last `days` days in the viewer's time zone (`offsetMinutes` east of UTC, the way
   * JavaScript's getTimezoneOffset() reports it but with the sign flipped). Anyone may look.
   */
  stats(context: ActionContext, days = 30, offsetMinutes = 0, now = Date.now()): StatsView {
    if (!Number.isInteger(days) || days < 1 || days > 366) throw new ActionError('invalid', 'days is 1 to 366');
    // Real time zones lie between UTC-12 and UTC+14.
    if (!Number.isInteger(offsetMinutes) || offsetMinutes < -720 || offsetMinutes > 840) {
      throw new ActionError('invalid', 'the time zone offset is -720 to 840 minutes');
    }
    const offsetMs = offsetMinutes * 60_000;
    // The span starts at the viewer's midnight `days - 1` days ago, so "7 days" is today and the six before it.
    const today = Math.floor((now + offsetMs) / 86_400_000);
    const firstDay = today - (days - 1);
    const since = firstDay * 86_400_000 - offsetMs;
    const raw = this.options.store.history.stats(context.guildId, since, offsetMs);
    const byDay = new Map(raw.days.map((entry) => [entry.day, entry]));
    // Every day of the span, zero where nothing played, so a chart's bars line up with the calendar.
    const filled = Array.from({ length: days }, (_, index) => {
      const day = new Date((firstDay + index) * 86_400_000).toISOString().slice(0, 10);
      return byDay.get(day) ?? { day, plays: 0, playedMs: 0 };
    });
    return { ...raw, days: filled, span: days, from: filled[0]?.day ?? '' };
  }

  /** The server's settings and the roles to choose the DJ role from (anyone may look). */
  settings(context: ActionContext): SettingsView {
    const roles = this.options.directory?.roles(context.guildId) ?? null;
    // A deleted role is shown as none, which is how it counts (see djRoleNow).
    const djRoleId = djRoleNow(this.options.store.settings.get(context.guildId).djRoleId, roles);
    // How the server's people share the music, beside the DJ role.
    return { djRoleId, roles: roles ?? [], ...this.options.store.settings.community(context.guildId) };
  }

  /** Sets (or clears, with null) the role that may change the music. Needs Manage Server. */
  djRole(context: ActionContext, roleId: string | null): SettingsView {
    if (!context.mayManage)
      throw new ActionError('forbidden', 'only people who can manage the server can set the DJ role');
    if (roleId !== null) {
      // A role that does not exist would lock everyone but the managers out; refuse it. Browser-only mode has no roles.
      const roles = this.options.directory?.roles(context.guildId);
      if (!roles)
        throw new ActionError('unavailable', 'jukecord runs without a Discord bot here, so there are no roles');
      if (!roles.some((role) => role.id === roleId))
        throw new ActionError('not-found', 'that role is not in this server');
    }
    this.options.store.settings.setDjRole(context.guildId, roleId);
    // Whether Skip is a vote depends on the DJ role: votes under way end, and the panels hear the new state.
    this.options.votes?.reset(context.guildId);
    return this.settings(context);
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

  // Refuses a change of the server's settings from someone who cannot manage the server.
  private manage(context: ActionContext): void {
    if (!context.mayManage)
      throw new ActionError('forbidden', 'only people who can manage the server can change this setting');
  }

  /**
   * Whether the bot stays in its voice channel when everyone has left it; otherwise it leaves after the host's time
   * alone (JUKECORD_VOICE_IDLE). Needs Manage Server.
   */
  stay(context: ActionContext, on: boolean): SettingsView {
    this.manage(context);
    this.options.store.settings.setCommunity(context.guildId, { stay: on });
    // The bot looks again at once: staying stops a countdown under way, and leaving starts one in an empty channel.
    this.options.voice?.stayChanged?.(context.guildId);
    return this.settings(context);
  }

  /** Whether Skip from someone without the DJ role is a vote in a server: it has a DJ role, and votes are on. */
  voteSkipApplies(guildId: string): boolean {
    const roles = this.options.directory?.roles(guildId) ?? null;
    // The DJ role that counts (a role deleted in Discord is none, see djRoleNow): without one, everyone may skip.
    if (djRoleNow(this.options.store.settings.get(guildId).djRoleId, roles) === null) return false;
    return this.options.store.settings.community(guildId).voteSkip;
  }

  /** How the votes to skip the current track stand (anyone may look; the panels get it live). */
  skipVotes(context: ActionContext): VotesView {
    return this.options.votes?.view(context.guildId) ?? { on: false, votes: 0, needed: 0 };
  }

  /**
   * Whether Skip from someone without the DJ role is a vote (on, the default) or refused (off), where the server has a
   * DJ role. Needs Manage Server.
   */
  voteSkip(context: ActionContext, on: boolean): SettingsView {
    this.manage(context);
    this.options.store.settings.setCommunity(context.guildId, { voteSkip: on });
    // Votes under way end either way, and the panels hear whether Skip is a vote now.
    this.options.votes?.reset(context.guildId);
    return this.settings(context);
  }

  /**
   * Whether people take turns: a track added at the end goes after the last track of the first round in which its
   * person has none yet (see core/turns.ts). The queue as it is stays; "turns now" puts it in turns. Needs Manage Server.
   */
  takeTurns(context: ActionContext, on: boolean): SettingsView {
    this.manage(context);
    this.options.store.settings.setCommunity(context.guildId, { takeTurns: on });
    return this.settings(context);
  }

  /** Puts the queue in turns once, whatever the setting, and returns how many tracks changed place. */
  turnsNow(context: ActionContext): number {
    this.control(context);
    const snapshot = this.options.players.get(context.guildId).snapshot();
    return this.options.queue.takeTurns(context.guildId, snapshot.track ? { owner: snapshot.addedBy } : null);
  }

  /** The most tracks one person may have in the queue at once (0 for no limit). Needs Manage Server. */
  personLimit(context: ActionContext, tracks: number): SettingsView {
    this.manage(context);
    // A whole number up to the queue's own limit: more could never be reached.
    const max = this.options.queueMax ?? 1000;
    if (!Number.isInteger(tracks) || tracks < 0 || tracks > max)
      throw new ActionError('invalid', `the limit is 0 (none) to ${max} tracks`);
    this.options.store.settings.setCommunity(context.guildId, { personLimit: tracks });
    return this.settings(context);
  }
}
