/**
 * Everything a person can do with jukecord, in one place.
 *
 * The panel, the slash commands, the HTTP API and the CLI are four ways in; each of them only reads its input, calls
 * one of these actions, and shows the result. That is what keeps them in step: a feature exists when it is an action,
 * and a test checks that every action is reachable from all four (see ACTIONS and tests/unit/parity.test.ts).
 *
 * An action that changes a server takes that server's turn for the change (core/lanes.ts), so two changes of one
 * server never interleave whichever way they came in; reading needs no turn.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Bus } from '../core/bus.ts';
import type { GuildLanes } from '../core/lanes.ts';
import type { PlayerSnapshot } from '../core/player.ts';
import type { Players } from '../core/players.ts';
import type { InsertAt, QueueService } from '../core/queue.ts';
import { plainReason, REASONS } from '../core/reasons.ts';
import { isPreset, SOUND_PRESETS, type Sound, VOLUME_MAX } from '../core/sound.ts';
import {
  discordUserId,
  type HistoryEntry,
  type LikedTrack,
  type NewTrack,
  type Playlist,
  type QueueItem,
  type Track,
} from '../core/types.ts';
import type { Logger } from '../log.ts';
import { type AddressCheck, AddressError } from '../media/address.ts';
import { BATCH_MOST, BatchLookups } from '../media/batch.ts';
import { BusyError } from '../media/busy.ts';
import { LinkError, type Links } from '../media/links.ts';
import { type LyricsAnswer, type LyricsSource, LyricsUnavailable } from '../media/lyrics.ts';
import type { Resolver } from '../media/resolver.ts';
import type { Search } from '../media/search.ts';
import { canonicalSource, parseInput, youtubeVideoId } from '../media/source.ts';
import type {
  AutoplayMode,
  CommunitySettings,
  HistoryStats,
  HistoryWrapped,
  ListenLinkRow,
  RepeatMode,
  Store,
} from '../store/store.ts';
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

// How long a refusal of a busy moment says to wait: every lookup slot taken frees one in a second or two; a list of the
// person's own being added takes a while (a hundred lookups at most).
const BUSY_RETRY_MS = 2000;
const LIST_RETRY_MS = 10_000;

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
  /**
   * How long until asking again may work, for a refusal of a busy moment (every lookup slot taken, LRCLIB down): the
   * web server sends it as Retry-After, which the command line turns into its own exit code. Null for any other.
   */
  readonly retryAfterMs: number | null;
  /**
   * For a change of the host's settings their rules refuse (src/settings): each problem with the settings it names, so
   * the page shows each under its own; null for any other refusal.
   */
  readonly problems: readonly SettingProblemOf[] | null;

  constructor(
    code: ActionErrorCode,
    message: string,
    options: { spent?: boolean; retryAfterMs?: number; problems?: readonly SettingProblemOf[] } = {},
  ) {
    super(message);
    this.code = code;
    this.spent = options.spent ?? false;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.problems = options.problems ?? null;
  }
}

/** A problem of a refused change of settings, and the settings it names (see ActionError.problems). */
export interface SettingProblemOf {
  readonly names: readonly string[];
  readonly message: string;
}

/** Joining and leaving voice, which only the Discord side can do; absent when jukecord runs without a bot token. */
export interface VoiceControl {
  /** Joins a voice channel of the server (the caller's own channel when `channelId` is null). */
  join(guildId: string, channelId: string | null, userId: string | null): Promise<{ channelId: string; name: string }>;
  /** Leaves the server's voice channel; false when it was not in one. */
  leave(guildId: string): boolean | Promise<boolean>;
  /** The voice channel the bot is in, or null. */
  channel(guildId: string): { channelId: string; name: string } | null;
  /**
   * The server's voice channels the bot may join, in Discord's order, as one viewer may see them: a member sees the
   * channels they can see themselves, anyone else (the panels' shared updates) the ones everybody in the server can
   * see, and `all` (the host) every one.
   */
  channels(guildId: string, viewer: { userId: string | null; all: boolean }): VoiceChannelInfo[];
  /** The server's stay setting changed: the bot looks again at whether it is alone and counts down to leaving. */
  stayChanged?(guildId: string): void | Promise<void>;
  /** The server's voice volume or preset changed: the voice stream starts again where the track is, with it. */
  soundChanged?(guildId: string): void | Promise<void>;
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
  /** The servers' lanes: every change of a server takes its turn there (shared with the players and the queue). */
  readonly lanes: GuildLanes;
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
  /** Searching YouTube for words, to pick from (absent: searching is refused as not set up). */
  readonly search?: Search;
  /** What picks a track when a queue runs out (told when a person stops the music); absent in tests that need none. */
  readonly autoplay?: Autoplay;
  /** The turns of lookups that come in lists (an imported playlist's lines); one of its own when absent. */
  readonly batch?: BatchLookups;
  /** The check of addresses a file brings (private networks refused); none: every address passes. */
  readonly checkAddress?: AddressCheck;
  /** Links of Deezer, Spotify and Apple Music, read and found on YouTube (absent: they are addresses like any). */
  readonly links?: Links;
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
  /** Tracks that did not fit because the person reached the server's limit of tracks per person. */
  readonly skippedLimit: number;
  /** Tracks of a link from another service (Deezer, Spotify, Apple Music) not found on YouTube. */
  readonly skippedNotFound: number;
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
  // Wrapped's answers, by what they were asked for and the newest play they counted: the same question asked again
  // (a page reloaded, the picture's page and a card) is answered without walking the history again, until a play is
  // added. Bounded: the oldest answer goes past the limit.
  private readonly wrappedKept = new Map<string, WrappedView>();
  // The turns of lookups that come in lists, shared by every import (and the links of other services).
  private readonly batch: BatchLookups;

