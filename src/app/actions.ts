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
import type { HistoryEntry, LikedTrack, NewTrack, Playlist, QueueItem, Track } from '../core/types.ts';
import type { Logger } from '../log.ts';
import { type AddressCheck, AddressError } from '../media/address.ts';
import { BATCH_MOST, BatchLookups } from '../media/batch.ts';
import { BusyError } from '../media/busy.ts';
import type { Resolver } from '../media/resolver.ts';
import type { Search } from '../media/search.ts';
import { canonicalSource, parseInput, youtubeVideoId } from '../media/source.ts';
import type { AutoplayMode, HistoryStats, RepeatMode, Store } from '../store/store.ts';
import { LIKES_MAX, StoreError } from '../store/store.ts';
import { VERSION } from '../version.ts';
import type { Autoplay } from './autoplay.ts';
import {
  fileName,
  PLAYLIST_FORMATS,
  type PlaylistFile,
  PlaylistFileError,
  type PlaylistFormat,
  readPlaylist,
  writePlaylist,
} from './playlist-files.ts';

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
  'search',
  'likes',
  'like',
  'unlike',
  'likes-add',
  'autoplay',
  'playlist-export',
  'playlist-import',
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

/** A server's jukecord settings as the panel and the commands show them. */
export interface SettingsView {
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
  /** Searching YouTube for words, to pick from (absent: searching is refused as not set up). */
  readonly search?: Search;
  /** What picks a track when a queue runs out (told when a person stops the music); absent in tests that need none. */
  readonly autoplay?: Autoplay;
  /** The turns of lookups that come in lists (an imported playlist's lines); one of its own when absent. */
  readonly batch?: BatchLookups;
  /** The check of addresses a file brings (private networks refused); none: every address passes. */
  readonly checkAddress?: AddressCheck;
}

/** A playlist as a file (see playlist-files.ts). */
export interface PlaylistExport {
  readonly name: string;
  readonly format: PlaylistFormat;
  readonly filename: string;
  readonly content: string;
}

/** What an import made: the playlist, how many tracks it holds, and how many entries were left out. */
export interface ImportResult {
  readonly playlist: Playlist;
  readonly tracks: number;
  readonly leftOut: number;
}

/** The most entries an import takes (as many as a playlist added from a site). */
export const IMPORT_MOST = 500;

/** What an add did: the new queue items, and how many tracks were left out and why. */
export interface AddResult {
  readonly items: QueueItem[];
  /** Tracks longer than the limit (JUKECORD_TRACK_MAX). */
  readonly skippedTooLong: number;
  /** Tracks that did not fit because the queue reached its limit (JUKECORD_QUEUE_MAX). */
  readonly skippedFull: number;
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

/**
 * Whose likes an action reads and writes: the Discord user's, or the host's (the host has no Discord ID, and no Discord
 * ID is the word "host").
 */
export function likesOwner(context: ActionContext): string {
  return context.userId ?? 'host';
}

/** The repeat modes, for checking input from the panel, the API and the CLI. */
export const REPEAT_MODES: readonly RepeatMode[] = ['off', 'track', 'queue'];

/** The autoplay modes, for checking input the same way. */
export const AUTOPLAY_MODES: readonly AutoplayMode[] = ['off', 'history', 'related'];

export class Actions {
  private readonly options: ActionsOptions;
  // The turns of lookups that come in lists, shared by every import (and the links of other services).
  private readonly batch: BatchLookups;

