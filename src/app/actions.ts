/**
 * Everything a person can do with jukecord, in one place.
 *
 * The panel, the slash commands, the HTTP API and the CLI are four ways in; each of them only reads its input, calls
 * one of these actions, and shows the result. That is what keeps them in step: a feature exists when it is an action,
 * and a test checks that every action is reachable from all four (see ACTIONS and tests/unit/parity.test.ts).
 */
import { createHash, randomBytes } from 'node:crypto';
import type { PlayerSnapshot } from '../core/player.ts';
import type { Players } from '../core/players.ts';
import type { InsertAt, QueueService } from '../core/queue.ts';
import { plainReason, REASONS } from '../core/reasons.ts';
import type { HistoryEntry, Playlist, QueueItem, Track } from '../core/types.ts';
import type { Logger } from '../log.ts';
import { AddressError } from '../media/address.ts';
import { BusyError } from '../media/busy.ts';
import { type LyricsAnswer, type LyricsSource, LyricsUnavailable } from '../media/lyrics.ts';
import type { Resolver } from '../media/resolver.ts';
import type { HistoryStats, HistoryWrapped, ListenLinkRow, RepeatMode, Store } from '../store/store.ts';
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
  'wrapped',
  'alerts-channel',
  'lyrics',
  'stop-after',
  'listen-links',
  'listen-link-create',
  'listen-link-revoke',
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
  /**
   * Whether the refusal came after work an ordinary refusal does not cost: a lookup on the site (yt-dlp, the
   * network) that found nothing. The web server gives a refused change its address's share back unless it did.
   */
  readonly spent: boolean;

  constructor(code: ActionErrorCode, message: string, options: { spent?: boolean } = {}) {
    super(message);
    this.code = code;
    this.spent = options.spent ?? false;
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
  /** The server's text channels the bot may post in, in Discord's order (for the alerts channel). */
  textChannels?(guildId: string): TextChannelInfo[];
}

/** A text channel, for choosing where jukecord tells a server about trouble. */
export interface TextChannelInfo {
  readonly id: string;
  readonly name: string;
}

/** A server's jukecord settings as the panel and the commands show them. */
export interface SettingsView {
  /** The role that may change the music, or null for everyone. */
  readonly djRoleId: string | null;
  /** The server's roles to choose from (empty in browser-only mode). */
  readonly roles: readonly RoleInfo[];
  /** The text channel where jukecord tells the server about trouble (app/alerts.ts), or null for nowhere. */
  readonly alertsChannelId: string | null;
  /** The text channels the bot may post in, to choose it from (empty in browser-only mode). */
  readonly channels: readonly TextChannelInfo[];
}

/** Listening figures over a span of days, with every day present (days without plays count zero). */
export interface StatsView extends Omit<HistoryStats, 'days'> {
  readonly days: readonly { readonly day: string; readonly plays: number; readonly playedMs: number }[];
  /** The span, in days, and the first day of it (YYYY-MM-DD in the viewer's time zone). */
  readonly span: number;
  readonly from: string;
}

/** The times Wrapped covers: a calendar year, a calendar month, or the twelve months up to today. */
export type WrappedKind = 'year' | 'month' | 'last-12-months';

/** A server's time in music (Wrapped), with what time it is and what other times there are. */
export interface WrappedView extends HistoryWrapped {
  readonly period: {
    readonly kind: WrappedKind;
    /** As it is asked for: "2026", "2026-03" or "last-12-months". */
    readonly key: string;
    /** The first day and the last (YYYY-MM-DD in the viewer's time zone); the last is today while the time lasts. */
    readonly from: string;
    readonly to: string;
  };
  /**
   * The first day the history still reaches, when the time goes back further than that (jukecord keeps a server's
   * newest plays, HISTORY_KEEP of them); null when it reaches the whole time.
   */
  readonly keptFrom: string | null;
  /** The years and the months with plays, newest first ("2026", "2026-03"), to choose another time from. */
  readonly years: readonly string[];
  readonly months: readonly string[];
}

// Why a time was refused: the three ways to name one.
const PERIOD_FORMS = 'the period is a year (2026), a month (2026-03) or last-12-months';