  // The host's limits and where lyrics come from: the options' at first, changed by the settings while jukecord runs
  // (JUKECORD_QUEUE_MAX, JUKECORD_TRACK_MAX and JUKECORD_LYRICS apply at once).
  private queueMax: number;
  private trackMaxMs: number;
  private lyricsSource: LyricsSource | null;

  constructor(options: ActionsOptions) {
    this.options = options;
    this.batch = options.batch ?? new BatchLookups();
    this.queueMax = options.queueMax ?? 1000;
    this.trackMaxMs = options.trackMaxMs ?? 3 * 3_600_000;
    this.lyricsSource = options.lyrics ?? null;
  }

  /** The longest queue and the longest track from now on: a change refused before may be taken now, and the other way. */
  setLimits(limits: { readonly queueMax: number; readonly trackMaxMs: number }): void {
    this.queueMax = limits.queueMax;
    this.trackMaxMs = limits.trackMaxMs;
  }

  /** Where lyrics come from from now on; null turns them off (nothing more is asked of LRCLIB). */
  setLyrics(source: LyricsSource | null): void {
    this.lyricsSource = source;
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

  // A change of a server, in that server's turn (see core/lanes.ts): one change of a server at a time, in the order
  // asked, the player's own changes included. What takes long (a lookup on the site) is done before, outside it, so a
  // server's music never waits for someone's search.
  private change<T>(guildId: string, task: () => T | Promise<T>): Promise<T> {
    return this.options.lanes.run(guildId, task);
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
      // No lookup ran: every place was taken, for a moment.
      if (error instanceof BusyError) throw new ActionError('unavailable', message, { retryAfterMs: BUSY_RETRY_MS });
      // Nothing typed: said as it is, nothing looked up. Anything else: the short reason (the resolver logged the full
      // text), after a lookup that cost what any lookup costs.
      if (/nothing to add/.test(message)) throw new ActionError('invalid', message);
      throw new ActionError('not-found', plainReason(message), { spent: true });
    }
  }

  /** Adds what an address or search finds (all of a playlist) and starts playing if nothing was. */
  async add(context: ActionContext, input: string, at: InsertAt = 'end', signal?: AbortSignal): Promise<AddResult> {
    this.control(context);
    if (this.options.links?.handles(input)) return this.addLink(context, input, at, false, signal);
    const tracks = await this.lookup(input, signal, context);
    // Looked up outside the server's turn; queued and started in one.
    return this.change(context.guildId, async () => {
      const result = await this.enqueue(context, tracks, at);
      await this.options.players.get(context.guildId).play();
      return result;
    });
  }

  // Queues what fits: tracks over the length limit are left out, the rest up to the queue limit, and then up to the
  // person's own limit where the server has one. Nothing fitting at all is an error, so a person does not see "added"
  // for an add that did nothing. Where the server's people take turns, tracks added at the end go in turn. Called in
  // the server's turn: the room it counts is still there when the tracks go in.
  private async enqueue(context: ActionContext, tracks: readonly Track[], at: InsertAt): Promise<AddResult> {
    const trackMax = this.trackMaxMs;
    const queueMax = this.queueMax;
    // Unknown lengths pass: most such tracks are ordinary songs from sites that do not say.
    const short = tracks.filter((track) => track.durationMs === null || track.durationMs <= trackMax);
    const room = Math.max(0, queueMax - (await this.options.queue.size(context.guildId)));
    const roomy = short.slice(0, room);
    // A person's own room under the server's limit of tracks per person; the host (no Discord ID) has none.
    const community = await this.options.store.settings.community(context.guildId);
    const limit = community.personLimit;
    const own =
      context.userId !== null && limit > 0
        ? Math.max(0, limit - (await this.options.queue.countBy(context.guildId, context.userId)))
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
    let items: QueueItem[];
    if (at === 'end' && community.takeTurns) {
      // In turns: the track playing counts as its person's turn under way; autoplay's tracks are nobody's turn, and
      // stay after people's (see QueueService.addInTurns).
      const snapshot = this.options.players.get(context.guildId).snapshot();
      items = await this.options.queue.addInTurns(
        context.guildId,
        ids,
        context.userId,
        snapshot.track ? { owner: snapshot.addedBy } : null,
      );
    } else {
      // "At the end", for a person, is before the tracks autoplay queued to fill a queue that ran out: those play
      // after what people add, and none of them is taken away.
      const place = at === 'end' ? ((await this.options.store.queue.autoplayTail(context.guildId)) ?? 'end') : at;
      items = await this.options.queue.add(context.guildId, ids, place, context.userId);
    }
    return { items, skippedTooLong, skippedFull, skippedLimit, skippedNotFound: 0 };
  }