  constructor(options: ActionsOptions) {
    this.options = options;
    this.batch = options.batch ?? new BatchLookups();
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
    // "At the end", for a person, is before the tracks autoplay queued to fill a queue that ran out: those play after
    // what people add, and none of them is taken away.
    const place = at === 'end' ? (this.options.store.queue.autoplayTail(context.guildId) ?? 'end') : at;
    const items = this.options.queue.add(
      context.guildId,
      fitting.map((track) => track.id),
      place,
      context.userId,
    );
    return { items, skippedTooLong, skippedFull };
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

  /** Stops playing; the queue stays. Autoplay stops with it until a track starts again. */
  stop(context: ActionContext): PlayerSnapshot {
    this.control(context);
    const player = this.options.players.get(context.guildId);
    if (!player.stop()) throw new ActionError('conflict', 'nothing is playing');
    this.options.autoplay?.stopped(context.guildId);
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
    return { djRoleId, roles: roles ?? [] };
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

  /**
   * What YouTube finds for some words, to pick from before adding: the add field's list, the API, the command and
   * Discord's suggestions. Words only: an address is added as it is, with nothing to pick. Only for people who may
   * change the music (it is the first step of adding), and held to the lookups' shares like an add.
   */
  async search(context: ActionContext, words: string, limit = 8, signal?: AbortSignal): Promise<NewTrack[]> {
    this.control(context);
    const search = this.options.search;
    if (!search) throw new ActionError('unavailable', 'searching is not set up here');
    let input: ReturnType<typeof parseInput>;
    try {
      input = parseInput(words);
    } catch {
      throw new ActionError('invalid', 'nothing to search for');
    }
    if (input.kind === 'url') throw new ActionError('invalid', 'a search takes words, not an address');
    try {
      return await search.find(input.query, {
        limit,
        who: context.userId,
        server: context.guildId,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      // The asker went away (the next key was typed): its own abort, as it is.
      if (signal?.aborted) throw error;
      if (error instanceof BusyError) throw new ActionError('unavailable', error.message);
      throw new ActionError('not-found', plainReason(error instanceof Error ? error.message : String(error)));
    }
  }

  /** The tracks this login liked, newest first (anyone may look at their own). */
  likes(context: ActionContext): LikedTrack[] {
    return this.options.store.likes.list(likesOwner(context));
  }

  /**
   * Likes a track for this login. A like is personal, so the DJ role is not needed; the track must be one this server
   * shows (playing, queued, played here or in one of its playlists): a track number from elsewhere would show another
   * server's music in the list.
   */
  like(context: ActionContext, trackId: number): LikedTrack {
    const store = this.options.store;
    const track = store.tracks.get(trackId);
    const here =
      track !== null &&
      (this.options.players.existing(context.guildId)?.snapshot().track?.id === trackId ||
        this.options.queue.contains(context.guildId, trackId) ||
        store.history.played(context.guildId, trackId) ||
        store.playlists
          .list(context.guildId)
          .some((playlist) => store.playlists.tracks(playlist.id).some((t) => t.id === trackId)));
    if (!track || !here)
      throw new ActionError('not-found', 'that track is not playing, queued or played in this server');
    const owner = likesOwner(context);
    if (!store.likes.has(owner, trackId) && store.likes.count(owner) >= LIKES_MAX)
      throw new ActionError('conflict', `your likes are full (${LIKES_MAX} tracks)`);
    store.likes.add(owner, trackId);
    const liked = store.likes.list(owner).find((entry) => entry.track.id === trackId);
    return liked ?? { track, likedAt: Date.now() };
  }

  /** Takes a like back. */
  unlike(context: ActionContext, trackId: number): void {
    if (!this.options.store.likes.remove(likesOwner(context), trackId))
      throw new ActionError('not-found', 'that track is not in your likes');
  }

  /** Adds every track this login liked to the queue, newest liked first, and starts playing if nothing was. */
  likesAdd(context: ActionContext, at: InsertAt = 'end'): AddResult {
    this.control(context);
    const liked = this.options.store.likes.list(likesOwner(context));
    if (liked.length === 0) throw new ActionError('invalid', 'there are no liked tracks to add');
    const result = this.enqueue(
      context,
      liked.map((entry) => entry.track),
      at,
    );
    this.options.players.get(context.guildId).play();
    return result;
  }

  /**
   * Sets what happens when the queue runs out: nothing, a track from this server's plays, or one related to the last
   * track (see app/autoplay.ts). Kept with the player's state, like the repeat mode.
   */
  autoplay(context: ActionContext, mode: string): PlayerSnapshot {
    this.control(context);
    if (!AUTOPLAY_MODES.includes(mode as AutoplayMode))
      throw new ActionError('invalid', `autoplay is one of ${AUTOPLAY_MODES.join(', ')}`);
    const player = this.options.players.get(context.guildId);
    player.setAutoplay(mode as AutoplayMode);
    return player.snapshot();
  }

  /** A saved playlist as a file: its addresses (text), an M3U, or jukecord's JSON (anyone may look). */
  playlistExport(context: ActionContext, name: string, format: string): PlaylistExport {
    if (!PLAYLIST_FORMATS.includes(format as PlaylistFormat))
      throw new ActionError('invalid', `the format is one of ${PLAYLIST_FORMATS.join(', ')}`);
    const store = this.options.store;
    const playlist = store.playlists.find(context.guildId, name);
    if (!playlist) throw new ActionError('not-found', `there is no playlist named "${name.trim()}"`);
    const kind = format as PlaylistFormat;
    return {
      name: playlist.name,
      format: kind,
      filename: fileName(playlist.name, kind),
      content: writePlaylist(playlist.name, store.playlists.tracks(playlist.id), kind),
    };
  }

  /**
   * Makes a playlist from a file or a pasted list (see playlist-files.ts), under a name not taken yet. An address
   * jukecord knows is that track; one the file describes (jukecord's JSON, an M3U's line) is stored as the file says,
   * after the same check as a typed address; the rest (addresses alone, words) are looked up, three at a time and at
   * most a hundred. What cannot be found is left out and counted.
   */
  async playlistImport(
    context: ActionContext,
    name: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<ImportResult> {
    this.control(context);
    const store = this.options.store;
    const clean = name.trim();
    if (clean.length === 0 || clean.length > 100)
      throw new ActionError('invalid', 'a playlist name is 1 to 100 characters');
    if (store.playlists.find(context.guildId, clean))
      throw new ActionError('conflict', `a playlist named "${clean}" exists`);
    let file: PlaylistFile;
    try {
      file = readPlaylist(content);
    } catch (error) {
      if (error instanceof PlaylistFileError) throw new ActionError('invalid', error.message);
      throw error;
    }
    if (file.entries.length === 0) throw new ActionError('invalid', 'there is nothing to import in it');
    const entries = file.entries.slice(0, IMPORT_MOST);
    // Each entry's tracks (a line may be a playlist's address), or null when nothing was found for it.
    const found: (Track[] | null)[] = entries.map(() => null);
    const toLook: number[] = [];
    for (const [index, entry] of entries.entries()) {
      if (entry.url) {
        const url = new URL(entry.url);
        const source = canonicalSource(url);
        const known = store.tracks.bySource(source);
        if (known) {
          found[index] = [known];
          continue;
        }
        if (entry.title) {
          // What the file says about an address jukecord does not know, after the check every address added gets.
          try {
            await this.options.checkAddress?.(url);
          } catch {
            continue;
          }
          found[index] = [
            store.tracks.upsert({
              source,
              url: youtubeVideoId(url) ? source : url.href,
              title: entry.title,
              uploader: entry.uploader,
              durationMs: entry.durationMs,
              thumbnail: entry.thumbnail,
            }),
          ];
          continue;
        }
      }
      if (entry.url || entry.words) toLook.push(index);
    }
    // At most a hundred lookups; the entries past them are left out.
    const asked = toLook.slice(0, BATCH_MOST);
    if (asked.length > 0) {
      let results: (Track[] | Error)[];
      try {
        results = await this.batch.map(
          context.userId,
          asked,
          (index, stop) =>
            this.options.resolver.resolveListed(entries[index]?.url ?? entries[index]?.words ?? '', stop),
          signal ? { signal } : {},
        );
      } catch (error) {
        if (error instanceof BusyError) throw new ActionError('unavailable', error.message);
        throw error;
      }
      results.forEach((result, at) => {
        const index = asked[at];
        if (index !== undefined && !(result instanceof Error)) found[index] = result;
      });
    }
    // In the file's order, at most as many as a playlist takes (a line that was a playlist's address adds several).
    const tracks = found.flatMap((entry) => entry ?? []).slice(0, IMPORT_MOST);
    const leftOut = file.entries.length - entries.length + found.filter((entry) => entry === null).length;
    if (tracks.length === 0) throw new ActionError('not-found', 'nothing in it could be found');
    // Taken while the lookups ran: refused as before, rather than saved over.
    if (store.playlists.find(context.guildId, clean))
      throw new ActionError('conflict', `a playlist named "${clean}" exists`);
    try {
      const playlist = store.playlists.save(
        context.guildId,
        clean,
        tracks.map((track) => track.id),
        context.userId,
      );
      return { playlist, tracks: tracks.length, leftOut };
    } catch (error) {
      throw this.fromStore(error);
    }
  }

  // Store errors are mistakes in the request (an unknown item, a name taken); they become "invalid" or "conflict".
  private fromStore(error: unknown): unknown {
    if (!(error instanceof StoreError)) return error;
    return new ActionError(/exists/.test(error.message) ? 'conflict' : 'invalid', error.message);
  }
}
