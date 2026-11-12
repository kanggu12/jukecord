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

// One time's top person: who, by name and avatar as jukecord met them, and how much of theirs played.
const Person = Type.Object({
  userId: Nullable(Type.String({ description: 'Discord user ID; null for the host' })),
  name: Nullable(Type.String()),
  avatar: Nullable(Type.String()),
  plays: Type.Integer(),
  playedMs: Type.Integer(),
});

export const WrappedSchema = Type.Object(
  {
    period: Type.Object({
      kind: Type.Union([Type.Literal('year'), Type.Literal('month'), Type.Literal('last-12-months')]),
      key: Type.String({ description: 'The time as it is asked for: 2026, 2026-03 or last-12-months' }),
      from: Type.String({ description: 'The first day, YYYY-MM-DD in the time zone asked for' }),
      to: Type.String({ description: 'The last day: today while the time lasts' }),
    }),
    plays: Type.Integer(),
    playedMs: Type.Integer(),
    tracks: Type.Integer({ description: 'Different tracks played' }),
    people: Type.Integer({ description: 'People whose tracks were played (the host counts as one)' }),
    days: Type.Integer({ description: 'Days with music' }),
    topTracks: Type.Array(Type.Object({ track: TrackSchema, plays: Type.Integer(), playedMs: Type.Integer() }), {
      maxItems: 5,
    }),
    topPeople: Type.Array(Person, { maxItems: 5 }),
    weekdays: Type.Array(Type.Integer(), {
      minItems: 7,
      maxItems: 7,
      description: 'Plays by day of the week, Sunday first',
    }),
    hours: Type.Array(Type.Integer(), { minItems: 24, maxItems: 24, description: 'Plays by hour of the day' }),
    longestDay: Nullable(
      Type.Object(
        { day: Type.String(), plays: Type.Integer(), playedMs: Type.Integer() },
        { description: 'The day with the most time listened' },
      ),
    ),
    firstTrack: Nullable(
      Type.Object(
        {
          track: TrackSchema,
          playedAt: Type.Integer(),
          addedBy: Nullable(Type.String()),
          addedByName: Nullable(Type.String()),
        },
        { description: 'The first track played in the time' },
      ),
    ),
    song: Nullable(
      Type.Object(
        {
          track: TrackSchema,
          plays: Type.Integer(),
          playedMs: Type.Integer(),
          days: Type.Integer({ description: 'The days it was played on' }),
        },
        { description: 'The song of the time: the track played on the most days, then the most times' },
      ),
    ),
    keptFrom: Nullable(
      Type.String({ description: 'The first day the history still reaches, when the time goes back further' }),
    ),
    years: Type.Array(Type.String(), { description: 'The years with plays, newest first' }),
    months: Type.Array(Type.String(), { description: 'The months with plays (YYYY-MM), newest first' }),
  },
  { title: 'Wrapped' },
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