/** What the status action reports. */
export interface Status {
  readonly version: string;
  /** Whether the Discord bot is connected (false in browser-only mode or while connecting). */
  readonly discord: boolean;
  readonly uptimeMs: number;
  /** Whether lyrics are looked up here (JUKECORD_LYRICS). */
  readonly lyrics: boolean;
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
  /** Where lyrics come from (LRCLIB, through the database); null when they are turned off (JUKECORD_LYRICS). */
  readonly lyrics?: LyricsSource | null;
  /** Ends the live connections of a listening link's guests (the web server's), when the link is revoked. */
  endGuests?: ((linkId: number) => void) | null;
}

/** How long a listening link may work: a day, a week, or thirty days. */
export const LISTEN_DAYS = [1, 7, 30] as const;
/** How many browsers one listening link lets in at once. */
export const GUESTS_PER_LINK = 25;
// How many listening links a server may have working at once: plenty for friends, and a bound on the table.
const LINKS_PER_SERVER = 50;

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

/** The repeat modes, for checking input from the panel, the API and the CLI. */
export const REPEAT_MODES: readonly RepeatMode[] = ['off', 'track', 'queue'];

export class Actions {
  private readonly options: ActionsOptions;
  // Wrapped's answers, by what they were asked for and the newest play they counted: the same question asked again
  // (a page reloaded, the picture's page and a card) is answered without walking the history again, until a play is
  // added. Bounded: the oldest answer goes past the limit.
  private readonly wrappedKept = new Map<string, WrappedView>();

  constructor(options: ActionsOptions) {
    this.options = options;
  }

  /** Called by the web server once it is up, so a revoked listening link ends its guests' live connections. */
  setEndGuests(end: (linkId: number) => void): void {
    this.options.endGuests = end;
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
      // The address was asked of DNS (see Resolver): a lookup was spent on it.
      if (error instanceof AddressError) throw new ActionError('invalid', REASONS.privateNetwork, { spent: true });
      // No lookup ran: every place was taken.
      if (error instanceof BusyError) throw new ActionError('unavailable', message);
      // Nothing typed: said as it is, nothing looked up. Anything else: the short reason (the resolver logged the full
      // text), after a lookup that cost what any lookup costs.
      if (/nothing to add/.test(message)) throw new ActionError('invalid', message);
      throw new ActionError('not-found', plainReason(message), { spent: true });
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
    if (player.pause()) return player.snapshot();
    // Nothing changed: either it is paused already (or will start paused), or there is nothing to pause.
    const status = player.snapshot().status;
    throw new ActionError('conflict', status === 'idle' ? 'nothing is playing' : 'it is already paused');
  }

