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
    addedBy: Nullable(
      Type.String({ description: 'Discord user ID; "autoplay" for what autoplay queued; null for the host' }),
    ),
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
    waiting: Type.Boolean({ description: 'Whether the loading track waits for its turn among the fetches' }),
    stopAfter: Type.Boolean({ description: 'Whether the player stops when the current track ends' }),
    autoplay: Type.Union([Type.Literal('off'), Type.Literal('history'), Type.Literal('related')], {
      description: 'When the queue runs out: nothing, a track from past plays, or one related to the last track',
    }),
  },
  { title: 'Player' },
);

/** A skip's answer: the player after it, and how the vote stands when it was a vote the track did not go by. */
export const SkipSchema = Type.Object(
  {
    ...PlayerSchema.properties,
    votes: Nullable(
      Type.Object(
        { votes: Type.Integer(), needed: Type.Integer() },
        { description: 'The votes to skip that count, and the votes it takes; null when the track went' },
      ),
    ),
  },
  { title: 'Skip' },
);

export const AddResultSchema = Type.Object(
  {
    items: Type.Array(QueueItemSchema),
    skippedTooLong: Type.Integer(),
    skippedFull: Type.Integer(),
    skippedLimit: Type.Integer({ description: "Left out: over the server's limit of tracks per person" }),
    skippedNotFound: Type.Integer({
      description: 'Tracks of a Deezer, Spotify or Apple Music link not found on YouTube',
    }),
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

/**
 * A sound preset of the voice channel, which browsers listening along apply too: the presets of core/sound.ts, written
 * out so that TypeBox keeps each one's literal type (tests/unit/sound.test.ts holds the two lists together).
 */
export const SoundPresetSchema = Type.Union(
  [Type.Literal('off'), Type.Literal('bass'), Type.Literal('voices'), Type.Literal('bright'), Type.Literal('night')],
  { description: 'off, more bass, clearer voices, brighter, or night mode' },
);

export const SettingsSchema = Type.Object(
  {
    djRoleId: Nullable(Type.String()),
    roles: Type.Array(Type.Object({ id: Type.String(), name: Type.String(), color: Type.Integer() })),
    alertsChannelId: Nullable(Type.String({ description: 'Where jukecord tells this server about trouble' })),
    channels: Type.Array(Type.Object({ id: Type.String(), name: Type.String() }), {
      description: 'The text channels the bot may post in',
    }),
    voteSkip: Type.Boolean({ description: 'Skip from someone without the DJ role is a vote (with a DJ role set)' }),
    takeTurns: Type.Boolean({ description: 'The queue plays one track from each person in turn' }),
    personLimit: Type.Integer({ description: 'How many tracks each person may have queued; 0 for no limit' }),
    stay: Type.Boolean({ description: 'The bot stays in voice when everyone has left' }),
    volume: Type.Integer({ description: "The voice channel's volume, in percent" }),
    sound: SoundPresetSchema,
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
    lyrics: Type.Boolean({ description: 'Whether lyrics are looked up here (JUKECORD_LYRICS)' }),
    database: Type.Union(
      [Type.Literal('sqlite'), Type.Literal('postgres'), Type.Literal('mysql'), Type.Literal('mariadb')],
      {
        description: 'The kind of database jukecord keeps its data in (JUKECORD_DATABASE_URL)',
      },
    ),
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
    kind: Type.Union(
      [
        Type.Literal('host'),
        Type.Literal('user'),
        Type.Literal('friend'),
        Type.Literal('member'),
        Type.Literal('guest'),
      ],
      {
        description:
          "friend: let in by the host with a login link; member: logged in through the host's identity provider (OIDC) or directory (LDAP); guest: in with a listening link",
      },
    ),
    id: Nullable(Type.String()),
    name: Type.String(),
    avatar: Nullable(Type.String()),
    scope: ScopeSchema,
    csrf: Nullable(Type.String({ description: 'Send as the x-jukecord-csrf header with every change (panel only)' })),
    bot: Nullable(Type.Object({ id: Type.String(), name: Type.String(), avatar: Nullable(Type.String()) })),
    guest: Nullable(
      Type.Object(
        { guildId: Type.String(), expiresAt: Type.Integer() },
        { description: "A guest's server, and when its listening link stops working" },
      ),
    ),
    member: Nullable(
      Type.Object(
        {
          provider: Type.Union([Type.Literal('oidc'), Type.Literal('ldap')]),
          level: ScopeSchema,
        },
        {
          description:
            'For a member, and a Discord user who logged in through OIDC: where they logged in, and the level their groups gave (admin: what the host may; control: change the music everywhere; read: look and listen); it changes at their next login',
        },
      ),
    ),
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

/** What the login page shows: the ways of logging in that are set up here, with the words of their keys. */
export const AuthMethodsSchema = Type.Object(
  {
    discord: Type.Boolean({ description: 'Whether logging in with Discord is set up' }),
    sso: Nullable(
      Type.Object(
        {
          label: Nullable(
            Type.String({ description: "The login key's words as the host wrote them; null: the panel's own" }),
          ),
        },
        { description: "Logging in through the host's identity provider (OIDC); null when it is not set up" },
      ),
    ),
    directory: Nullable(
      Type.Object(
        {
          label: Nullable(
            Type.String({ description: "The form key's words as the host wrote them; null: the panel's own" }),
          ),
        },
        { description: 'Logging in with a directory account (LDAP, Active Directory); null when it is not set up' },
      ),
    ),
  },
  { title: 'AuthMethods' },
);

// One finding of a settings test, as the doctor's.
const CheckSchema = Type.Object({
  name: Type.String(),
  status: Type.Union([Type.Literal('ok'), Type.Literal('warn'), Type.Literal('fail')]),
  detail: Type.String(),
});

/** Settings not saved yet to test instead of the ones in use, by their environment names (JUKECORD_OIDC_*...). */
export const LoginSettingsSchema = Type.Record(Type.String({ maxLength: 64 }), Type.String({ maxLength: 4000 }), {
  // As many as there are login settings, and a few to spare for the names a test refuses one by one.
  maxProperties: 40,
  description:
    'Values to test in place of the ones in use, by environment name; the others stay as they are. A secret left out is the one in use.',
});

export const OidcTestSchema = Type.Object(
  {
    ok: Type.Boolean({ description: 'False when any check failed' }),
    checks: Type.Array(CheckSchema),
  },
  { title: 'OidcTest' },
);

export const LdapTestSchema = Type.Object(
  {
    ok: Type.Boolean({ description: 'False when any check failed' }),
    checks: Type.Array(CheckSchema),
    groups: Nullable(Type.Array(Type.String(), { description: "The person's groups by DN, when a name was given" })),
    level: Type.Union([ScopeSchema, Type.Null()], {
      description: 'The level those groups give (null: the person would be refused, or no name was given)',
    }),
  },
  { title: 'LdapTest' },
);

export const ErrorSchema = Type.Object(
  {
    error: Type.Object({
      code: Type.String({
        description: 'invalid, unauthorized, forbidden, not-found, conflict, too-many, unavailable',
      }),
      message: Type.String(),
      // A refused change of the host's settings says each problem with the settings it is about.
      problems: Type.Optional(
        Type.Array(Type.Object({ names: Type.Array(Type.String()), message: Type.String() }), {
          description: 'A refused change of settings: each problem and the settings it is about',
        }),
      ),
    }),
  },
  { title: 'Error' },
);

/** An empty answer: the change was made and there is nothing to show. */
export const OkSchema = Type.Object({ ok: Type.Literal(true) }, { title: 'Ok' });

/** How many things a change removed. */
export const RemovedSchema = Type.Object({ removed: Type.Integer() }, { title: 'Removed' });

/** The lyrics of the track playing. */
export const LyricsSchema = Type.Object(
  {
    trackId: Type.Integer({ description: 'The track they are for (the one playing when asked)' }),
    kind: Type.Union(
      [Type.Literal('synced'), Type.Literal('plain'), Type.Literal('instrumental'), Type.Literal('none')],
      {
        description: 'synced: timed lines; plain: words without timings; instrumental: no words; none: none found',
      },
    ),
    lines: Type.Array(
      Type.Object({
        atMs: Type.Integer({ description: 'When the line starts, in milliseconds from the start of the track' }),
        text: Type.String({ description: 'Its words; empty for a pause' }),
      }),
      { description: 'The timed lines, for kind synced; empty otherwise' },
    ),
    text: Nullable(Type.String({ description: 'The words without timings' })),
    source: Nullable(
      Type.Object({ name: Type.String(), url: Type.String() }, { description: 'Where they come from (LRCLIB)' }),
    ),
  },
  { title: 'Lyrics' },
);

/** A listening link as it is listed: never its code, which is shown once, when it is made. */
export const ListenLinkSchema = Type.Object(
  {
    id: Type.Integer(),
    createdBy: Nullable(Type.String({ description: 'Discord user ID; null for the host' })),
    createdByName: Nullable(Type.String()),
    createdAt: Type.Integer(),
    expiresAt: Type.Integer({ description: 'When it stops working, and its guests are out' }),
    guests: Type.Integer({ description: 'The browsers in with it now' }),
    maxGuests: Type.Integer({ description: 'The most browsers it lets in at once' }),
  },
  { title: 'ListenLink' },
);

export const ListenLinkCreatedSchema = Type.Object(
  {
    url: Type.String({ description: 'The link to give guests: shown in this answer only, stored only as a hash' }),
    link: ListenLinkSchema,
  },
  { title: 'ListenLinkCreated' },
);

/** A voice channel's sound: its volume and its preset (browsers listening along apply the preset). */
export const SoundSchema = Type.Object(
  {
    volume: Type.Integer({ description: "The voice channel's volume, in percent (each browser keeps its own)" }),
    preset: SoundPresetSchema,
  },
  { title: 'Sound' },
);

/** How many queued tracks a change moved to another place. */
export const MovedSchema = Type.Object({ moved: Type.Integer() }, { title: 'Moved' });

/** One thing a search found: a track not added yet, so without an ID (its address adds it). */
export const SearchResultSchema = Type.Object(
  {
    url: Type.String({ description: 'The page of the track: give it to add or play-now' }),
    title: Type.String(),
    uploader: Nullable(Type.String()),
    durationMs: Nullable(Type.Integer()),
    thumbnail: Nullable(Type.String()),
  },
  { title: 'SearchResult' },
);

export const SearchSchema = Type.Object(
  {
    query: Type.String({ description: 'The words searched for, as the search read them' }),
    results: Type.Array(SearchResultSchema),
  },
  { title: 'Search' },
);

/** A track a login liked, with when. */
export const LikedSchema = Type.Object(
  {
    track: TrackSchema,
    likedAt: Type.Integer({ description: 'When it was liked, in milliseconds since the epoch' }),
  },
  { title: 'Liked' },
);

/** A saved playlist as a file. */
export const PlaylistFileSchema = Type.Object(
  {
    name: Type.String(),
    format: Type.Union([Type.Literal('text'), Type.Literal('m3u'), Type.Literal('json')]),
    filename: Type.String({ description: 'A name to save it under' }),
    content: Type.String({ description: "The file's text" }),
  },
  { title: 'PlaylistFile' },
);

/** What an import made. */
export const ImportResultSchema = Type.Object(
  {
    playlist: PlaylistSchema,
    tracks: Type.Integer({ description: 'How many tracks the playlist holds' }),
    leftOut: Type.Integer({ description: 'Entries left out: not found, not an address, or past the limits' }),
  },
  { title: 'ImportResult' },
);

// Words in each language the panel speaks (the settings' labels and lines).
const WordsSchema = Type.Object({ en: Type.String(), ko: Type.String() });

/** One host setting as the settings page shows it: what it is, its value, where that comes from, and its state. */
export const SettingStateSchema = Type.Object(
  {
    name: Type.String({ description: 'Its environment variable, which is its name everywhere' }),
    group: Type.String({ description: 'The group of the settings page it is in' }),
    part: Nullable(Type.String({ description: 'The part of its group (the ways of logging in), if any' })),
    kind: Type.Union([
      Type.Literal('text'),
      Type.Literal('secret'),
      Type.Literal('url'),
      Type.Literal('integer'),
      Type.Literal('duration'),
      Type.Literal('size'),
      Type.Literal('boolean'),
      Type.Literal('choice'),
      Type.Literal('time'),
      Type.Literal('list'),
    ]),
    label: WordsSchema,
    help: WordsSchema,
    default: Nullable(Type.String({ description: 'The default as the environment would hold it' })),
    defaultNote: Nullable(WordsSchema),
    min: Nullable(Type.String()),
    max: Nullable(Type.String()),
    choices: Nullable(Type.Array(Type.String())),
    separator: Nullable(Type.String({ description: 'What a list’s items are written apart with' })),
    off: Nullable(Type.String({ description: 'The word that turns it off' })),
    words: Nullable(Type.Array(Type.String(), { description: 'Yes and no as it writes them' })),
    maxLength: Nullable(Type.Integer()),
    applies: Type.Union([Type.Literal('now'), Type.Literal('restart')]),
    bootstrap: Type.Boolean({ description: 'Needed before the database opens (kept in settings.json)' }),
    secret: Type.Boolean({ description: 'Never shown: only whether it is set' }),
    roles: Type.Array(Type.String(), { description: 'The services of a split jukecord it changes something in' }),
    value: Nullable(Type.String({ description: 'Its text as it reads after a restart; null when unset or a secret' })),
    set: Type.Boolean(),
    shown: Nullable(Type.String({ description: 'The database’s address in words, without its user or password' })),
    source: Type.Union([Type.Literal('environment'), Type.Literal('saved'), Type.Literal('default')]),
    variable: Nullable(Type.String({ description: 'The variable that sets it, when the environment does' })),
    editable: Type.Boolean(),
    locked: Nullable(Type.Union([Type.Literal('environment'), Type.Literal('split'), Type.Literal('start')])),
    revision: Type.Integer({ description: 'Its saved revision (0: never saved), for a change to say what it read' }),
    pending: Type.Boolean({ description: 'Its value waits for a restart' }),
    running: Nullable(Type.String({ description: 'The value in use while one waits for a restart' })),
    refused: Nullable(Type.String({ description: 'Why its saved value was refused when jukecord started' })),
  },
  { title: 'Setting' },
);

/** A database move as it stands. */
export const MoveSchema = Type.Object(
  {
    phase: Type.Union([
      Type.Literal('copying'),
      Type.Literal('copied'),
      Type.Literal('failed'),
      Type.Literal('switching'),
    ]),
    where: Type.String({ description: 'The target in words, never its user or password' }),
    kind: Nullable(Type.String()),
    replace: Type.Boolean(),
    startedAt: Type.Integer(),
    finishedAt: Nullable(Type.Integer()),
    rows: Type.Integer({ description: 'Rows copied so far' }),
    total: Type.Integer({ description: 'Rows there are to copy' }),
    table: Nullable(Type.String({ description: 'The table being copied' })),
    ms: Nullable(Type.Integer({ description: 'How long the copy took' })),
    error: Nullable(Type.String()),
  },
  { title: 'DatabaseMove' },
);

/** The move under way or done, and the last switch that did not finish. */
export const MoveStateSchema = Type.Object(
  {
    state: Nullable(MoveSchema),
    lastFailure: Nullable(
      Type.Object({ at: Type.Integer(), where: Type.String(), reason: Type.String() }, { title: 'MoveFailure' }),
    ),
  },
  { title: 'DatabaseMoveState' },
);

/** Every host setting, the restart that waits, and the database move. */
export const SettingsViewSchema = Type.Object(
  {
    groups: Type.Array(
      Type.Object({
        id: Type.String(),
        label: WordsSchema,
        parts: Type.Optional(Type.Array(Type.Object({ id: Type.String(), label: WordsSchema }))),
      }),
    ),
    settings: Type.Array(SettingStateSchema),
    restart: Type.Object({
      pending: Type.Array(Type.String(), { description: 'The settings whose change waits for a restart' }),
      supervisor: Type.String({
        description: 'What starts jukecord again: docker, kubernetes, systemd, launcher, none',
      }),
      refusal: Nullable(Type.String({ description: 'Why a restart cannot be asked for here' })),
    }),
    role: Type.Union([Type.Literal('all'), Type.Literal('core'), Type.Literal('edge')]),
    strays: Type.Array(Type.String(), { description: 'Saved names that are no setting kept where they are' }),
    move: MoveStateSchema,
    services: Type.Array(
      Type.Object(
        {
          role: Type.Union([Type.Literal('core'), Type.Literal('edge')]),
          name: Type.String({ description: "Its run's name on the bus" }),
          version: Type.String(),
          startedAt: Nullable(Type.Integer()),
          ready: Nullable(Type.Boolean()),
          seenAt: Type.Integer({ description: 'When it was last heard of' }),
        },
        { title: 'Service' },
      ),
      { description: 'The services of a split jukecord: the core and each edge (none in one process)' },
    ),
  },
  { title: 'HostSettings' },
);

/** What a change did: each setting it touched (a secret's values never), and every setting after it. */
export const SettingsChangedSchema = Type.Object(
  {
    changed: Type.Array(
      Type.Object({
        name: Type.String(),
        from: Nullable(Type.String()),
        to: Nullable(Type.String()),
        applies: Type.Union([Type.Literal('now'), Type.Literal('restart')]),
      }),
    ),
    view: SettingsViewSchema,
  },
  { title: 'SettingsChanged' },
);

/** What a test of a database's address found. */
export const DatabaseTestSchema = Type.Object(
  {
    ok: Type.Boolean({ description: 'Whether jukecord can move there' }),
    where: Type.String({ description: 'The address in words, never its user or password' }),
    kind: Nullable(Type.String()),
    server: Nullable(Type.String({ description: 'The program and its version' })),
    roundTripMs: Nullable(Type.Number()),
    schema: Nullable(Type.Integer({ description: 'The jukecord schema it holds (0: none)' })),
    latest: Type.Integer({ description: "This jukecord's schema" }),
    rows: Nullable(Type.Integer({ description: "The rows of jukecord's tables there" })),
    inUse: Type.Boolean({ description: 'It is the database jukecord uses now' }),
    newFile: Type.Boolean({ description: 'A SQLite file that is not there yet (the move makes it)' }),
    problem: Nullable(Type.String({ description: 'Why it cannot be moved to, in one sentence' })),
  },
  { title: 'DatabaseTest' },
);

/** A restart or a switch asked for: what starts jukecord again. */
export const RestartSchema = Type.Object(
  {
    supervisor: Type.String({ description: 'What starts jukecord again' }),
    restarts: Type.Boolean({ description: 'Whether it is started again (false: it stays stopped)' }),
  },
  { title: 'Restart' },
);