  // A link of Deezer, Spotify or Apple Music: its tracks, found on YouTube, go into the queue as they are found and in
  // the link's order, so the first one plays while the rest are searched (see media/links.ts). `now` plays the first
  // at once, as Play now does. Each part found is queued in a turn of its own (the turns keep the link's order), and
  // the searching goes on outside them.
  private async addLink(
    context: ActionContext,
    input: string,
    at: InsertAt,
    now: boolean,
    signal?: AbortSignal,
  ): Promise<AddResult> {
    const links = this.options.links;
    if (!links) throw new ActionError('unavailable', 'links of other services are not read here');
    const player = this.options.players.get(context.guildId);
    const items: QueueItem[] = [];
    let skippedTooLong = 0;
    let skippedFull = 0;
    // Held to the server's limit of tracks per person as any add is (see enqueue).
    let skippedLimit = 0;
    let started = false;
    const take = async (tracks: Track[]): Promise<void> => {
      // After this link's last track still waiting, so the link's order holds whatever else changes meanwhile (one
      // that started playing leaves the next place to the rest); "at the end" stays at the end.
      let place: InsertAt = at;
      const last = items.at(-1);
      if (last && at !== 'end') {
        const waiting = await this.options.store.queue.get(last.id);
        place = waiting && waiting.guildId === context.guildId ? waiting.position + 1 : 'next';
      }
      let part: AddResult;
      try {
        part = await this.enqueue(context, tracks, place);
      } catch (error) {
        // Nothing of this part fitted: counted, and the link goes on (a later part may be shorter). The person's limit
        // reached is a conflict too, told apart from a full queue by what it says.
        if (error instanceof ActionError && error.code === 'conflict' && error.message.startsWith('each person may'))
          skippedLimit += tracks.length;
        else if (error instanceof ActionError && error.code === 'conflict') skippedFull += tracks.length;
        else if (error instanceof ActionError && error.code === 'invalid') skippedTooLong += tracks.length;
        else throw error;
        return;
      }
      items.push(...part.items);
      skippedTooLong += part.skippedTooLong;
      skippedFull += part.skippedFull;
      skippedLimit += part.skippedLimit;
      if (!started) {
        started = true;
        // The first track found plays now (the current one skipped), or starts the player if nothing played.
        if (now) {
          if (!(await player.play())) await player.skip();
        } else {
          await player.play();
        }
      }
    };
    // The parts handed on while the link is read, each queued in the server's turn; all of them are done before the
    // answer, which counts what they queued.
    const parts: Promise<void>[] = [];
    const each = (tracks: Track[]): void => {
      const part = this.change(context.guildId, () => take(tracks));
      // Waited for below with the others; marked as handled now, so a failure is not called unhandled meanwhile.
      part.catch(() => {});
      parts.push(part);
    };
    let notFound: number;
    try {
      notFound = (await links.resolve(input, { who: context.userId, ...(signal ? { signal } : {}), each })).notFound;
    } catch (error) {
      // What was found before the failure is in the queue already, as it was before parts took turns.
      await Promise.allSettled(parts);
      if (error instanceof LinkError) throw new ActionError(error.code, error.message);
      if (error instanceof BusyError)
        throw new ActionError('unavailable', error.message, { retryAfterMs: BUSY_RETRY_MS });
      throw error;
    }
    // A part that failed for another reason than the queue's limits fails the add, as it did.
    await Promise.all(parts);
    if (items.length === 0) {
      if (skippedFull > 0) throw new ActionError('conflict', `the queue is full (${this.queueMax} tracks)`);
      if (skippedLimit > 0) {
        const limit = (await this.options.store.settings.community(context.guildId)).personLimit;
        throw new ActionError('conflict', `each person may have ${limit} tracks in the queue here`);
      }
      if (skippedTooLong > 0)
        throw new ActionError('invalid', `longer than the ${Math.round(this.trackMaxMs / 60_000)} minute limit`);
      throw new ActionError('not-found', 'none of its tracks was found on YouTube');
    }
    return { items, skippedTooLong, skippedFull, skippedLimit, skippedNotFound: notFound };
  }

  /** Puts what an input finds first and plays it now; the current track is skipped. */
  async playNow(context: ActionContext, input: string, signal?: AbortSignal): Promise<AddResult> {
    this.control(context);
    if (this.options.links?.handles(input)) return this.addLink(context, input, 'next', true, signal);
    const tracks = await this.lookup(input, signal, context);
    return this.change(context.guildId, async () => {
      const result = await this.enqueue(context, tracks, 'next');
      const player = this.options.players.get(context.guildId);
      // Idle: play starts the first of the new items. Otherwise skipping moves on to it.
      if (!(await player.play())) await player.skip();
      return result;
    });
  }

  /** Sets what happens at the end of a track: off, the same track again, or the queue looping. */
  async repeat(context: ActionContext, mode: string): Promise<PlayerSnapshot> {
    this.control(context);
    if (!REPEAT_MODES.includes(mode as RepeatMode))
      throw new ActionError('invalid', `repeat is one of ${REPEAT_MODES.join(', ')}`);
    return this.change(context.guildId, async () => {
      const player = this.options.players.get(context.guildId);
      await player.setRepeat(mode as RepeatMode);
      return player.snapshot();
    });
  }

  /**
   * Moves to the next track. Where the server has a DJ role and votes on, Skip from someone without the role is a vote
   * instead (see app/votes.ts): the track goes once half of the people listening have voted. `trackId`, when given,
   * is the track the skip is for: once another plays (people pressing together, a card left from an earlier track),
   * that one has gone already, and nothing more goes; no vote is cast against the next.
   */
  skip(context: ActionContext, trackId?: number): Promise<SkipResult> {
    return this.change(context.guildId, async () => {
      const player = this.options.players.get(context.guildId);
      const votes = this.options.votes;
      const voting =
        !context.mayControl && votes && context.userId !== null && (await this.voteSkipApplies(context.guildId));
      // Anyone else without the DJ role is refused, as for every other change of the music.
      if (!voting) this.control(context);
      // Meant for a track that has gone by now: the answer is the player as it is.
      if (trackId !== undefined && player.snapshot().track?.id !== trackId) {
        return { snapshot: player.snapshot(), votes: null };
      }
      // Someone without the DJ role where Skip is a vote: a vote, which skips the track once there are enough.
      if (voting && votes && context.userId !== null) {
        if (player.snapshot().track === null) throw new ActionError('conflict', 'nothing is playing');
        const result = await votes.vote(context.guildId, context.userId);
        return {
          snapshot: player.snapshot(),
          votes: result.skipped ? null : { votes: result.votes, needed: result.needed },
        };
      }
      if (!(await player.skip())) throw new ActionError('conflict', 'nothing is playing');
      return { snapshot: player.snapshot(), votes: null };
    });
  }