  /**
   * Plays on: a paused track continues, and with nothing playing (after a stop, or a restart that found nothing) the
   * queue starts. One action for the one play key people expect.
   */
  resume(context: ActionContext): PlayerSnapshot {
    this.control(context);
    const player = this.options.players.get(context.guildId);
    if (player.resume() || player.play()) return player.snapshot();
    // Neither worked: there is nothing to start, a track is getting ready to play, or one is playing.
    const status = player.snapshot().status;
    throw new ActionError(
      'conflict',
      status === 'idle'
        ? 'the queue is empty'
        : status === 'loading'
          ? 'the track is getting ready'
          : 'it is already playing',
    );
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

  /**
   * A server's time in music (anyone may look): a year ("2026"), a month ("2026-03") or the last twelve months
   * ("last-12-months"), this year when none is named. Days and hours are the viewer's (`offsetMinutes` east of UTC,
   * as for the statistics).
   */
  wrapped(context: ActionContext, period?: string, offsetMinutes = 0, now = Date.now()): WrappedView {
    if (!Number.isInteger(offsetMinutes) || offsetMinutes < -720 || offsetMinutes > 840) {
      throw new ActionError('invalid', 'the time zone offset is -720 to 840 minutes');
    }
    const offsetMs = offsetMinutes * 60_000;
    const DAY = 86_400_000;
    // Today, as a day number and as a date, where the viewer is.
    const today = Math.floor((now + offsetMs) / DAY);
    const date = new Date(today * DAY);
    const year = date.getUTCFullYear();
    const asked = period ?? String(year);
    // The time's first day and the day after its last, as day numbers since the epoch (in the viewer's calendar).
    let kind: WrappedKind;
    let first: number;
    let after: number;
    const yearMatch = /^(\d{4})$/.exec(asked);
    const monthMatch = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(asked);
    if (asked === 'last-12-months') {
      // From the day after this date a year ago, through today: 365 days, or 366 across a 29th of February.
      kind = asked;
      first = Date.UTC(year - 1, date.getUTCMonth(), date.getUTCDate() + 1) / DAY;
      after = today + 1;
    } else if (yearMatch && Number(yearMatch[1]) >= 1970) {
      kind = 'year';
      first = Date.UTC(Number(yearMatch[1]), 0, 1) / DAY;
      after = Date.UTC(Number(yearMatch[1]) + 1, 0, 1) / DAY;
    } else if (monthMatch && Number(monthMatch[1]) >= 1970) {
      kind = 'month';
      first = Date.UTC(Number(monthMatch[1]), Number(monthMatch[2]) - 1, 1) / DAY;
      after = Date.UTC(Number(monthMatch[1]), Number(monthMatch[2]), 1) / DAY;
    } else {
      throw new ActionError('invalid', PERIOD_FORMS);
    }
    const since = first * DAY - offsetMs;
    const until = after * DAY - offsetMs;
    // Asked before, with no play added since and on the same day here: the same answer.
    const kept = `${context.guildId} ${asked} ${offsetMinutes} ${today} ${this.options.store.history.newest(context.guildId)}`;
    const known = this.wrappedKept.get(kept);
    if (known) return known;
    const day = (number: number) => new Date(number * DAY).toISOString().slice(0, 10);
    const raw = this.options.store.history.wrapped(context.guildId, since, until, offsetMs);
    const reach = this.options.store.history.months(context.guildId, offsetMs);
    // The history no longer goes back to the time's start: said with the day it starts from (the oldest play kept).
    const keptFrom =
      reach.full && reach.oldest !== null && reach.oldest > since
        ? day(Math.floor((reach.oldest + offsetMs) / DAY))
        : null;
    const view: WrappedView = {
      ...raw,
      // The last day is today while the time lasts (a year so far), its own last day once it is over.
      period: { kind, key: asked, from: day(first), to: day(today >= first && today < after ? today : after - 1) },
      keptFrom,
      years: [...new Set(reach.months.map((month) => month.slice(0, 4)))],
      months: reach.months,
    };
    this.wrappedKept.set(kept, view);
    if (this.wrappedKept.size > 32) this.wrappedKept.delete(this.wrappedKept.keys().next().value ?? kept);
    return view;
  }

  /** The server's settings and the roles to choose the DJ role from (anyone may look). */
  settings(context: ActionContext): SettingsView {
    const roles = this.options.directory?.roles(context.guildId) ?? null;
    const saved = this.options.store.settings.get(context.guildId);
    // A deleted role is shown as none, which is how it counts (see djRoleNow).
    const djRoleId = djRoleNow(saved.djRoleId, roles);
    // The same for a channel gone, or one the bot may no longer post in: nothing can be said there.
    const channels = this.options.directory?.textChannels?.(context.guildId) ?? [];
    const alertsChannelId = channels.some((channel) => channel.id === saved.alertsChannelId)
      ? saved.alertsChannelId
      : null;
    return { djRoleId, roles: roles ?? [], alertsChannelId, channels };
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
      lyrics: Boolean(this.options.lyrics),
    };
  }

  /**
   * Sets (or clears, with null) the text channel where jukecord tells this server about trouble: YouTube refusing it,
   * a restart by the watchdog, a disk nearly full, a track taken out of the looping queue, connections turned away,
   * a scheduled backup that failed (app/alerts.ts). Needs Manage Server.
   */
  alertsChannel(context: ActionContext, channelId: string | null): SettingsView {
    if (!context.mayManage)
      throw new ActionError('forbidden', 'only people who can manage the server can choose the alerts channel');
    if (channelId !== null) {
      // Only a channel the bot may post in: one it cannot would say nothing, and nobody would know why.
      const channels = this.options.directory?.textChannels?.(context.guildId);
      if (!channels)
        throw new ActionError('unavailable', 'jukecord runs without a Discord bot here, so there are no channels');
      if (!channels.some((channel) => channel.id === channelId))
        throw new ActionError('not-found', 'that is not a channel of this server the bot may post in');
    }
    this.options.store.settings.setAlertsChannel(context.guildId, channelId);
    return this.settings(context);
  }

