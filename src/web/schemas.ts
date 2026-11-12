/**
 * The shapes the HTTP API takes and returns, as JSON Schema (written with TypeBox).
 *
 * Each schema does three jobs: Fastify checks requests against it, Fastify writes responses with it (fields not in a
 * response schema are never sent, so an internal field cannot leak by accident), and the OpenAPI document is built
 * from it. The TypeScript types of the handlers come from the same schemas, so the three cannot drift apart.
 */
import { type TSchema, Type } from 'typebox';

// "A value or null", which JSON Schema spells as a union.
export function Nullable<T extends TSchema>(schema: T) {
  return Type.Union([schema, Type.Null()]);
}

/** The schema of one field of the API, as much of it as misfit reads (TypeBox writes plain JSON Schema). */
export interface FieldSchema {
  readonly type?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly maxLength?: number;
  readonly anyOf?: readonly { readonly const?: unknown }[];
  readonly description?: string;
}

// "a, b or c".
function listed(items: readonly string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`;
}

/**
 * What is wrong with a value for a field, as the end of a sentence about it ("is 1 to 200", "is debug, info, warn or
 * error"), or null when the API takes it.
 */
export function misfit(schema: FieldSchema | undefined, value: unknown): string | null {
  if (!schema) return null;
  // A choice of fixed values (TypeBox's union of literals).
  const choices = (schema.anyOf ?? []).flatMap((option) => (option.const === undefined ? [] : [String(option.const)]));
  if (choices.length > 0) return choices.includes(String(value)) ? null : `is ${listed(choices)}`;
  if (schema.type === 'integer' || schema.type === 'number') {
    const number = Number(value);
    const low = schema.minimum ?? Number.NEGATIVE_INFINITY;
    const high = schema.maximum ?? Number.POSITIVE_INFINITY;
    const whole = schema.type === 'number' || Number.isInteger(number);
    if (Number.isFinite(number) && whole && number >= low && number <= high) return null;
    if (Number.isFinite(low) && Number.isFinite(high)) return `is ${low} to ${high}`;
    return Number.isFinite(low) ? `is ${low} or more` : `is ${high} or less`;
  }
  if (schema.maxLength !== undefined && String(value).length > schema.maxLength)
    return `is at most ${schema.maxLength} characters`;
  return null;
}

/** A Discord server ID (a snowflake), or "local" for the queue of browser-only mode. */
export const GuildId = Type.String({ pattern: '^(\\d{17,20}|local)$', description: 'A Discord server ID, or "local"' });

/** A Discord ID of anything else (user, channel, role). */
export const Snowflake = Type.String({ pattern: '^\\d{17,20}$' });

export const TrackSchema = Type.Object(
  {
    id: Type.Integer(),
    url: Type.String({ description: 'The page of the track' }),
    title: Type.String(),
    uploader: Nullable(Type.String()),
    durationMs: Nullable(Type.Integer({ description: 'Null for live streams and sites that do not say' })),
    thumbnail: Nullable(Type.String()),
  },
  { title: 'Track' },
);

export const QueueItemSchema = Type.Object(
  {
    id: Type.Integer(),
    position: Type.Integer({ description: '0 is next' }),
    track: TrackSchema,
    addedBy: Nullable(Type.String({ description: 'Discord user ID; null for the host' })),
    addedByName: Nullable(Type.String()),
    addedAt: Type.Integer(),
  },
  { title: 'QueueItem' },
);

export const QueueSchema = Type.Object(
  {
    items: Type.Array(QueueItemSchema),
    version: Type.Integer({ description: 'Grows by one with every change of the queue' }),
  },
  { title: 'Queue' },
);

export const PlayerSchema = Type.Object(
  {
    guildId: Type.String(),
    status: Type.Union([
      Type.Literal('idle'),
      Type.Literal('loading'),
      Type.Literal('playing'),
      Type.Literal('paused'),
    ]),
    track: Nullable(TrackSchema),
    addedBy: Nullable(Type.String()),
    addedByName: Nullable(Type.String()),
    positionMs: Type.Number({ description: 'Where the track was at time "at"; while playing, add the time since' }),
    at: Type.Integer({ description: 'Server time of positionMs, in milliseconds since the epoch' }),
    durationMs: Nullable(Type.Integer()),
    error: Nullable(Type.String()),
    repeat: Type.Union([Type.Literal('off'), Type.Literal('track'), Type.Literal('queue')]),
    progress: Nullable(Type.Number({ description: 'Download progress (0 to 1) while loading' })),
    version: Type.Integer(),
    notice: Nullable(
      Type.String({
        description: 'What the player did by itself ("Title: taken out of the looping queue"); kept until a change',
      }),
    ),
  },
  { title: 'Player' },
);

export const AddResultSchema = Type.Object(
  {
    items: Type.Array(QueueItemSchema),
    skippedTooLong: Type.Integer(),
    skippedFull: Type.Integer(),
  },
  { title: 'AddResult' },
);

export const HistoryEntrySchema = Type.Object(
  {
    id: Type.Integer(),
    track: TrackSchema,
    addedBy: Nullable(Type.String()),
    addedByName: Nullable(Type.String()),
    playedAt: Type.Integer(),
    playedMs: Type.Integer(),
  },
  { title: 'HistoryEntry' },
);

export const PlaylistSchema = Type.Object(
  {
    id: Type.Integer(),
    name: Type.String(),
    createdBy: Nullable(Type.String()),
    createdAt: Type.Integer(),
    updatedAt: Type.Integer(),
    size: Type.Integer(),
  },
  { title: 'Playlist' },
);

export const VoiceSchema = Type.Object(
  {
    current: Nullable(Type.Object({ channelId: Type.String(), name: Type.String() })),
    channels: Type.Array(Type.Object({ id: Type.String(), name: Type.String(), people: Type.Integer() })),
  },
  { title: 'Voice' },
);

const Count = Type.Object({ plays: Type.Integer(), playedMs: Type.Integer() });

export const StatsSchema = Type.Object(
  {
    span: Type.Integer({ description: 'Days covered' }),
    from: Type.String({ description: 'The first day, YYYY-MM-DD in the time zone asked for' }),
    plays: Type.Integer(),
    playedMs: Type.Integer(),
    tracks: Type.Integer(),
    people: Type.Integer(),
    days: Type.Array(Type.Object({ day: Type.String(), plays: Type.Integer(), playedMs: Type.Integer() })),
    hours: Type.Array(Type.Integer(), { minItems: 24, maxItems: 24 }),
    topTracks: Type.Array(Type.Object({ track: TrackSchema, plays: Type.Integer(), playedMs: Type.Integer() })),
    topPeople: Type.Array(
      Type.Object({
        userId: Nullable(Type.String()),
        name: Nullable(Type.String()),
        avatar: Nullable(Type.String()),
        plays: Count.properties.plays,
        playedMs: Count.properties.playedMs,
      }),
    ),
  },
  { title: 'Stats' },
);

export const SettingsSchema = Type.Object(
  {
    djRoleId: Nullable(Type.String()),
    roles: Type.Array(Type.Object({ id: Type.String(), name: Type.String(), color: Type.Integer() })),
  },
  { title: 'Settings' },
);

export const StatusSchema = Type.Object(
  {
    version: Type.String(),
    discord: Type.Boolean({ description: 'Whether the bot is connected to Discord' }),
    mode: Type.Union([Type.Literal('discord'), Type.Literal('browser-only')]),
    uptimeMs: Type.Integer(),
    login: Type.Object({ discord: Type.Boolean({ description: 'Whether logging in with Discord is set up' }) }),
  },
  { title: 'Status' },
);

export const GuildSchema = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    icon: Nullable(Type.String()),
    mayControl: Type.Boolean(),
    mayManage: Type.Boolean(),
  },
  { title: 'Guild' },
);

export const ScopeSchema = Type.Union([Type.Literal('read'), Type.Literal('control'), Type.Literal('admin')]);

export const MeSchema = Type.Object(
  {
    kind: Type.Union([Type.Literal('host'), Type.Literal('user')]),
    id: Nullable(Type.String()),
    name: Type.String(),
    avatar: Nullable(Type.String()),
    scope: ScopeSchema,
    csrf: Nullable(Type.String({ description: 'Send as the x-jukecord-csrf header with every change (panel only)' })),
    bot: Nullable(Type.Object({ id: Type.String(), name: Type.String(), avatar: Nullable(Type.String()) })),
  },
  { title: 'Me' },
);

export const TokenSchema = Type.Object(
  {
    id: Type.Integer(),
    name: Type.String(),
    kind: Type.Union([Type.Literal('host'), Type.Literal('user')]),
    userId: Nullable(Type.String()),
    scope: ScopeSchema,
    createdAt: Type.Integer(),
    usedAt: Nullable(Type.Integer()),
  },
  { title: 'Token' },
);

export const TokenCreatedSchema = Type.Object(
  {
    token: Type.String({ description: 'The secret: shown this once, stored only as a hash' }),
    info: TokenSchema,
  },
  { title: 'TokenCreated' },
);

export const LogRecordSchema = Type.Object(
  {
    time: Type.String(),
    level: Type.Union([Type.Literal('debug'), Type.Literal('info'), Type.Literal('warn'), Type.Literal('error')]),
    component: Type.String(),
    msg: Type.String(),
    fields: Type.Record(Type.String(), Type.Unknown()),
  },
  { title: 'LogRecord' },
);

export const DoctorSchema = Type.Object(
  {
    ok: Type.Boolean({ description: 'False when any check failed' }),
    checks: Type.Array(
      Type.Object({
        name: Type.String(),
        status: Type.Union([Type.Literal('ok'), Type.Literal('warn'), Type.Literal('fail')]),
        detail: Type.String(),
      }),
    ),
    settings: Type.Record(Type.String(), Type.String()),
  },
  { title: 'Doctor' },
);

export const ErrorSchema = Type.Object(
  {
    error: Type.Object({
      code: Type.String({
        description: 'invalid, unauthorized, forbidden, not-found, conflict, too-many, unavailable',
      }),
      message: Type.String(),
    }),
  },
  { title: 'Error' },
);

/** An empty answer: the change was made and there is nothing to show. */
export const OkSchema = Type.Object({ ok: Type.Literal(true) }, { title: 'Ok' });

/** How many things a change removed. */
export const RemovedSchema = Type.Object({ removed: Type.Integer() }, { title: 'Removed' });