  /** Drops the current track without counting it as played. */
  async removeCurrent(context: ActionContext): Promise<PlayerSnapshot> {
    this.control(context);
    return this.change(context.guildId, async () => {
      const player = this.options.players.get(context.guildId);
      if (!(await player.removeCurrent())) throw new ActionError('conflict', 'nothing is playing');
      return player.snapshot();
    });
  }

  async pause(context: ActionContext): Promise<PlayerSnapshot> {
    this.control(context);
    return this.change(context.guildId, async () => {
      const player = this.options.players.get(context.guildId);
      if (await player.pause()) return player.snapshot();
      // Nothing changed: either it is paused already (or will start paused), or there is nothing to pause.
      const status = player.snapshot().status;
      throw new ActionError('conflict', status === 'idle' ? 'nothing is playing' : 'it is already paused');
    });
  }

  /**
   * Plays on: a paused track continues, and with nothing playing (after a stop, or a restart that found nothing) the
   * queue starts. One action for the one play key people expect.
   */
  async resume(context: ActionContext): Promise<PlayerSnapshot> {
    this.control(context);
    return this.change(context.guildId, async () => {
      const player = this.options.players.get(context.guildId);
      if ((await player.resume()) || (await player.play())) return player.snapshot();
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
    });
  }

  /** Moves to a place in the current track, in milliseconds from the start. */
  async seek(context: ActionContext, positionMs: number): Promise<PlayerSnapshot> {
    this.control(context);
    if (!Number.isFinite(positionMs) || positionMs < 0)
      throw new ActionError('invalid', 'the position must be 0 or more');
    return this.change(context.guildId, async () => {
      const player = this.options.players.get(context.guildId);
      if (!(await player.seek(positionMs))) throw new ActionError('conflict', 'nothing is playing');
      return player.snapshot();
    });
  }

  /** Stops playing; the queue stays. Autoplay stops with it until a track starts again. */
  async stop(context: ActionContext): Promise<PlayerSnapshot> {
    this.control(context);
    return this.change(context.guildId, async () => {
      const player = this.options.players.get(context.guildId);
      if (!(await player.stop())) throw new ActionError('conflict', 'nothing is playing');
      this.options.autoplay?.stopped(context.guildId);
      return player.snapshot();
    });
  }

  /** What plays now and where (anyone may look). */
  nowPlaying(context: ActionContext): PlayerSnapshot {
    return this.options.players.get(context.guildId).snapshot();
  }

  /** The queue in play order, with its change counter. */
  async queue(context: ActionContext): Promise<{ items: QueueItem[]; version: number }> {
    return {
      items: await this.options.queue.list(context.guildId),
      version: this.options.queue.version(context.guildId),
    };
  }

  async remove(context: ActionContext, itemId: number): Promise<void> {
    this.control(context);
    await this.change(context.guildId, async () => {
      if (!(await this.options.queue.remove(context.guildId, itemId)))
        throw new ActionError('not-found', 'that track is no longer in the queue');
    });
  }

  /** Moves a queued track to a position (0 is next). */
  async move(context: ActionContext, itemId: number, index: number): Promise<void> {
    this.control(context);
    await this.change(context.guildId, async () => {
      try {
        await this.options.queue.move(context.guildId, itemId, index);
      } catch (error) {
        throw this.fromStore(error);
      }
    });
  }

  /** Plays a queued track now: it moves to the front and the current track is skipped. */
  async jump(context: ActionContext, itemId: number): Promise<PlayerSnapshot> {
    this.control(context);
    return this.change(context.guildId, async () => {
      const player = this.options.players.get(context.guildId);
      try {
        await this.options.queue.move(context.guildId, itemId, 0);
      } catch (error) {
        throw this.fromStore(error);
      }
      // Idle: play starts it. Otherwise skipping moves on to it, now first in the queue.
      if (!(await player.play())) await player.skip();
      return player.snapshot();
    });
  }

  async shuffle(context: ActionContext): Promise<void> {
    this.control(context);
    await this.change(context.guildId, () => this.options.queue.shuffle(context.guildId));
  }

  /** Removes later copies of tracks queued twice; returns how many went. */
  async dedupe(context: ActionContext): Promise<number> {
    this.control(context);
    return this.change(context.guildId, () => this.options.queue.dedupe(context.guildId));
  }

  /** Empties the queue; returns how many tracks were in it. */
  async clear(context: ActionContext): Promise<number> {
    this.control(context);
    return this.change(context.guildId, () => this.options.queue.clear(context.guildId));
  }

  /** Played tracks, newest first; `beforeId` pages back. */
  history(context: ActionContext, limit = 50, beforeId?: number): Promise<HistoryEntry[]> {
    // Bounded: a client asking for a million rows gets a page.
    const bounded = Math.min(Math.max(1, Math.floor(limit)), 200);
    return this.options.store.history.list(context.guildId, bounded, beforeId);
  }

  playlists(context: ActionContext): Promise<Playlist[]> {
    return this.options.store.playlists.list(context.guildId);
  }

