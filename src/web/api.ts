/**
 * The HTTP API, one entry per operation: its method, path, who may call it, what it takes and what it returns.
 *
 * This table is the single description of the API. The server registers its routes from it, the OpenAPI document is
 * built from it, and the CLI builds its requests from it, so the three cannot disagree about a path or a field. Every
 * shared action (src/app/actions.ts) has an entry under the same name; the entries after them are about the login,
 * not a server (who am I, tokens, logs, backups). A test checks that every operation is also a CLI command and that
 * the panel offers every action.
 */
import { type TObject, type TSchema, Type } from 'typebox';
import type { ActionName } from '../app/actions.ts';
import {
  AddResultSchema,
  DoctorSchema,
  GuildId,
  GuildSchema,
  HistoryEntrySchema,
  LogRecordSchema,
  MeSchema,
  MovedSchema,
  Nullable,
  OkSchema,
  PlayerSchema,
  PlaylistSchema,
  QueueSchema,
  RemovedSchema,
  ScopeSchema,
  SettingsSchema,
  SkipSchema,
  Snowflake,
  SoundPresetSchema,
  SoundSchema,
  StatsSchema,
  StatusSchema,
  TokenCreatedSchema,
  TokenSchema,
  VoiceSchema,
} from './schemas.ts';

/** The operations about the login rather than a server. */
export const ACCOUNT_OPERATIONS = [
  'me',
  'guilds',
  'tokens',
  'token-create',
  'token-revoke',
  'logs',
  'login-link',
  'backup',
  'doctor',
] as const;

export type AccountOperation = (typeof ACCOUNT_OPERATIONS)[number];

/** Every operation of the API: the shared actions and the account operations. */
export type OperationName = ActionName | AccountOperation;

/**
 * Who may call an operation:
 * - public: anyone, logged in or not (the version, for the login page);
 * - read: any login or token;
 * - control: a login, or a token with the control or admin scope (the action still checks the DJ role);
 * - admin: a login, or a token with the admin scope;
 * - host: the host only (the machine's own CLI and login links), for what spans every server.
 */
export type Permission = 'public' | 'read' | 'control' | 'admin' | 'host';

export interface OperationSpec {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** OpenAPI style, relative to /api/v1: "/guilds/{guild}/queue". */
  readonly path: string;
  readonly summary: string;
  /** The group it is listed under in the API document. */
  readonly tag: 'player' | 'queue' | 'history' | 'playlists' | 'voice' | 'server' | 'account' | 'host';
  readonly access: Permission;
  readonly params?: TObject;
  readonly query?: TObject;
  readonly body?: TObject;
  readonly response: TSchema;
}

// Keeps each entry's exact types (the literal method, the schemas), which the handlers' types are computed from.
function op<const S extends OperationSpec>(spec: S): S {
  return spec;
}

// Path parameters, shared by the entries below.
const InGuild = Type.Object({ guild: GuildId });
const InGuildItem = Type.Object({ guild: GuildId, item: Type.Integer({ minimum: 1, description: 'A queue item ID' }) });
const InGuildPlaylist = Type.Object({ guild: GuildId, name: Type.String({ minLength: 1, maxLength: 100 }) });

// What to play: an address or words to search for (the same limit as the slash commands).
const Input = Type.String({ minLength: 1, maxLength: 500, description: 'An address or words to search for' });
const At = Type.Union([Type.Literal('end'), Type.Literal('next')], { description: 'Where in the queue; default end' });

// Request bodies refuse fields they do not know (removed silently by the validator), so a typo cannot pass as set.
const strict = { additionalProperties: false } as const;