  /**
   * The lyrics of the track playing now (anyone may look): kept from an earlier lookup, or asked of LRCLIB once. Only
   * the track playing: nobody can make jukecord look up anything else.
   */
  async lyrics(context: ActionContext): Promise<LyricsAnswer> {
    const source = this.options.lyrics;
    if (!source) throw new ActionError('unavailable', 'lyrics are turned off here');
    const track = this.options.players.get(context.guildId).snapshot().track;
    if (!track) throw new ActionError('conflict', 'nothing is playing');
    try {
      return await source.forTrack(track);
    } catch (error) {
      // LRCLIB down, slow, asking to wait, or too many lookups waiting: a moment later may work.
      if (error instanceof LyricsUnavailable) throw new ActionError('unavailable', error.message);
      throw error;
    }
  }

  /**
   * Stops the player when the current track ends (on), the queue staying as it is, or plays on after it (off): for
   * the whole server, whoever listens where.
   */
  stopAfter(context: ActionContext, on: boolean): PlayerSnapshot {
    this.control(context);
    const player = this.options.players.get(context.guildId);
    // Turning it on needs a track to stop after; asking for what is so already changes nothing and is no mistake.
    if (!player.setStopAfter(on) && on && player.snapshot().status === 'idle')
      throw new ActionError('conflict', 'nothing is playing');
    return player.snapshot();
  }

  /**
   * The server's listening links that still work: all of them for people who can manage the server, otherwise the
   * ones this person made (for which they must still be allowed to change the music).
   */
  listenLinks(context: ActionContext): ListenLinkRow[] {
    const links = this.options.store.listenLinks.list(context.guildId);
    if (context.mayManage) return links;
    this.control(context);
    return links.filter((link) => link.createdBy === context.userId);
  }

  /**
   * Makes a listening link to this server for 1, 7 or 30 days: anyone with it listens along without a Discord
   * account, up to GUESTS_PER_LINK browsers at once, and changes nothing. Its code is shown this once: only its
   * SHA-256 is kept.
   */
  listenLinkCreate(context: ActionContext, days: number): { code: string; link: ListenLinkRow } {
    this.control(context);
    if (!(LISTEN_DAYS as readonly number[]).includes(days))
      throw new ActionError('invalid', 'a listening link lasts 1, 7 or 30 days');
    const links = this.options.store.listenLinks;
    // Expired links go first, so they do not count against the limit.
    links.prune();
    if (links.count(context.guildId) >= LINKS_PER_SERVER) {
      throw new ActionError(
        'conflict',
        `this server has as many listening links as it allows (${LINKS_PER_SERVER}); revoke one first`,
      );
    }
    // 32 random bytes, like every secret jukecord hands out; the link carries it after a "#", which never reaches a
    // server's log or a proxy's.
    const code = randomBytes(32).toString('base64url');
    const link = links.create({
      hash: createHash('sha256').update(code).digest('hex'),
      guildId: context.guildId,
      createdBy: context.userId,
      lastsMs: days * 86_400_000,
      maxGuests: GUESTS_PER_LINK,
    });
    this.options.log.info('made a listening link', { guild: context.guildId, link: link.id, days });
    return { code, link };
  }

  /**
   * Revokes a listening link of this server: its guests are out at once, their live connections ended. Its maker may
   * (while they may change the music), and so may people who can manage the server.
   */
  listenLinkRevoke(context: ActionContext, id: number): void {
    const link = this.options.store.listenLinks.get(id);
    if (!link || link.guildId !== context.guildId)
      throw new ActionError('not-found', 'there is no such listening link here');
    const own = context.mayControl && link.createdBy === context.userId;
    if (!context.mayManage && !own) {
      throw new ActionError(
        'forbidden',
        'only its maker and people who can manage the server can revoke a listening link',
      );
    }
    this.options.store.listenLinks.remove(id);
    this.options.endGuests?.(id);
    this.options.log.info('revoked a listening link', { guild: context.guildId, link: id });
  }

  // Store errors are mistakes in the request (an unknown item, a name taken); they become "invalid" or "conflict".
  private fromStore(error: unknown): unknown {
    if (!(error instanceof StoreError)) return error;
    return new ActionError(/exists/.test(error.message) ? 'conflict' : 'invalid', error.message);
  }
}