  /**
   * Saves the current track and the queue, in play order, under a name (replacing a list of that name), and says
   * whether it replaced one, which the bot says ("Replaced" rather than "Saved").
   */
  async playlistSave(context: ActionContext, name: string): Promise<Playlist & { readonly replaced: boolean }> {
    this.control(context);
    return this.change(context.guildId, async () => {
      const current = this.options.players.get(context.guildId).snapshot().track;
      const queued = (await this.options.queue.list(context.guildId)).map((item) => item.track.id);
      const ids = current ? [current.id, ...queued] : queued;
      if (ids.length === 0) throw new ActionError('invalid', 'there is nothing to save: the queue is empty');
      try {
        // The list that will be replaced, found by the store's own match of names (as load, rename, delete and import
        // find one), just before the save: a match made apart from the store's (the bot compared the names itself)
        // can say "Saved" over a list the store replaced.
        const replaced = (await this.options.store.playlists.find(context.guildId, name)) !== null;
        return { ...(await this.options.store.playlists.save(context.guildId, name, ids, context.userId)), replaced };
      } catch (error) {
        throw this.fromStore(error);
      }
    });
  }

  /** Adds a saved list to the queue and starts playing if nothing was. */
  async playlistLoad(context: ActionContext, name: string, at: InsertAt = 'end'): Promise<AddResult> {
    this.control(context);
    return this.change(context.guildId, async () => {
      const playlist = await this.options.store.playlists.find(context.guildId, name);
      if (!playlist) throw new ActionError('not-found', `there is no playlist named "${name.trim()}"`);
      const result = await this.enqueue(context, await this.options.store.playlists.tracks(playlist.id), at);
      await this.options.players.get(context.guildId).play();
      return result;
    });
  }

  async playlistRename(context: ActionContext, name: string, newName: string): Promise<Playlist> {
    this.control(context);
    return this.change(context.guildId, async () => {
      const playlist = await this.options.store.playlists.find(context.guildId, name);
      if (!playlist) throw new ActionError('not-found', `there is no playlist named "${name.trim()}"`);
      try {
        return await this.options.store.playlists.rename(playlist.id, newName);
      } catch (error) {
        throw this.fromStore(error);
      }
    });
  }

  async playlistDelete(context: ActionContext, name: string): Promise<void> {
    this.control(context);
    await this.change(context.guildId, async () => {
      const playlist = await this.options.store.playlists.find(context.guildId, name);
      if (!playlist || !(await this.options.store.playlists.remove(playlist.id))) {
        throw new ActionError('not-found', `there is no playlist named "${name.trim()}"`);
      }
    });
  }

  /** Joins a voice channel (the caller's own when none is named). Connecting takes seconds: not in the server's turn. */
  async join(context: ActionContext, channelId: string | null): Promise<{ channelId: string; name: string }> {
    this.control(context);
    const voice = this.options.voice;
    if (!voice)
      throw new ActionError('unavailable', 'jukecord runs without a Discord bot here, so it cannot join voice');
    // The person's own channel and whether they may go to the one named are Discord's to say: a member of the host's
    // identity provider is no Discord user, and joins as a friend does.
    return voice.join(context.guildId, channelId, discordUserId(context.userId));
  }

  async leave(context: ActionContext): Promise<void> {
    this.control(context);
    await this.change(context.guildId, async () => {
      const voice = this.options.voice;
      if (!(voice && (await voice.leave(context.guildId))))
        throw new ActionError('conflict', 'the bot is not in a voice channel');
    });
  }

