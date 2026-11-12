/**
 * Everything a person can do with jukecord, in one place.
 *
 * The panel, the slash commands, the HTTP API and the CLI are four ways in; each of them only reads its input, calls
 * one of these actions, and shows the result. That is what keeps them in step: a feature exists when it is an action,
 * and a test checks that every action is reachable from all four (see ACTIONS and tests/unit/parity.test.ts).
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Bus } from '../core/bus.ts';
import type { PlayerSnapshot } from '../core/player.ts';
import type { Players } from '../core/players.ts';
import type { InsertAt, QueueService } from '../core/queue.ts';
import { plainReason, REASONS } from '../core/reasons.ts';
import { isPreset, SOUND_PRESETS, type Sound, VOLUME_MAX } from '../core/sound.ts';
import type { HistoryEntry, Playlist, QueueItem, Track } from '../core/types.ts';
import type { Logger } from '../log.ts';
import { AddressError } from '../media/address.ts';
import { BusyError } from '../media/busy.ts';
import { type LyricsAnswer, type LyricsSource, LyricsUnavailable } from '../media/lyrics.ts';
import type { Resolver } from '../media/resolver.ts';
import type {
  CommunitySettings,
  HistoryStats,
  HistoryWrapped,
  ListenLinkRow,
  RepeatMode,
  Store,
} from '../store/store.ts';
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
  'wrapped',
  'alerts-channel',
  'lyrics',
  'stop-after',
  'listen-links',
  'listen-link-create',
  'listen-link-revoke',
  'stay',
  'vote-skip',
  'take-turns',
  'turns-now',
  'person-limit',
  'volume',
  'sound',
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
  /** The server's stay setting changed: the bot looks again at whether it is alone and counts down to leaving. */
  stayChanged?(guildId: string): void;
  /** The server's voice volume or preset changed: the voice stream starts again where the track is, with it. */
  soundChanged?(guildId: string): void;
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

/** A server's jukecord settings as the panel and the commands show them: the DJ role, and how people share the music. */
export interface SettingsView extends CommunitySettings {
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
  /** The votes to skip; without them (tests that do not care) Skip needs the DJ role, as it did before votes. */
  readonly votes?: SkipVotes;
  /** Where a change of a voice channel's sound is announced (the panels apply its preset); absent in some tests. */
  readonly bus?: Bus;
}

/** What a skip did: the player after it, and how the vote stands when it was a vote the track did not go by. */
export interface SkipResult {
  readonly snapshot: PlayerSnapshot;
  /** Null when the track went: a skip by someone who may change the music, or the vote that made it go. */
  readonly votes: { readonly votes: number; readonly needed: number } | null;
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

/** The highest limit of tracks per person a server may set. */
export const PERSON_LIMIT_MAX = 1000;

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
   * instead (see app/votes.ts): the track goes once half of the people listening have voted. `trackId`, when given,
   * is the track the skip is for: once another plays (people pressing together, a card left from an earlier track),
   * that one has gone already, and nothing more goes; no vote is cast against the next.
   */
  skip(context: ActionContext, trackId?: number): SkipResult {
    const player = this.options.players.get(context.guildId);
    const votes = this.options.votes;
    const voting = !context.mayControl && votes && context.userId !== null && this.voteSkipApplies(context.guildId);
    // Anyone else without the DJ role is refused, as for every other change of the music.
    if (!voting) this.control(context);
    // Meant for a track that has gone by now: the answer is the player as it is.
    if (trackId !== undefined && player.snapshot().track?.id !== trackId) {
      return { snapshot: player.snapshot(), votes: null };
    }
    // Someone without the DJ role where Skip is a vote: a vote, which skips the track once there are enough.
    if (voting && votes && context.userId !== null) {
      if (player.snapshot().track === null) throw new ActionError('conflict', 'nothing is playing');
      const result = votes.vote(context.guildId, context.userId);
      return {
        snapshot: player.snapshot(),
        votes: result.skipped ? null : { votes: result.votes, needed: result.needed },
      };
    }
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
    // How the server's people share the music, beside the DJ role and the alerts channel.
    return {
      djRoleId,
      roles: roles ?? [],
      alertsChannelId,
      channels,
      ...this.options.store.settings.community(context.guildId),
    };
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
    // A whole number up to a thousand, as the API and the slash command take it (the queue's own default size).
    if (!Number.isInteger(tracks) || tracks < 0 || tracks > PERSON_LIMIT_MAX)
      throw new ActionError('invalid', `the limit is 0 (none) to ${PERSON_LIMIT_MAX} tracks`);
    this.options.store.settings.setCommunity(context.guildId, { personLimit: tracks });
    return this.settings(context);
  }

  /**
   * The voice channel's volume, 0 to 200 percent; each browser keeps its own. A change of the music: it needs what any
   * change needs (the DJ role where one is set).
   */
  volume(context: ActionContext, percent: number): Sound {
    this.control(context);
    if (!Number.isInteger(percent) || percent < 0 || percent > VOLUME_MAX)
      throw new ActionError('invalid', `the volume is 0 to ${VOLUME_MAX} percent`);
    const before = this.currentSound(context.guildId);
    this.options.store.settings.setCommunity(context.guildId, { volume: percent });
    return this.soundChanged(context.guildId, before);
  }

  /** The voice channel's sound preset, which browsers listening along apply too (see core/sound.ts). */
  sound(context: ActionContext, preset: string): Sound {
    this.control(context);
    if (!isPreset(preset)) throw new ActionError('invalid', `the sound is one of ${SOUND_PRESETS.join(', ')}`);
    const before = this.currentSound(context.guildId);
    this.options.store.settings.setCommunity(context.guildId, { sound: preset });
    return this.soundChanged(context.guildId, before);
  }

  /** A server's voice sound now: its volume and preset (anyone may look; the panels get it live). */
  currentSound(guildId: string): Sound {
    const settings = this.options.store.settings.community(guildId);
    return { volume: settings.volume, preset: settings.sound };
  }

  // The sound may have changed: the voice stream takes it where the track is, and the panels hear it (their browsers
  // apply the preset). The same sound again changes nothing, and starts nothing again.
  private soundChanged(guildId: string, before: Sound): Sound {
    const now = this.currentSound(guildId);
    if (now.volume === before.volume && now.preset === before.preset) return now;
    this.options.voice?.soundChanged?.(guildId);
    this.options.bus?.emit('sound', { guildId });
    return now;
  }
}