/** The API, by operation name. */
export const API = {
  // Player.
  'now-playing': op({
    method: 'GET',
    path: '/guilds/{guild}/player',
    summary: 'What is playing and where',
    tag: 'player',
    access: 'read',
    params: InGuild,
    response: PlayerSchema,
  }),
  'play-now': op({
    method: 'POST',
    path: '/guilds/{guild}/player/play',
    summary: 'Play now: what the input finds goes first and the current track is skipped',
    tag: 'player',
    access: 'control',
    params: InGuild,
    body: Type.Object({ input: Input }, strict),
    response: AddResultSchema,
  }),
  skip: op({
    method: 'POST',
    path: '/guilds/{guild}/player/skip',
    summary: 'Skip to the next track; without the DJ role where votes are on, a vote (the answer says how it stands)',
    tag: 'player',
    access: 'control',
    params: InGuild,
    response: SkipSchema,
  }),
  'remove-current': op({
    method: 'POST',
    path: '/guilds/{guild}/player/drop',
    summary: 'Drop the current track without counting it as played',
    tag: 'player',
    access: 'control',
    params: InGuild,
    response: PlayerSchema,
  }),
  pause: op({
    method: 'POST',
    path: '/guilds/{guild}/player/pause',
    summary: 'Pause',
    tag: 'player',
    access: 'control',
    params: InGuild,
    response: PlayerSchema,
  }),
  resume: op({
    method: 'POST',
    path: '/guilds/{guild}/player/resume',
    summary: 'Play on: resume what is paused, or start the queue when nothing plays',
    tag: 'player',
    access: 'control',
    params: InGuild,
    response: PlayerSchema,
  }),
  seek: op({
    method: 'POST',
    path: '/guilds/{guild}/player/seek',
    summary: 'Go to a place in the current track',
    tag: 'player',
    access: 'control',
    params: InGuild,
    body: Type.Object({ positionMs: Type.Number({ minimum: 0 }) }, strict),
    response: PlayerSchema,
  }),
  repeat: op({
    method: 'PUT',
    path: '/guilds/{guild}/player/repeat',
    summary: 'Repeat nothing, the current track, or the queue',
    tag: 'player',
    access: 'control',
    params: InGuild,
    body: Type.Object(
      { mode: Type.Union([Type.Literal('off'), Type.Literal('track'), Type.Literal('queue')]) },
      strict,
    ),
    response: PlayerSchema,
  }),
  stop: op({
    method: 'POST',
    path: '/guilds/{guild}/player/stop',
    summary: 'Stop playing; the queue stays',
    tag: 'player',
    access: 'control',
    params: InGuild,
    response: PlayerSchema,
  }),

  // Queue.
  queue: op({
    method: 'GET',
    path: '/guilds/{guild}/queue',
    summary: 'The queue in play order',
    tag: 'queue',
    access: 'read',
    params: InGuild,
    response: QueueSchema,
  }),
  add: op({
    method: 'POST',
    path: '/guilds/{guild}/queue',
    summary: 'Add what an address or a search finds (all of a playlist); playing starts if nothing was',
    tag: 'queue',
    access: 'control',
    params: InGuild,
    body: Type.Object({ input: Input, at: Type.Optional(At) }, strict),
    response: AddResultSchema,
  }),
  clear: op({
    method: 'DELETE',
    path: '/guilds/{guild}/queue',
    summary: 'Empty the queue',
    tag: 'queue',
    access: 'control',
    params: InGuild,
    response: RemovedSchema,
  }),
  remove: op({
    method: 'DELETE',
    path: '/guilds/{guild}/queue/{item}',
    summary: 'Remove a track from the queue',
    tag: 'queue',
    access: 'control',
    params: InGuildItem,
    response: OkSchema,
  }),
  move: op({
    method: 'POST',
    path: '/guilds/{guild}/queue/{item}/move',
    summary: 'Move a queued track to a place (0 is next)',
    tag: 'queue',
    access: 'control',
    params: InGuildItem,
    body: Type.Object({ index: Type.Integer({ minimum: 0 }) }, strict),
    response: OkSchema,
  }),
  jump: op({
    method: 'POST',
    path: '/guilds/{guild}/queue/{item}/play',
    summary: 'Play a queued track now (the current one is skipped)',
    tag: 'queue',
    access: 'control',
    params: InGuildItem,
    response: PlayerSchema,
  }),
  shuffle: op({
    method: 'POST',
    path: '/guilds/{guild}/queue/shuffle',
    summary: 'Shuffle the queue',
    tag: 'queue',
    access: 'control',
    params: InGuild,
    response: OkSchema,
  }),
  dedupe: op({
    method: 'POST',
    path: '/guilds/{guild}/queue/dedupe',
    summary: 'Remove later copies of tracks queued twice',
    tag: 'queue',
    access: 'control',
    params: InGuild,
    response: RemovedSchema,
  }),

  // History and statistics.
  history: op({
    method: 'GET',
    path: '/guilds/{guild}/history',
    summary: 'Played tracks, newest first',
    tag: 'history',
    access: 'read',
    params: InGuild,
    query: Type.Object({
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
      before: Type.Optional(Type.Integer({ minimum: 1, description: 'Page back from this entry ID' })),
    }),
    response: Type.Array(HistoryEntrySchema),
  }),
  stats: op({
    method: 'GET',
    path: '/guilds/{guild}/stats',
    summary: 'Listening figures: plays per day and hour, most played tracks, who added most',
    tag: 'history',
    access: 'read',
    params: InGuild,
    query: Type.Object({
      days: Type.Optional(Type.Integer({ minimum: 1, maximum: 366, default: 30 })),
      tz: Type.Optional(
        Type.Integer({ minimum: -720, maximum: 840, default: 0, description: 'Minutes east of UTC (Seoul is 540)' }),
      ),
    }),
    response: StatsSchema,
  }),

  // Playlists.
  playlists: op({
    method: 'GET',
    path: '/guilds/{guild}/playlists',
    summary: 'Saved playlists',
    tag: 'playlists',
    access: 'read',
    params: InGuild,
    response: Type.Array(PlaylistSchema),
  }),
  'playlist-save': op({
    method: 'POST',
    path: '/guilds/{guild}/playlists',
    summary: 'Save the current track and the queue under a name (replacing a list of that name)',
    tag: 'playlists',
    access: 'control',
    params: InGuild,
    body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 100 }) }, strict),
    response: PlaylistSchema,
  }),
  'playlist-load': op({
    method: 'POST',
    path: '/guilds/{guild}/playlists/{name}/load',
    summary: 'Add a saved playlist to the queue',
    tag: 'playlists',
    access: 'control',
    params: InGuildPlaylist,
    body: Type.Object({ at: Type.Optional(At) }, strict),
    response: AddResultSchema,
  }),
  'playlist-rename': op({
    method: 'PATCH',
    path: '/guilds/{guild}/playlists/{name}',
    summary: 'Rename a saved playlist',
    tag: 'playlists',
    access: 'control',
    params: InGuildPlaylist,
    body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 100 }) }, strict),
    response: PlaylistSchema,
  }),
  'playlist-delete': op({
    method: 'DELETE',
    path: '/guilds/{guild}/playlists/{name}',
    summary: 'Delete a saved playlist',
    tag: 'playlists',
    access: 'control',
    params: InGuildPlaylist,
    response: OkSchema,
  }),

  // Voice.
  'voice-channels': op({
    method: 'GET',
    path: '/guilds/{guild}/voice',
    summary: 'The voice channel the bot is in and the ones it could join',
    tag: 'voice',
    access: 'read',
    params: InGuild,
    response: VoiceSchema,
  }),
  join: op({
    method: 'PUT',
    path: '/guilds/{guild}/voice',
    summary: 'Join a voice channel (your own when none is named)',
    tag: 'voice',
    access: 'control',
    params: InGuild,
    body: Type.Object({ channelId: Type.Optional(Snowflake) }, strict),
    response: VoiceSchema,
  }),
  leave: op({
    method: 'DELETE',
    path: '/guilds/{guild}/voice',
    summary: 'Leave the voice channel; the music goes on in the browsers',
    tag: 'voice',
    access: 'control',
    params: InGuild,
    response: VoiceSchema,
  }),

  // Server settings.
  settings: op({
    method: 'GET',
    path: '/guilds/{guild}/settings',
    summary: "The server's settings and its roles",
    tag: 'server',
    access: 'read',
    params: InGuild,
    response: SettingsSchema,
  }),
  'dj-role': op({
    method: 'PUT',
    path: '/guilds/{guild}/settings/dj-role',
    summary: 'Set the role that may change the music (null: everyone); needs Manage Server',
    tag: 'server',
    access: 'admin',
    params: InGuild,
    body: Type.Object({ roleId: Nullable(Snowflake) }, strict),
    response: SettingsSchema,
  }),
  status: op({
    method: 'GET',
    path: '/status',
    summary: 'The version, the mode and whether Discord is connected',
    tag: 'server',
    access: 'public',
    response: StatusSchema,
  }),

  // The login.
  me: op({
    method: 'GET',
    path: '/me',
    summary: 'Who is logged in',
    tag: 'account',
    access: 'read',
    response: MeSchema,
  }),
  guilds: op({
    method: 'GET',
    path: '/guilds',
    summary: 'The servers you can open and what you may do in each',
    tag: 'account',
    access: 'read',
    response: Type.Array(GuildSchema),
  }),
  tokens: op({
    method: 'GET',
    path: '/tokens',
    summary: 'Your API tokens (the host sees every token)',
    tag: 'account',
    access: 'admin',
    response: Type.Array(TokenSchema),
  }),
  'token-create': op({
    method: 'POST',
    path: '/tokens',
    summary: 'Make an API token; the secret is shown in this answer only',
    tag: 'account',
    access: 'admin',
    body: Type.Object({ name: Type.String({ minLength: 1, maxLength: 100 }), scope: ScopeSchema }, strict),
    response: TokenCreatedSchema,
  }),
  'token-revoke': op({
    method: 'DELETE',
    path: '/tokens/{id}',
    summary: 'Revoke an API token',
    tag: 'account',
    access: 'admin',
    params: Type.Object({ id: Type.Integer({ minimum: 1 }) }),
    response: OkSchema,
  }),

  // The host.
  logs: op({
    method: 'GET',
    path: '/logs',
    summary: 'The newest log records, oldest first',
    tag: 'host',
    access: 'host',
    query: Type.Object({
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, default: 200 })),
      level: Type.Optional(
        Type.Union([Type.Literal('debug'), Type.Literal('info'), Type.Literal('warn'), Type.Literal('error')], {
          description: 'The lowest level shown',
        }),
      ),
      component: Type.Optional(Type.String({ maxLength: 40 })),
      before: Type.Optional(Type.String({ maxLength: 40, description: 'Only records older than this ISO time' })),
    }),
    response: Type.Array(LogRecordSchema),
  }),
  'login-link': op({
    method: 'POST',
    path: '/login-links',
    summary: 'Make a one-time link that logs a browser in as the host (valid for 10 minutes)',
    tag: 'host',
    access: 'host',
    response: Type.Object({ url: Type.String(), expiresAt: Type.Integer() }),
  }),
  backup: op({
    method: 'POST',
    path: '/backups',
    summary: 'Write a copy of the database to the backups folder of the data directory',
    tag: 'host',
    access: 'host',
    response: Type.Object({ file: Type.String(), bytes: Type.Integer() }),
  }),
  doctor: op({
    method: 'GET',
    path: '/doctor',
    summary: 'Check the parts jukecord needs and show the settings (secrets as set or not set)',
    tag: 'host',
    access: 'host',
    response: DoctorSchema,
  }),

  // How a server's people share the music, and how its voice channel sounds.
  stay: op({
    method: 'PUT',
    path: '/guilds/{guild}/settings/stay',
    summary: "Stay in voice when everyone has left (off: leave after the host's time alone); needs Manage Server",
    tag: 'server',
    access: 'admin',
    params: InGuild,
    body: Type.Object({ on: Type.Boolean() }, strict),
    response: SettingsSchema,
  }),
  'vote-skip': op({
    method: 'PUT',
    path: '/guilds/{guild}/settings/vote-skip',
    summary: 'Whether Skip from someone without the DJ role is a vote (on) or refused (off); needs Manage Server',
    tag: 'server',
    access: 'admin',
    params: InGuild,
    body: Type.Object({ on: Type.Boolean() }, strict),
    response: SettingsSchema,
  }),
  'take-turns': op({
    method: 'PUT',
    path: '/guilds/{guild}/settings/take-turns',
    summary: "Take turns: a track added goes in its person's turn, not at the end; needs Manage Server",
    tag: 'server',
    access: 'admin',
    params: InGuild,
    body: Type.Object({ on: Type.Boolean() }, strict),
    response: SettingsSchema,
  }),
  'turns-now': op({
    method: 'POST',
    path: '/guilds/{guild}/queue/turns',
    summary: "Put the queue in turns once: each person's next track in turn",
    tag: 'queue',
    access: 'control',
    params: InGuild,
    response: MovedSchema,
  }),
  'person-limit': op({
    method: 'PUT',
    path: '/guilds/{guild}/settings/person-limit',
    summary: 'The most tracks one person may have queued (0: no limit); needs Manage Server',
    tag: 'server',
    access: 'admin',
    params: InGuild,
    body: Type.Object({ tracks: Type.Integer({ minimum: 0, maximum: 1000 }) }, strict),
    response: SettingsSchema,
  }),
  volume: op({
    method: 'PUT',
    path: '/guilds/{guild}/voice/volume',
    summary: "The voice channel's volume, 0 to 200 percent (each browser keeps its own)",
    tag: 'voice',
    access: 'control',
    params: InGuild,
    body: Type.Object({ percent: Type.Integer({ minimum: 0, maximum: 200 }) }, strict),
    response: SoundSchema,
  }),
  sound: op({
    method: 'PUT',
    path: '/guilds/{guild}/voice/sound',
    summary: "The voice channel's sound preset; browsers listening along apply it too",
    tag: 'voice',
    access: 'control',
    params: InGuild,
    body: Type.Object({ preset: SoundPresetSchema }, strict),
    response: SoundSchema,
  }),
} satisfies Record<OperationName, OperationSpec>;

/** The operations in a stable order: the table's own. */
export const OPERATIONS = Object.keys(API) as OperationName[];

/** The prefix every API path is under. */
export const API_PREFIX = '/api/v1';