  /** The voice channels the bot could join, and which one it is in (anyone may look). */
  voiceChannels(context: ActionContext): {
    current: { channelId: string; name: string } | null;
    channels: VoiceChannelInfo[];
  } {
    const voice = this.options.voice;
    // Browser-only: there are no channels, which is an answer, not an error (the panel shows "no Discord").
    if (!voice) return { current: null, channels: [] };
    // The host (no Discord user, may manage) sees every channel, and so does an admin member (no Discord user either);
    // a Discord user, the ones they can see themselves.
    const discordUser = discordUserId(context.userId);
    const viewer = { userId: discordUser, all: discordUser === null && context.mayManage };
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
  async stats(context: ActionContext, days = 30, offsetMinutes = 0, now = Date.now()): Promise<StatsView> {
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
    const raw = await this.options.store.history.stats(context.guildId, since, offsetMs);
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
  async wrapped(context: ActionContext, period?: string, offsetMinutes = 0, now = Date.now()): Promise<WrappedView> {
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
    const kept = `${context.guildId} ${asked} ${offsetMinutes} ${today} ${await this.options.store.history.newest(context.guildId)}`;
    const known = this.wrappedKept.get(kept);
    if (known) return known;
    const day = (number: number) => new Date(number * DAY).toISOString().slice(0, 10);
    const raw = await this.options.store.history.wrapped(context.guildId, since, until, offsetMs);
    const reach = await this.options.store.history.months(context.guildId, offsetMs);
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
  async settings(context: ActionContext): Promise<SettingsView> {
    const roles = this.options.directory?.roles(context.guildId) ?? null;
    const saved = await this.options.store.settings.get(context.guildId);
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
      ...(await this.options.store.settings.community(context.guildId)),
    };
  }

  /** Sets (or clears, with null) the role that may change the music. Needs Manage Server. */
  async djRole(context: ActionContext, roleId: string | null): Promise<SettingsView> {
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
    return this.change(context.guildId, async () => {
      await this.options.store.settings.setDjRole(context.guildId, roleId);
      // Whether Skip is a vote depends on the DJ role: votes under way end, and the panels hear the new state.
      this.options.votes?.reset(context.guildId);
      return this.settings(context);
    });
  }

  /** The version and whether Discord is connected (anyone may look; no server needed). */
  status(): Status {
    return {
      version: VERSION,
      discord: this.options.discordReady?.() ?? false,
      uptimeMs: Date.now() - (this.options.startedAt ?? Date.now()),
      lyrics: this.lyricsSource !== null,
    };
  }

  /**
   * Sets (or clears, with null) the text channel where jukecord tells this server about trouble: YouTube refusing it,
   * a restart by the watchdog, a disk nearly full, a track taken out of the looping queue, connections turned away,
   * a scheduled backup that failed (app/alerts.ts). Needs Manage Server.
   */
  async alertsChannel(context: ActionContext, channelId: string | null): Promise<SettingsView> {
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
    return this.change(context.guildId, async () => {
      await this.options.store.settings.setAlertsChannel(context.guildId, channelId);
      return this.settings(context);
    });
  }

  /**
   * The lyrics of the track playing now (anyone may look): kept from an earlier lookup, or asked of LRCLIB once. Only
   * the track playing: nobody can make jukecord look up anything else.
   */
  async lyrics(context: ActionContext): Promise<LyricsAnswer> {
    const source = this.lyricsSource;
    if (!source) throw new ActionError('unavailable', 'lyrics are turned off here');
    const track = this.options.players.get(context.guildId).snapshot().track;
    if (!track) throw new ActionError('conflict', 'nothing is playing');
    try {
      return await source.forTrack(track);
    } catch (error) {
      // LRCLIB down, slow, asking to wait, or too many lookups waiting: a moment later may work.
      if (error instanceof LyricsUnavailable)
        throw new ActionError('unavailable', error.message, { retryAfterMs: error.retryAfterMs });
      throw error;
    }
  }

  /**
   * Stops the player when the current track ends (on), the queue staying as it is, or plays on after it (off): for
   * the whole server, whoever listens where.
   */
  async stopAfter(context: ActionContext, on: boolean): Promise<PlayerSnapshot> {
    this.control(context);
    return this.change(context.guildId, async () => {
      const player = this.options.players.get(context.guildId);
      // Turning it on needs a track to stop after; asking for what is so already changes nothing and is no mistake.
      if (!(await player.setStopAfter(on)) && on && player.snapshot().status === 'idle')
        throw new ActionError('conflict', 'nothing is playing');
      return player.snapshot();
    });
  }

  /**
   * The server's listening links that still work: all of them for people who can manage the server, otherwise the
   * ones this person made (for which they must still be allowed to change the music).
   */
  async listenLinks(context: ActionContext): Promise<ListenLinkRow[]> {
    const links = await this.options.store.listenLinks.list(context.guildId);
    if (context.mayManage) return links;
    this.control(context);
    return links.filter((link) => link.createdBy === context.userId);
  }

  /**
   * Makes a listening link to this server for 1, 7 or 30 days: anyone with it listens along without a Discord
   * account, up to GUESTS_PER_LINK browsers at once, and changes nothing. Its code is shown this once: only its
   * SHA-256 is kept.
   */
  async listenLinkCreate(context: ActionContext, days: number): Promise<{ code: string; link: ListenLinkRow }> {
    this.control(context);
    if (!(LISTEN_DAYS as readonly number[]).includes(days))
      throw new ActionError('invalid', 'a listening link lasts 1, 7 or 30 days');
    // The count and the new link in one turn: two made at once cannot both pass the limit.
    return this.change(context.guildId, async () => {
      const links = this.options.store.listenLinks;
      // Expired links go first, so they do not count against the limit.
      await links.prune();
      if ((await links.count(context.guildId)) >= LINKS_PER_SERVER) {
        throw new ActionError(
          'conflict',
          `this server has as many listening links as it allows (${LINKS_PER_SERVER}); revoke one first`,
        );
      }
      // 32 random bytes, like every secret jukecord hands out; the link carries it after a "#", which never reaches a
      // server's log or a proxy's.
      const code = randomBytes(32).toString('base64url');
      const link = await links.create({
        hash: createHash('sha256').update(code).digest('hex'),
        guildId: context.guildId,
        createdBy: context.userId,
        lastsMs: days * 86_400_000,
        maxGuests: GUESTS_PER_LINK,
      });
      this.options.log.info('made a listening link', { guild: context.guildId, link: link.id, days });
      return { code, link };
    });
  }

  /**
   * Revokes a listening link of this server: its guests are out at once, their live connections ended. Its maker may
   * (while they may change the music), and so may people who can manage the server.
   */
  async listenLinkRevoke(context: ActionContext, id: number): Promise<void> {
    await this.change(context.guildId, async () => {
      const link = await this.options.store.listenLinks.get(id);
      if (!link || link.guildId !== context.guildId)
        throw new ActionError('not-found', 'there is no such listening link here');
      const own = context.mayControl && link.createdBy === context.userId;
      if (!context.mayManage && !own) {
        throw new ActionError(
          'forbidden',
          'only its maker and people who can manage the server can revoke a listening link',
        );
      }
      await this.options.store.listenLinks.remove(id);
      this.options.endGuests?.(id);
      this.options.log.info('revoked a listening link', { guild: context.guildId, link: id });
    });
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
      if (error instanceof BusyError)
        throw new ActionError('unavailable', error.message, { retryAfterMs: BUSY_RETRY_MS });
      throw new ActionError('not-found', plainReason(error instanceof Error ? error.message : String(error)));
    }
  }

  /**
   * A track a search showed in the last half hour, by its address, or null for an address no recent search found: the
   * add field's list shows its picture from jukecord (web/server.ts). Only for people who may search.
   */
  async searched(context: ActionContext, address: string): Promise<NewTrack | null> {
    this.control(context);
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      // Not an address at all: no search found it.
      return null;
    }
    // By the canonical address, which is what the search kept it by (Search.recent).
    return (await this.options.search?.recent(canonicalSource(url))) ?? null;
  }

  /** The tracks this login liked, newest first (anyone may look at their own). */
  likes(context: ActionContext): Promise<LikedTrack[]> {
    return this.options.store.likes.list(likesOwner(context));
  }

  /**
   * Likes a track for this login. A like is personal, so the DJ role is not needed; the track must be one this server
   * shows (playing, queued, played here or in one of its playlists): a track number from elsewhere would show another
   * server's music in the list. The checks and the like are one transaction: a login's likes are its own across
   * every server, so no server's turn covers them, and two likes at once cannot both pass the limit.
   */
  like(context: ActionContext, trackId: number): Promise<LikedTrack> {
    const store = this.options.store;
    return store.transaction(async () => {
      const track = await store.tracks.get(trackId);
      // Each question one lookup by an index, as for the covers (web/server.ts): the player, the queue, the history,
      // the playlists.
      const here =
        track !== null &&
        (this.options.players.existing(context.guildId)?.snapshot().track?.id === trackId ||
          (await this.options.queue.contains(context.guildId, trackId)) ||
          (await store.history.has(context.guildId, trackId)) ||
          (await store.playlists.has(context.guildId, trackId)));
      if (!track || !here)
        throw new ActionError('not-found', 'that track is not playing, queued, played or in a playlist in this server');
      const owner = likesOwner(context);
      if (!(await store.likes.has(owner, trackId)) && (await store.likes.count(owner)) >= LIKES_MAX)
        throw new ActionError('conflict', `your likes are full (${LIKES_MAX} tracks)`);
      await store.likes.add(owner, trackId);
      const liked = (await store.likes.list(owner)).find((entry) => entry.track.id === trackId);
      return liked ?? { track, likedAt: Date.now() };
    });
  }

  /** Takes a like back. */
  async unlike(context: ActionContext, trackId: number): Promise<void> {
    if (!(await this.options.store.likes.remove(likesOwner(context), trackId)))
      throw new ActionError('not-found', 'that track is not in your likes');
  }

  /** Adds every track this login liked to the queue, newest liked first, and starts playing if nothing was. */
  async likesAdd(context: ActionContext, at: InsertAt = 'end'): Promise<AddResult> {
    this.control(context);
    return this.change(context.guildId, async () => {
      const liked = await this.options.store.likes.list(likesOwner(context));
      if (liked.length === 0) throw new ActionError('invalid', 'there are no liked tracks to add');
      const result = await this.enqueue(
        context,
        liked.map((entry) => entry.track),
        at,
      );
      await this.options.players.get(context.guildId).play();
      return result;
    });
  }

  /**
   * Sets what happens when the queue runs out: nothing, a track from this server's plays, or one related to the last
   * track (see app/autoplay.ts). Kept with the player's state, like the repeat mode.
   */
  async autoplay(context: ActionContext, mode: string): Promise<PlayerSnapshot> {
    this.control(context);
    if (!AUTOPLAY_MODES.includes(mode as AutoplayMode))
      throw new ActionError('invalid', `autoplay is one of ${AUTOPLAY_MODES.join(', ')}`);
    return this.change(context.guildId, async () => {
      const player = this.options.players.get(context.guildId);
      await player.setAutoplay(mode as AutoplayMode);
      return player.snapshot();
    });
  }

  /** A saved playlist as a file: its addresses (text), an M3U, or jukecord's JSON (anyone may look). */
  async playlistExport(context: ActionContext, name: string, format: string): Promise<PlaylistExport> {
    if (!PLAYLIST_FORMATS.includes(format as PlaylistFormat))
      throw new ActionError('invalid', `the format is one of ${PLAYLIST_FORMATS.join(', ')}`);
    const store = this.options.store;
    const playlist = await store.playlists.find(context.guildId, name);
    if (!playlist) throw new ActionError('not-found', `there is no playlist named "${name.trim()}"`);
    const kind = format as PlaylistFormat;
    return {
      name: playlist.name,
      format: kind,
      filename: fileName(playlist.name, kind),
      content: writePlaylist(playlist.name, await store.playlists.tracks(playlist.id), kind),
    };
  }

  /**
   * Makes a playlist from a file or a pasted list (see playlist-files.ts), under a name not taken yet. An address
   * jukecord knows is that track; one the file describes (jukecord's JSON, an M3U's line) is stored as the file says,
   * after the same check as a typed address; the rest (addresses alone, words) are looked up, three at a time and at
   * most a hundred. What cannot be found is left out and counted. The lookups run outside the server's turn; the
   * playlist is saved in one.
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
    if (await store.playlists.find(context.guildId, clean))
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
        const known = await store.tracks.bySource(source);
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
            await store.tracks.upsert({
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
        // A list of this person's is being added already: a while, not a moment.
        if (error instanceof BusyError)
          throw new ActionError('unavailable', error.message, { retryAfterMs: LIST_RETRY_MS });
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
    return this.change(context.guildId, async () => {
      // Taken while the lookups ran: refused as before, rather than saved over.
      if (await store.playlists.find(context.guildId, clean))
        throw new ActionError('conflict', `a playlist named "${clean}" exists`);
      try {
        const playlist = await store.playlists.save(
          context.guildId,
          clean,
          tracks.map((track) => track.id),
          context.userId,
        );
        return { playlist, tracks: tracks.length, leftOut };
      } catch (error) {
        throw this.fromStore(error);
      }
    });
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
  async stay(context: ActionContext, on: boolean): Promise<SettingsView> {
    this.manage(context);
    return this.change(context.guildId, async () => {
      await this.options.store.settings.setCommunity(context.guildId, { stay: on });
      // The bot looks again at once: staying stops a countdown under way, and leaving starts one in an empty channel.
      await this.options.voice?.stayChanged?.(context.guildId);
      return this.settings(context);
    });
  }

  /** Whether Skip from someone without the DJ role is a vote in a server: it has a DJ role, and votes are on. */
  async voteSkipApplies(guildId: string): Promise<boolean> {
    const roles = this.options.directory?.roles(guildId) ?? null;
    // The DJ role that counts (a role deleted in Discord is none, see djRoleNow): without one, everyone may skip.
    if (djRoleNow((await this.options.store.settings.get(guildId)).djRoleId, roles) === null) return false;
    return (await this.options.store.settings.community(guildId)).voteSkip;
  }

  /**
   * How the votes to skip the current track stand (anyone may look; the panels get it live), with whether the person
   * asking has a vote that counts.
   */
  async skipVotes(context: ActionContext): Promise<VotesView> {
    return (
      (await this.options.votes?.view(context.guildId, context.userId)) ?? {
        on: false,
        votes: 0,
        needed: 0,
        voted: false,
      }
    );
  }

  /** The people whose votes to skip count in a server now, for the live updates to tell each of them they voted. */
  async skipVoters(guildId: string): Promise<ReadonlySet<string>> {
    return (await this.options.votes?.voters(guildId)) ?? new Set();
  }

  /**
   * Whether Skip from someone without the DJ role is a vote (on, the default) or refused (off), where the server has a
   * DJ role. Needs Manage Server.
   */
  async voteSkip(context: ActionContext, on: boolean): Promise<SettingsView> {
    this.manage(context);
    return this.change(context.guildId, async () => {
      await this.options.store.settings.setCommunity(context.guildId, { voteSkip: on });
      // Votes under way end either way, and the panels hear whether Skip is a vote now.
      this.options.votes?.reset(context.guildId);
      return this.settings(context);
    });
  }

  /**
   * Whether people take turns: a track added at the end goes after the last track of the first round in which its
   * person has none yet (see core/turns.ts). The queue as it is stays; "turns now" puts it in turns. Needs Manage Server.
   */
  async takeTurns(context: ActionContext, on: boolean): Promise<SettingsView> {
    this.manage(context);
    return this.change(context.guildId, async () => {
      await this.options.store.settings.setCommunity(context.guildId, { takeTurns: on });
      return this.settings(context);
    });
  }

  /** Puts the queue in turns once, whatever the setting, and returns how many tracks changed place. */
  async turnsNow(context: ActionContext): Promise<number> {
    this.control(context);
    return this.change(context.guildId, () => {
      const snapshot = this.options.players.get(context.guildId).snapshot();
      return this.options.queue.takeTurns(context.guildId, snapshot.track ? { owner: snapshot.addedBy } : null);
    });
  }

  /** The most tracks one person may have in the queue at once (0 for no limit). Needs Manage Server. */
  async personLimit(context: ActionContext, tracks: number): Promise<SettingsView> {
    this.manage(context);
    // A whole number up to a thousand, as the API and the slash command take it (the queue's own default size).
    if (!Number.isInteger(tracks) || tracks < 0 || tracks > PERSON_LIMIT_MAX)
      throw new ActionError('invalid', `the limit is 0 (none) to ${PERSON_LIMIT_MAX} tracks`);
    return this.change(context.guildId, async () => {
      await this.options.store.settings.setCommunity(context.guildId, { personLimit: tracks });
      return this.settings(context);
    });
  }

  /**
   * The voice channel's volume, 0 to 200 percent; each browser keeps its own. A change of the music: it needs what any
   * change needs (the DJ role where one is set).
   */
  async volume(context: ActionContext, percent: number): Promise<Sound> {
    this.control(context);
    if (!Number.isInteger(percent) || percent < 0 || percent > VOLUME_MAX)
      throw new ActionError('invalid', `the volume is 0 to ${VOLUME_MAX} percent`);
    return this.change(context.guildId, async () => {
      const before = await this.currentSound(context.guildId);
      await this.options.store.settings.setCommunity(context.guildId, { volume: percent });
      return this.soundChanged(context.guildId, before);
    });
  }

  /** The voice channel's sound preset, which browsers listening along apply too (see core/sound.ts). */
  async sound(context: ActionContext, preset: string): Promise<Sound> {
    this.control(context);
    if (!isPreset(preset)) throw new ActionError('invalid', `the sound is one of ${SOUND_PRESETS.join(', ')}`);
    return this.change(context.guildId, async () => {
      const before = await this.currentSound(context.guildId);
      await this.options.store.settings.setCommunity(context.guildId, { sound: preset });
      return this.soundChanged(context.guildId, before);
    });
  }

  /** A server's voice sound now: its volume and preset (anyone may look; the panels get it live). */
  async currentSound(guildId: string): Promise<Sound> {
    const settings = await this.options.store.settings.community(guildId);
    return { volume: settings.volume, preset: settings.sound };
  }

  // The sound may have changed: the voice stream takes it where the track is, and the panels hear it (their browsers
  // apply the preset). The same sound again changes nothing, and starts nothing again.
  private async soundChanged(guildId: string, before: Sound): Promise<Sound> {
    const now = await this.currentSound(guildId);
    if (now.volume === before.volume && now.preset === before.preset) return now;
    await this.options.voice?.soundChanged?.(guildId);
    this.options.bus?.emit('sound', { guildId });
    return now;
  }
}
