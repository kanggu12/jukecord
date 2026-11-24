/**
 * The database: every table, reached through the repositories below; nothing else in jukecord writes SQL.
 *
 * The repositories hold their SQL text and hand it to an SQL executor (src/store/sql.ts), which runs it on the
 * database: SQLite by default (src/store/sqlite.ts, one file in the data directory), or PostgreSQL or MySQL/MariaDB
 * (src/store/postgres.ts, src/store/mysql.ts). The SQL is written once, in words all three read alike; the few that
 * differ come from the database's dialect (src/store/dialect.ts). Every method answers with a promise, as a network
 * database's driver does. A repository method that writes in several steps does it in a transaction
 * (`this.store.transaction(async () => ...)`); the statements inside find it by themselves.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isPreset, type SoundPreset } from '../core/sound.ts';
import {
  AUTOPLAY,
  type HistoryEntry,
  type LikedTrack,
  type NewTrack,
  type Playlist,
  type QueueItem,
  type Track,
} from '../core/types.ts';
import { dialectOf, type SqlDialect } from './dialect.ts';
import {
  MIGRATIONS,
  MYSQL_BASELINE,
  POSTGRES_BASELINE,
  SERVER_BASELINE_VERSION,
  TABLES,
  VERSION_TABLE,
  VERSION_TABLE_SQL,
} from './schema.ts';
import { isUniqueViolation, type SqlExecutor, type SqlRow, type SqlValue, StoreError } from './sql.ts';
import { SqliteExecutor } from './sqlite.ts';

// Raised for requests the data does not allow (defined beside the executor, which raises it too).
export { StoreError };

/** A row as the executor returns it. */
type Row = SqlRow;

// Column readers. The driver returns INTEGER as number (or bigint past 2^53, which jukecord never reaches); these
// turn a column into the type the domain objects use and fail loudly if the schema and the code disagree.
function int(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new StoreError(`column ${column} is not a number`);
}
function intOrNull(row: Row, column: string): number | null {
  return row[column] === null || row[column] === undefined ? null : int(row, column);
}
function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value === 'string') return value;
  throw new StoreError(`column ${column} is not text`);
}
function textOrNull(row: Row, column: string): string | null {
  return row[column] === null || row[column] === undefined ? null : text(row, column);
}
function realOrNull(row: Row, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  throw new StoreError(`column ${column} is not a number`);
}

// The row of a query that always returns one (a count, a total); none at all is a disagreement of schema and code.
async function one(row: Promise<Row | undefined>): Promise<Row> {
  const found = await row;
  if (!found) throw new StoreError('a query that always returns a row returned none');
  return found;
}

// The sizes a statement over many rows is cut into: a hundred rows at a time, then tens, then ones. Each row is a round
// trip to a network database when written alone (a thousand of them took over a second on PostgreSQL), and the few
// sizes give a statement one of three texts, each prepared once, however many rows there are.
function* batches<T>(items: readonly T[]): Generator<readonly T[]> {
  let at = 0;
  for (const size of [100, 10, 1]) {
    while (items.length - at >= size) {
      yield items.slice(at, at + size);
      at += size;
    }
  }
}

// The `?, ?, ?` of a list of values.
function marks(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

// The track columns, selected with a "t_" prefix wherever a track is joined to another table, so one reader serves
// tracks on their own and tracks inside queue items, history entries and playlists.
const TRACK_COLUMNS = `t.id AS t_id, t.source AS t_source, t.url AS t_url, t.title AS t_title, t.uploader AS t_uploader,
  t.duration_ms AS t_duration_ms, t.thumbnail AS t_thumbnail, t.loudness AS t_loudness`;

function trackFrom(row: Row): Track {
  return {
    id: int(row, 't_id'),
    source: text(row, 't_source'),
    url: text(row, 't_url'),
    title: text(row, 't_title'),
    uploader: textOrNull(row, 't_uploader'),
    durationMs: intOrNull(row, 't_duration_ms'),
    thumbnail: textOrNull(row, 't_thumbnail'),
    loudness: realOrNull(row, 't_loudness'),
  };
}

/** Options for opening the store; tests pass a fixed clock so timestamps can be compared. */
export interface StoreOptions {
  readonly now?: () => number;
}

/** The kinds of database jukecord runs on, as the status and the doctor name them. */
export type Backend = 'sqlite' | 'postgres' | 'mysql' | 'mariadb';

/** How the database answers right now, for the doctor and the readiness check. */
export interface DatabaseHealth {
  /** Whether it answered at all. */
  readonly ok: boolean;
  readonly backend: Backend;
  /** The program and its version ("PostgreSQL 18.7"). */
  readonly server: string;
  /** The schema version it is at (null when it did not answer). */
  readonly schema: number | null;
  /** How long one statement took there and back, in milliseconds (null when it did not answer). */
  readonly roundTripMs: number | null;
  /** Why it did not answer, when it did not. */
  readonly error: string | null;
}

// Whole days and hours in milliseconds: the statistics cut timestamps into them (see the dialect's quotient).
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** A day number (whole days since 1970-01-01) as its date, "YYYY-MM-DD". */
function dateOf(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

// The key of the lock a server database's migration is made under: PostgreSQL's advisory locks are numbers (two of
// them, so the pair names jukecord's schema and nothing of another program's), MySQL's are names.
const MIGRATION_LOCK = { postgres: [8795, 1], mysql: 'jukecord.schema' } as const;

/** The open database and its repositories. One per process. */
export class Store {
  /** The SQL executor every repository runs its statements through. */
  readonly sql: SqlExecutor;
  /** The words of SQL that differ on this database (see src/store/dialect.ts). */
  readonly dialect: SqlDialect;
  readonly tracks: TrackRepository;
  readonly queue: QueueRepository;
  readonly history: HistoryRepository;
  readonly playlists: PlaylistRepository;
  readonly playerState: PlayerStateRepository;
  readonly settings: SettingsRepository;
  readonly discord: DiscordRepository;
  readonly users: UserRepository;
  readonly sessions: SessionRepository;
  readonly tokens: TokenRepository;
  readonly voiceChannels: VoiceChannelRepository;
  readonly lyrics: LyricsRepository;
  readonly music: MusicRepository;
  readonly listenLinks: ListenLinkRepository;
  readonly guests: GuestSessionRepository;
  readonly likes: LikeRepository;

  private constructor(sql: SqlExecutor, now: () => number) {
    this.sql = sql;
    this.dialect = dialectOf(sql.dialect, sql.server.product);
    this.tracks = new TrackRepository(this, now);
    this.queue = new QueueRepository(this, now);
    this.history = new HistoryRepository(this);
    this.playlists = new PlaylistRepository(this, now);
    this.playerState = new PlayerStateRepository(this, now);
    this.settings = new SettingsRepository(this, now);
    this.discord = new DiscordRepository(this, now);
    this.users = new UserRepository(this, now);
    this.sessions = new SessionRepository(this, now);
    this.tokens = new TokenRepository(this, now);
    this.voiceChannels = new VoiceChannelRepository(this, now);
    this.lyrics = new LyricsRepository(this, now);
    this.music = new MusicRepository(this, now);
    this.listenLinks = new ListenLinkRepository(this, now);
    this.guests = new GuestSessionRepository(this, now);
    this.likes = new LikeRepository(this, now);
  }

  /**
   * Opens (creating if needed) the database and brings its schema up to date: a SQLite file by its path (":memory:"
   * for a throwaway one), or the database an SQL executor reaches.
   *
   * Refuses a database written by a newer jukecord: running old code on a newer schema could lose what the newer
   * version stored, and going back to an older version is a thing people do after a bad upgrade.
   */
  static async open(target: string | SqlExecutor, options: StoreOptions = {}): Promise<Store> {
    const sql = typeof target === 'string' ? SqliteExecutor.open(target) : target;
    const store = new Store(sql, options.now ?? Date.now);
    try {
      await store.migrate();
    } catch (error) {
      // A failed migration leaves the database untouched (it runs in a transaction); close it so the file is not held.
      await sql.close();
      throw error;
    }
    return store;
  }

  /** The SQLite file, or ":memory:" for the throwaway databases tests use; null for a database that is no file here. */
  get file(): string | null {
    return this.sql instanceof SqliteExecutor ? this.sql.file : null;
  }

  /** Which kind of database this is (MariaDB told from MySQL by what the server says it is). */
  get backend(): Backend {
    if (this.sql.dialect === 'sqlite') return 'sqlite';
    if (this.sql.dialect === 'postgres') return 'postgres';
    return this.sql.server.product === 'MariaDB' ? 'mariadb' : 'mysql';
  }

  /** Whether statements can still run (false once closed): what the readiness check asks. */
  isOpen(): boolean {
    return this.sql.isOpen;
  }

  /** The schema version the database is at: SQLite's user_version, or a server's jukecord_schema (0: none yet). */
  async schemaVersion(): Promise<number> {
    if (this.sql.dialect === 'sqlite') {
      const row = await this.sql.get('PRAGMA user_version');
      if (!row) throw new StoreError('the database says no schema version');
      return int(row, 'user_version');
    }
    // A database jukecord never ran on has no version table: version 0.
    if (!(await this.hasTable(VERSION_TABLE))) return 0;
    const row = await one(this.sql.get(`SELECT MAX(version) AS version FROM ${VERSION_TABLE}`));
    return intOrNull(row, 'version') ?? 0;
  }

  /** What SQLite's quick check says of the database: "ok", or the first damage it found (null: no answer). */
  async quickCheck(): Promise<string | null> {
    // A server checks its own files; what can be asked of it from here is whether it answers.
    if (this.sql.dialect !== 'sqlite') return (await this.sql.get('SELECT 1 AS ok')) ? 'ok' : null;
    const row = await this.sql.get('PRAGMA quick_check');
    return typeof row?.quick_check === 'string' ? row.quick_check : null;
  }

  /**
   * How the database answers now: whether it does, its schema version and the time of one statement there and back.
   * Never throws: a database that does not answer is an answer.
   */
  async health(): Promise<DatabaseHealth> {
    const server = `${this.sql.server.product} ${this.sql.server.version}`;
    const started = performance.now();
    try {
      await this.sql.get('SELECT 1 AS ok');
      const roundTripMs = Math.round((performance.now() - started) * 100) / 100;
      return { ok: true, backend: this.backend, server, schema: await this.schemaVersion(), roundTripMs, error: null };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, backend: this.backend, server, schema: null, roundTripMs: null, error: reason };
    }
  }

  /** How much room the database takes, in bytes, where it says (a SQLite file's size is read from the disk instead). */
  async size(): Promise<number | null> {
    const file = this.file;
    if (file !== null) {
      if (file === ':memory:') return null;
      // The file and what its write-ahead log holds that the file does not yet.
      let bytes = fs.statSync(file).size;
      try {
        bytes += fs.statSync(`${file}-wal`).size;
      } catch {
        // No log file at the moment.
      }
      return bytes;
    }
    const row =
      this.sql.dialect === 'postgres'
        ? await this.sql.get('SELECT pg_database_size(current_database()) AS bytes')
        : await this.sql.get(
            `SELECT COALESCE(SUM(data_length + index_length), 0) AS bytes FROM information_schema.tables
               WHERE table_schema = DATABASE()`,
          );
    return row ? intOrNull(row, 'bytes') : null;
  }

  // Whether the database has a table of this name (in the schema jukecord uses: PostgreSQL's current one, MySQL's
  // database).
  private async hasTable(name: string): Promise<boolean> {
    const where = this.sql.dialect === 'postgres' ? 'current_schema()' : 'DATABASE()';
    const row = await this.sql.get(
      `SELECT 1 AS found FROM information_schema.tables WHERE table_schema = ${where} AND table_name = ?`,
      [name],
    );
    return row !== undefined;
  }

  // Applies every migration newer than the database, each in its own transaction with its version.
  private async migrate(): Promise<void> {
    if (this.sql.dialect !== 'sqlite') return this.migrateServer();
    const current = await this.schemaVersion();
    const latest = MIGRATIONS.at(-1)?.version ?? 0;
    refuseNewer(current, latest);
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      await this.transaction(async () => {
        await this.sql.exec(migration.sql);
        // PRAGMA takes no bound parameters; the version is a number from the code, not from input.
        await this.sql.exec(`PRAGMA user_version = ${migration.version}`);
      });
    }
  }

  /**
   * A server database's migrations: the baseline (schema 8 at once) on a database jukecord never ran on, then every
   * migration after it, each with its version. Under a lock of the server's, so two jukecords starting at once on one
   * database (a core and an edge) do not both make the tables: the second waits and finds them made.
   */
  private async migrateServer(): Promise<void> {
    const dialect = this.sql.dialect === 'postgres' ? 'postgres' : 'mysql';
    const latest = MIGRATIONS.at(-1)?.version ?? 0;
    // Read before the lock as well: a database at the latest version (every start but the first) needs no lock.
    const before = await this.schemaVersion();
    refuseNewer(before, latest);
    if (before === latest) return;
    await this.transaction(async () => {
      // PostgreSQL's advisory lock ends with the transaction; MySQL's with the connection or its release below.
      if (dialect === 'postgres') {
        await this.sql.get('SELECT pg_advisory_xact_lock(?, ?) AS locked', [...MIGRATION_LOCK.postgres]);
      } else {
        const got = await this.sql.get('SELECT GET_LOCK(?, 60) AS locked', [MIGRATION_LOCK.mysql]);
        if (!got || intOrNull(got, 'locked') !== 1) {
          throw new StoreError('another jukecord has been bringing this database up to date for a minute; try again');
        }
      }
      try {
        // Read again under the lock: another jukecord may have done it while this one waited.
        const current = await this.schemaVersion();
        refuseNewer(current, latest);
        if (current < SERVER_BASELINE_VERSION) await this.baseline(dialect, current);
        for (const migration of MIGRATIONS) {
          if (migration.version <= Math.max(current, SERVER_BASELINE_VERSION)) continue;
          const sql = migration[dialect];
          if (sql === undefined) throw new StoreError(`migration ${migration.version} has no ${dialect} statements`);
          await this.sql.exec(sql);
          await this.setVersion(migration.version);
        }
      } finally {
        if (dialect === 'mysql') await this.sql.get('SELECT RELEASE_LOCK(?) AS released', [MIGRATION_LOCK.mysql]);
      }
    });
  }

  // Makes schema 8 on a database jukecord never ran on (or finishes a MySQL baseline stopped halfway: the version
  // table is there, empty). A database that already has tables of these names, of another program's or of a jukecord
  // stopped before the version table was made, is refused rather than mixed with.
  private async baseline(dialect: 'postgres' | 'mysql', current: number): Promise<void> {
    const versioned = await this.hasTable(VERSION_TABLE);
    if (!versioned) {
      const taken: string[] = [];
      for (const table of TABLES) if (await this.hasTable(table.name)) taken.push(table.name);
      if (taken.length > 0) {
        throw new StoreError(
          `the database already has tables jukecord did not make (${taken.join(', ')}); give jukecord an empty database`,
        );
      }
      await this.sql.exec(VERSION_TABLE_SQL[dialect]);
    } else if (current !== 0) {
      throw new StoreError(`the database is at schema ${current}, which no jukecord on ${dialect} wrote`);
    }
    await this.sql.exec(dialect === 'postgres' ? POSTGRES_BASELINE : MYSQL_BASELINE);
    await this.setVersion(SERVER_BASELINE_VERSION);
  }

  // Records a server database's schema version (the table's one row).
  private async setVersion(version: number): Promise<void> {
    const changed = await this.sql.run(`UPDATE ${VERSION_TABLE} SET version = ?, updated_at = ?`, [
      version,
      Date.now(),
    ]);
    if (changed.changes === 0) {
      await this.sql.run(`INSERT INTO ${VERSION_TABLE} (version, updated_at) VALUES (?, ?)`, [version, Date.now()]);
    }
  }

  /**
   * Runs `fn` in a transaction: everything it writes is kept, or nothing is if it throws.
   *
   * Nested calls become savepoints, so a repository method that uses a transaction can be called from inside another.
   * The repository methods `fn` calls run their statements in it by themselves; `fn` awaits database work only (see
   * SqlExecutor.transaction), since everyone else's statements wait for its end. `snapshot` is for several reads of
   * one moment that write nothing (see TransactionOptions).
   */
  transaction<T>(fn: () => Promise<T> | T, options?: { readonly snapshot?: boolean }): Promise<T> {
    return this.sql.transaction(fn, options);
  }

  /**
   * Inserts one row and gives the id the database made for it (or, for an upsert built with `id`, the id of the row
   * it met): RETURNING id where the database has it, the id the INSERT reports where not (MySQL).
   */
  async insertId(sql: string, params: readonly SqlValue[]): Promise<number> {
    if (this.dialect.returning) {
      return int(await one(this.sql.get(sql.endsWith(' RETURNING id') ? sql : `${sql} RETURNING id`, params)), 'id');
    }
    const result = await this.sql.run(sql, params);
    if (result.lastId === null) throw new StoreError('the database did not say the id of the row it made');
    return result.lastId;
  }

  /** Writes a consistent copy of the database to `target` (an online backup; the bot keeps running). */
  async backup(target: string): Promise<void> {
    const sqlite = this.sqlite('backed up');
    // VACUUM INTO refuses to overwrite, so a backup never replaces an older one by accident.
    if (fs.existsSync(target)) throw new StoreError(`${target} already exists`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await sqlite.vacuumInto(target);
  }

  /**
   * backup(), written by a worker thread with a connection of its own (SqliteExecutor.vacuumIntoAside): a copy of a
   * large database takes seconds, and the main thread goes on answering meanwhile. An in-memory database (the tests')
   * has no file for another connection to open, and is copied here.
   */
  async backupAside(target: string): Promise<void> {
    const sqlite = this.sqlite('backed up');
    if (sqlite.file === ':memory:') return this.backup(target);
    if (fs.existsSync(target)) throw new StoreError(`${target} already exists`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Written under another name, and named a backup once whole: jukecord stopped in the middle (the worker ends with
    // it) leaves a ".partial" file, which no list takes for a backup (app/backups.ts clears it away later).
    const partial = `${target}.partial`;
    await sqlite.vacuumIntoAside(partial);
    fs.renameSync(partial, target);
  }

  /** Closes the database, once no transaction holds it; closing twice does nothing. */
  close(): Promise<void> {
    return this.sql.close();
  }

  // The SQLite executor under the store, for what only SQLite does here (a backup is a copy of its file).
  private sqlite(what: string): SqliteExecutor {
    if (this.sql instanceof SqliteExecutor) return this.sql;
    throw new StoreError(`a ${this.sql.dialect} database is not ${what} by jukecord yet`);
  }
}

// A database at a schema newer than this jukecord's is refused (see Store.open).
function refuseNewer(current: number, latest: number): void {
  if (current > latest) {
    throw new StoreError(
      `the database is at schema ${current}, newer than this jukecord knows (${latest}); use the newer jukecord or restore a backup`,
    );
  }
}

/** Tracks: one row per distinct source, updated when a later lookup knows more about it. */
export class TrackRepository {
  private readonly store: Store;
  private readonly now: () => number;
  // The upsert of a track in this database's words: fields a lookup does not know keep what was known (see upsert()).
  private readonly upsertSql: string;

  constructor(store: Store, now: () => number) {
    this.store = store;
    this.now = now;
    const keep = (column: string) =>
      [
        column,
        (incoming: (name: string) => string, current: (name: string) => string) =>
          `COALESCE(${incoming(column)}, ${current(column)})`,
      ] as const;
    this.upsertSql = store.dialect.upsert({
      table: 'tracks',
      columns: ['source', 'url', 'title', 'uploader', 'duration_ms', 'thumbnail', 'created_at', 'updated_at'],
      // The source itself on SQLite, its hash on the servers (see src/store/dialect.ts).
      key: [store.dialect.sourceKey],
      update: ['url', 'title', keep('uploader'), keep('duration_ms'), keep('thumbnail'), 'updated_at'],
      id: true,
    });
  }

  /**
   * Stores a track looked up from a site, or refreshes the row for the same source, and returns it.
   *
   * Fields the new lookup does not know (null) keep their old value: a flat playlist listing has no thumbnails, and
   * adding a playlist must not erase the thumbnails of tracks already known.
   */
  async upsert(track: NewTrack): Promise<Track> {
    // The write and the read back in one go: an upsert of the same source meanwhile cannot come between them.
    return this.store.transaction(async () => {
      const now = this.now();
      // A whole number of milliseconds: a site's length in seconds times 1000 can come out a hair off one, which
      // PostgreSQL's BIGINT refuses.
      const durationMs = track.durationMs === null ? null : Math.round(track.durationMs);
      // The id whether the row was inserted or updated; read back whole through the one reader.
      const id = await this.store.insertId(this.upsertSql, [
        track.source,
        track.url,
        track.title,
        track.uploader,
        durationMs,
        track.thumbnail,
        now,
        now,
      ]);
      const stored = await this.get(id);
      if (!stored) throw new StoreError('the track just written cannot be read back');
      return stored;
    });
  }

  /** The track with this ID, or null. */
  async get(id: number): Promise<Track | null> {
    const row = await this.store.sql.get(`SELECT ${TRACK_COLUMNS} FROM tracks t WHERE t.id = ?`, [id]);
    return row ? trackFrom(row) : null;
  }

  /** The track for a normalised source address, or null when it was never added. */
  async bySource(source: string): Promise<Track | null> {
    // By the source's hash and the text on the servers, whose unique index is on the hash.
    const { where, params } = this.store.dialect.bySource('t', source);
    const row = await this.store.sql.get(`SELECT ${TRACK_COLUMNS} FROM tracks t WHERE ${where}`, params);
    return row ? trackFrom(row) : null;
  }

  /** Records the measured loudness, so the next play of this track skips the measurement. */
  async setLoudness(id: number, lufs: number): Promise<void> {
    await this.store.sql.run('UPDATE tracks SET loudness = ?, updated_at = ? WHERE id = ?', [lufs, this.now(), id]);
  }
}

// Columns of a queue item joined with its track.
const QUEUE_SELECT = `SELECT q.id, q.guild_id, q.position, q.added_by, q.added_at, ${TRACK_COLUMNS}
  FROM queue_items q JOIN tracks t ON t.id = q.track_id`;

function queueItemFrom(row: Row): QueueItem {
  return {
    id: int(row, 'id'),
    guildId: text(row, 'guild_id'),
    position: int(row, 'position'),
    addedBy: textOrNull(row, 'added_by'),
    addedAt: int(row, 'added_at'),
    track: trackFrom(row),
  };
}

/** Each server's upcoming tracks, in order. The track playing now is not in here (see PlayerStateRepository). */
export class QueueRepository {
  private readonly store: Store;
  private readonly now: () => number;

  constructor(store: Store, now: () => number) {
    this.store = store;
    this.now = now;
  }

  /** The queue of one server, first to play first. */
  async list(guildId: string): Promise<QueueItem[]> {
    // id breaks ties in the unlikely case of equal positions, so the order is always the same.
    const rows = await this.store.sql.all(`${QUEUE_SELECT} WHERE q.guild_id = ? ORDER BY q.position, q.id`, [guildId]);
    return rows.map((row) => queueItemFrom(row));
  }

  /** How many tracks wait in a server's queue. */
  async count(guildId: string): Promise<number> {
    return int(
      await one(this.store.sql.get('SELECT COUNT(*) AS n FROM queue_items WHERE guild_id = ?', [guildId])),
      'n',
    );
  }

  /** One queue item by its ID, or null. */
  async get(itemId: number): Promise<QueueItem | null> {
    const row = await this.store.sql.get(`${QUEUE_SELECT} WHERE q.id = ?`, [itemId]);
    return row ? queueItemFrom(row) : null;
  }

  /**
   * Inserts tracks at `index` (0 = play next, the queue length = the end) and returns the new items in order.
   *
   * Tracks already queued are queued again: a person who adds a song twice wants it twice. Duplicates are removed
   * only when someone asks (the dedupe action).
   */
  insert(guildId: string, trackIds: readonly number[], index: number, addedBy: string | null): Promise<QueueItem[]> {
    return this.store.transaction(async () => {
      const length = await this.count(guildId);
      // An index past the end means the end; a negative one is a caller's mistake.
      if (index < 0) throw new StoreError(`position ${index} is before the start of the queue`);
      const at = Math.min(index, length);
      // Make room: everything from `at` onwards moves down by the number of new tracks.
      await this.store.sql.run('UPDATE queue_items SET position = position + ? WHERE guild_id = ? AND position >= ?', [
        trackIds.length,
        guildId,
        at,
      ]);
      const now = this.now();
      // In batches of rows, in their order, so the IDs follow the places.
      const rows = trackIds.map((trackId, offset): SqlValue[] => [guildId, at + offset, trackId, addedBy, now]);
      for (const batch of batches(rows)) {
        await this.store.sql.run(
          `INSERT INTO queue_items (guild_id, position, track_id, added_by, added_at) VALUES ${batch
            .map(() => '(?, ?, ?, ?, ?)')
            .join(', ')}`,
          batch.flat(),
        );
      }
      // Read the rows back so callers get complete items, tracks included: the new items hold exactly the places
      // at..at+n-1 now (positions are 0..n-1, and the others moved out of the way above).
      const items = (
        await this.store.sql.all(
          `${QUEUE_SELECT} WHERE q.guild_id = ? AND q.position >= ? AND q.position < ? ORDER BY q.position, q.id`,
          [guildId, at, at + trackIds.length],
        )
      ).map((row) => queueItemFrom(row));
      if (items.length !== trackIds.length) throw new StoreError('a queue item just written cannot be read back');
      return items;
    });
  }

  /** Whether a track is in a server's queue, read without reading the queue itself. */
  async has(guildId: string, trackId: number): Promise<boolean> {
    const row = await this.store.sql.get(
      'SELECT 1 AS found FROM queue_items WHERE guild_id = ? AND track_id = ? LIMIT 1',
      [guildId, trackId],
    );
    return row !== undefined;
  }

  /** Removes one item; false when it is not in that server's queue (already played or removed by someone else). */
  remove(guildId: string, itemId: number): Promise<boolean> {
    return this.store.transaction(async () => {
      // The place it had, so the items after it move up with one statement instead of a renumbering: RETURNING says
      // it where the database has it; MySQL reads it first, taking the row for this transaction (FOR UPDATE).
      const row = this.store.dialect.returning
        ? await this.store.sql.get('DELETE FROM queue_items WHERE id = ? AND guild_id = ? RETURNING position', [
            itemId,
            guildId,
          ])
        : await this.store.sql.get('SELECT position FROM queue_items WHERE id = ? AND guild_id = ? FOR UPDATE', [
            itemId,
            guildId,
          ]);
      if (!row) return false;
      if (!this.store.dialect.returning) {
        await this.store.sql.run('DELETE FROM queue_items WHERE id = ? AND guild_id = ?', [itemId, guildId]);
      }
      await this.closeGap(guildId, int(row, 'position'));
      return true;
    });
  }

  /**
   * Removes several items in one transaction with one renumbering at the end, and returns how many were there.
   *
   * Removing them one by one renumbers the whole queue after each: 900 duplicates of a thousand-track queue took most
   * of a second, during which no server's music was fed.
   */
  async removeMany(guildId: string, itemIds: readonly number[]): Promise<number> {
    // Nothing asked: nothing written, not even an empty transaction.
    if (itemIds.length === 0) return 0;
    return this.store.transaction(async () => {
      let removed = 0;
      // In batches, each a lookup of its IDs by the primary key; one already gone (played meanwhile) changes nothing.
      for (const batch of batches(itemIds)) {
        removed += (
          await this.store.sql.run(`DELETE FROM queue_items WHERE guild_id = ? AND id IN (${marks(batch.length)})`, [
            guildId,
            ...batch,
          ])
        ).changes;
      }
      // The gaps they left are closed once, for all of them.
      if (removed > 0) await this.compact(guildId);
      return removed;
    });
  }

  /** Moves one item to `index` (counted in the queue as it is before the move). */
  async move(guildId: string, itemId: number, index: number): Promise<void> {
    await this.store.transaction(async () => {
      const { ids, at } = await this.order(guildId);
      const from = ids.indexOf(itemId);
      if (from === -1) throw new StoreError(`item ${itemId} is not in the queue`);
      if (index < 0 || index >= ids.length)
        throw new StoreError(`position ${index} is outside the queue (0-${ids.length - 1})`);
      // Take it out and put it back at the target place.
      ids.splice(from, 1);
      ids.splice(index, 0, itemId);
      await this.writeOrder(guildId, ids, at);
    });
  }

  /** Puts the queue in exactly this order; `itemIds` must hold every item once (used by shuffle and drag-and-drop). */
  async reorder(guildId: string, itemIds: readonly number[]): Promise<void> {
    await this.store.transaction(async () => {
      const { ids, at } = await this.order(guildId);
      const current = new Set(ids);
      const wanted = new Set(itemIds);
      // The same items exactly once each: a missing, extra or repeated ID means the caller's view is out of date.
      const same =
        wanted.size === itemIds.length && wanted.size === current.size && [...wanted].every((id) => current.has(id));
      if (!same) throw new StoreError('the new order does not hold exactly the items in the queue');
      await this.writeOrder(guildId, itemIds, at);
    });
  }

  /** Removes every item of a server's queue and returns how many there were. */
  async clear(guildId: string): Promise<number> {
    return (await this.store.sql.run('DELETE FROM queue_items WHERE guild_id = ?', [guildId])).changes;
  }

  /** Takes the first item out of the queue (the next to play), or null when the queue is empty. */
  shift(guildId: string): Promise<QueueItem | null> {
    return this.store.transaction(async () => {
      // Only the first row is read (the index on guild and position finds it): every track change used to read the
      // whole queue, a thousand rows with their tracks, to take one.
      const row = await this.store.sql.get(`${QUEUE_SELECT} WHERE q.guild_id = ? ORDER BY q.position, q.id LIMIT 1`, [
        guildId,
      ]);
      if (!row) return null;
      const first = queueItemFrom(row);
      await this.store.sql.run('DELETE FROM queue_items WHERE id = ?', [first.id]);
      await this.closeGap(guildId, first.position);
      return first;
    });
  }

  // The item IDs in queue order, and the place each has now.
  private async order(guildId: string): Promise<{ ids: number[]; at: Map<number, number> }> {
    const rows = await this.store.sql.all(
      'SELECT id, position FROM queue_items WHERE guild_id = ? ORDER BY position, id',
      [guildId],
    );
    return {
      ids: rows.map((row) => int(row, 'id')),
      at: new Map(rows.map((row) => [int(row, 'id'), int(row, 'position')])),
    };
  }

  // Rewrites positions to 0..n-1 in the current order, after a removal left a gap.
  private async compact(guildId: string): Promise<void> {
    const { ids, at } = await this.order(guildId);
    await this.writeOrder(guildId, ids, at);
  }

  // Closes the gap one removed item left at `position`: everything after it moves up one place, in one statement.
  // Positions stay 0..n-1 (every change keeps them so), and the order of the rest does not change.
  private async closeGap(guildId: string, position: number): Promise<void> {
    await this.store.sql.run('UPDATE queue_items SET position = position - 1 WHERE guild_id = ? AND position > ?', [
      guildId,
      position,
    ]);
  }

  // Writes position = index for each ID; rows already in place (`at` says where each is) are left alone. The rows that
  // move are written in batches, each one UPDATE that sets every row of it to its own place.
  private async writeOrder(guildId: string, ids: readonly number[], at: ReadonlyMap<number, number>): Promise<void> {
    const moves = ids.flatMap((id, index) => (at.get(id) === index ? [] : [[id, index] as const]));
    const place = this.store.dialect.wholeNumber;
    for (const batch of batches(moves)) {
      await this.store.sql.run(
        `UPDATE queue_items SET position = CASE id ${batch.map(() => `WHEN ? THEN ${place}`).join(' ')} END
           WHERE guild_id = ? AND id IN (${marks(batch.length)})`,
        [...batch.flat(), guildId, ...batch.map(([id]) => id)],
      );
    }
  }

  /** Each item's ID and who added it, in queue order, without the tracks: what taking turns needs to know. */
  async owners(guildId: string): Promise<{ id: number; addedBy: string | null }[]> {
    const rows = await this.store.sql.all(
      'SELECT id, added_by FROM queue_items WHERE guild_id = ? ORDER BY position, id',
      [guildId],
    );
    return rows.map((row) => ({ id: int(row, 'id'), addedBy: textOrNull(row, 'added_by') }));
  }

  /** How many items one person added to a server's queue (null: the host's, and a panel's without a login). */
  async countBy(guildId: string, addedBy: string | null): Promise<number> {
    // A null-safe comparison, not =: it matches null too.
    const row = await one(
      this.store.sql.get(
        `SELECT COUNT(*) AS n FROM queue_items WHERE guild_id = ? AND ${this.store.dialect.same('added_by')}`,
        [guildId, addedBy],
      ),
    );
    return int(row, 'n');
  }

  /**
   * Where the run of tracks autoplay queued at the end of a server's queue starts: the place after the last track a
   * person (or the host) queued, 0 when only autoplay's are there, and null when the queue does not end in autoplay's.
   * A person's track added "at the end" goes there, before autoplay's, which only fill a queue that ran out.
   */
  async autoplayTail(guildId: string): Promise<number | null> {
    // Read from the index on (guild, position): the last row, and the last row that is not autoplay's.
    const last = await this.store.sql.get(
      'SELECT position, added_by FROM queue_items WHERE guild_id = ? ORDER BY position DESC, id DESC LIMIT 1',
      [guildId],
    );
    if (!last || textOrNull(last, 'added_by') !== AUTOPLAY) return null;
    const person = await this.store.sql.get(
      `SELECT position FROM queue_items WHERE guild_id = ? AND (added_by IS NULL OR added_by != ?)
         ORDER BY position DESC, id DESC LIMIT 1`,
      [guildId, AUTOPLAY],
    );
    return person ? int(person, 'position') + 1 : 0;
  }
}

// The most history rows kept per server: years of listening for a group of friends, and a bound on the database.
export const HISTORY_KEEP = 10_000;

/** Played tracks, newest first. */
export class HistoryRepository {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /** Records that a track played (or played for a while before a skip). */
  async add(entry: {
    guildId: string;
    trackId: number;
    addedBy: string | null;
    playedAt: number;
    playedMs: number;
  }): Promise<HistoryEntry> {
    // The write, the pruning and the read back in one go, as one change.
    return this.store.transaction(async () => {
      const id = await this.store.insertId(
        'INSERT INTO history (guild_id, track_id, added_by, played_at, played_ms) VALUES (?, ?, ?, ?, ?)',
        [entry.guildId, entry.trackId, entry.addedBy, entry.playedAt, entry.playedMs],
      );
      // Pruned every hundred plays, not every play: the delete walks a server's history.
      if (id % 100 === 0) await this.prune(entry.guildId);
      const stored = await this.get(id);
      if (!stored) throw new StoreError('the history entry just written cannot be read back');
      return stored;
    });
  }

  /** Deletes a server's oldest entries beyond `keep` and returns how many went. */
  async prune(guildId: string, keep = HISTORY_KEEP): Promise<number> {
    // The oldest entry kept, then everything older than it: two statements, because MySQL refuses a DELETE that reads
    // the table it deletes from. An entry added in between is newer than the cut, so it stays either way.
    const cut = await this.store.sql.get(
      'SELECT id FROM history WHERE guild_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?',
      // keep 0 keeps the newest, as the single statement this was did (SQLite reads a negative OFFSET as none).
      [guildId, Math.max(0, keep - 1)],
    );
    if (!cut) return 0;
    const result = await this.store.sql.run('DELETE FROM history WHERE guild_id = ? AND id < ?', [
      guildId,
      int(cut, 'id'),
    ]);
    return result.changes;
  }

  /** One entry by ID, or null. */
  async get(id: number): Promise<HistoryEntry | null> {
    const row = await this.store.sql.get(
      `SELECT h.id, h.guild_id, h.added_by, h.played_at, h.played_ms, ${TRACK_COLUMNS}
         FROM history h JOIN tracks t ON t.id = h.track_id WHERE h.id = ?`,
      [id],
    );
    return row ? historyFrom(row) : null;
  }

  /** Whether a server's history has a track (asked of the index on server and track, for each cover shown). */
  async has(guildId: string, trackId: number): Promise<boolean> {
    const row = await this.store.sql.get('SELECT 1 AS found FROM history WHERE guild_id = ? AND track_id = ? LIMIT 1', [
      guildId,
      trackId,
    ]);
    return row !== undefined;
  }

  /** The newest `limit` entries of a server; `beforeId` pages further back. */
  async list(guildId: string, limit = 50, beforeId?: number): Promise<HistoryEntry[]> {
    // Newest first by ID, the order entries were written in, which is also what the cursor pages by: the index on
    // (guild, id) gives the page directly. Sorting by the time played needed a sort of every row of the server, and a
    // clock set back between two plays would have put an entry on two pages or none.
    const rows = await this.store.sql.all(
      `SELECT h.id, h.guild_id, h.added_by, h.played_at, h.played_ms, ${TRACK_COLUMNS}
         FROM history h JOIN tracks t ON t.id = h.track_id
         WHERE h.guild_id = ? AND h.id < ?
         ORDER BY h.id DESC LIMIT ?`,
      // Without a cursor every ID qualifies; MAX_SAFE_INTEGER stands in for "no upper bound".
      [guildId, beforeId ?? Number.MAX_SAFE_INTEGER, limit],
    );
    return rows.map((row) => historyFrom(row));
  }

  /**
   * Listening figures of a server since `since`: totals, plays per day and per hour of the day, the most played
   * tracks and the people whose tracks were played most.
   *
   * Days and hours are in the viewer's time zone: `offsetMs` is added to every timestamp before it is cut into days,
   * so "Tuesday" means the viewer's Tuesday. Only days with plays are listed; the caller fills the gaps.
   */
  async stats(guildId: string, since: number, offsetMs: number, top = 10): Promise<HistoryStats> {
    const d = this.store.dialect;
    // The viewer's offset as whole milliseconds, added to each timestamp before it is cut into days and hours (in
    // SQL, by whole-number division, the same way on every database; the dates are written here, below).
    const offset = Math.trunc(offsetMs);
    const day = d.quotient(`played_at + ${d.wholeNumber}`, DAY_MS);
    const hour = d.quotient(`(played_at + ${d.wholeNumber}) % ${DAY_MS}`, HOUR_MS);
    // Every question of one moment's history (one snapshot), so the totals and the lists agree.
    return this.store.transaction(
      async () => {
        const sql = this.store.sql;
        // Autoplay is not a person: its plays count as plays, but not among the people who added (NULL is not counted).
        const totals = await one(
          sql.get(
            `SELECT COUNT(*) AS plays, COALESCE(SUM(played_ms), 0) AS played_ms, COUNT(DISTINCT track_id) AS tracks,
                  COUNT(DISTINCT CASE WHEN ${d.same('added_by')} THEN NULL ELSE COALESCE(added_by, '') END) AS people
           FROM history WHERE guild_id = ? AND played_at >= ?`,
            [AUTOPLAY, guildId, since],
          ),
        );
        // Each day with plays, by its number (whole days since 1970 of the viewer's time), in order.
        const days = await sql.all(
          `SELECT ${day} AS day, COUNT(*) AS plays, SUM(played_ms) AS played_ms
           FROM history WHERE guild_id = ? AND played_at >= ? GROUP BY day ORDER BY day`,
          [offset, guildId, since],
        );
        const hours = await sql.all(
          `SELECT ${hour} AS hour, COUNT(*) AS plays FROM history WHERE guild_id = ? AND played_at >= ? GROUP BY hour`,
          [offset, guildId, since],
        );
        // Ties are broken by listening time, then by the track's ID, so the order is the same on every run. Counted
        // per track first, then joined to the tracks: a query every database reads alike (a track's columns beside a
        // count are not in the GROUP BY otherwise).
        const tracks = await sql.all(
          `SELECT c.plays, c.played_ms, ${TRACK_COLUMNS}
           FROM (SELECT track_id, COUNT(*) AS plays, SUM(played_ms) AS played_ms FROM history
                   WHERE guild_id = ? AND played_at >= ? GROUP BY track_id) c
           JOIN tracks t ON t.id = c.track_id
           ORDER BY c.plays DESC, c.played_ms DESC, c.track_id LIMIT ?`,
          [guildId, since, top],
        );
        // Whose picks played most (plays of what each one added): people and the host, not autoplay. The host's null
        // first among equals, as SQLite orders it.
        const people = await sql.all(
          `SELECT added_by, COUNT(*) AS plays, SUM(played_ms) AS played_ms
           FROM history WHERE guild_id = ? AND played_at >= ? AND ${d.differs('added_by')}
           GROUP BY added_by ORDER BY plays DESC, played_ms DESC, ${d.nullsFirst('added_by')} LIMIT ?`,
          [guildId, since, AUTOPLAY, top],
        );
        // Twenty-four slots, zero where nothing played, so a chart can draw every hour.
        const byHour = Array.from({ length: 24 }, () => 0);
        for (const row of hours) byHour[int(row, 'hour')] = int(row, 'plays');
        return {
          plays: int(totals, 'plays'),
          playedMs: int(totals, 'played_ms'),
          tracks: int(totals, 'tracks'),
          people: int(totals, 'people'),
          days: days.map((row) => ({
            day: dateOf(int(row, 'day')),
            plays: int(row, 'plays'),
            playedMs: int(row, 'played_ms'),
          })),
          hours: byHour,
          topTracks: tracks.map((row) => ({
            track: trackFrom(row),
            plays: int(row, 'plays'),
            playedMs: int(row, 'played_ms'),
          })),
          topPeople: people.map((row) => ({
            userId: textOrNull(row, 'added_by'),
            plays: int(row, 'plays'),
            playedMs: int(row, 'played_ms'),
          })),
        };
      },
      { snapshot: true },
    );
  }

  /**
   * A server's time in music from `since` up to `until` (Wrapped): the totals, the days with music, the top tracks
   * and people, plays by day of the week and by hour, the longest day, the first play and the song of the time.
   *
   * Days, weekdays and hours are the viewer's, as in stats(): `offsetMs` is added to every timestamp first. A day is
   * the whole number of days since the epoch of that sum, which whole-number division gives on every database without
   * formatting a date for each row (the offset is cast to a whole number for it: node:sqlite binds every JavaScript
   * number as a real, and a real's division keeps the fraction). Five questions, each one pass over the server's plays of the time by
   * the index on (server, time played): per track, per person, per day and per hour, and the first play; the totals,
   * the weekdays, the longest day and the song are summed from those answers here (the seven questions this took
   * before cost twice the time on a year of 10,000 plays).
   */
  async wrapped(guildId: string, since: number, until: number, offsetMs: number, top = 5): Promise<HistoryWrapped> {
    const d = this.store.dialect;
    // The viewer's offset as whole milliseconds, and each timestamp's day and hour in the viewer's time.
    const offset = Math.trunc(offsetMs);
    const day = d.quotient(`h.played_at + ${d.wholeNumber}`, DAY_MS);
    const hour = d.quotient(`(h.played_at + ${d.wholeNumber}) % ${DAY_MS}`, HOUR_MS);
    // Every question of one moment's history (one snapshot), so the totals and the lists agree.
    return this.store.transaction(
      async () => {
        const sql = this.store.sql;
        // The plays of the time, the same three bound values in every question below.
        const span = 'h.guild_id = ? AND h.played_at >= ? AND h.played_at < ?';
        const within = [guildId, since, until] as const;
        // Each track's plays, time and days with plays; its title and the rest are read for the few shown only.
        const perTrack = (
          await sql.all(
            `SELECT h.track_id, COUNT(*) AS plays, SUM(h.played_ms) AS played_ms, COUNT(DISTINCT ${day}) AS days
             FROM history h WHERE ${span} GROUP BY h.track_id`,
            [offset, ...within],
          )
        ).map((row) => ({
          id: int(row, 'track_id'),
          plays: int(row, 'plays'),
          playedMs: int(row, 'played_ms'),
          days: int(row, 'days'),
        }));
        // Each person's plays: people and the host, not autoplay, which is no person (as in the statistics).
        const perPerson = (
          await sql.all(
            `SELECT h.added_by, COUNT(*) AS plays, SUM(h.played_ms) AS played_ms FROM history h
             WHERE ${span} AND ${d.differs('h.added_by')} GROUP BY h.added_by`,
            [...within, AUTOPLAY],
          )
        ).map((row) => ({
          userId: textOrNull(row, 'added_by'),
          plays: int(row, 'plays'),
          playedMs: int(row, 'played_ms'),
        }));
        const perDay = (
          await sql.all(
            `SELECT ${day} AS day, COUNT(*) AS plays, SUM(h.played_ms) AS played_ms
             FROM history h WHERE ${span} GROUP BY day`,
            [offset, ...within],
          )
        ).map((row) => ({ day: int(row, 'day'), plays: int(row, 'plays'), playedMs: int(row, 'played_ms') }));
        const hours = await sql.all(
          `SELECT ${hour} AS hour, COUNT(*) AS plays FROM history h WHERE ${span} GROUP BY hour`,
          [offset, ...within],
        );
        const first = await sql.get(
          `SELECT h.id, h.guild_id, h.added_by, h.played_at, h.played_ms, ${TRACK_COLUMNS}
           FROM history h JOIN tracks t ON t.id = h.track_id WHERE ${span} ORDER BY h.played_at, h.id LIMIT 1`,
          [...within],
        );
        // The orders, as the statistics break ties: the most plays, then the most time, then the lowest ID (a person: the
        // host first, as SQLite sorts a null first, then by ID).
        const byPlays = <T extends { plays: number; playedMs: number }>(a: T, b: T) =>
          b.plays - a.plays || b.playedMs - a.playedMs;
        const tracks = [...perTrack].sort((a, b) => byPlays(a, b) || a.id - b.id).slice(0, top);
        // Two IDs compared as SQLite compares text (byte by byte), the host's null before any.
        const byId = (a: string | null, b: string | null) =>
          a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1;
        const people = [...perPerson].sort((a, b) => byPlays(a, b) || byId(a.userId, b.userId)).slice(0, top);
        // The song of the time: the track that came back on the most days (a song played every week all year over one
        // played fifty times in one night), then the most plays, the most time, the lowest ID.
        const song = [...perTrack].sort((a, b) => b.days - a.days || byPlays(a, b) || a.id - b.id)[0];
        // The day with the most time listened; the earlier of two equal days.
        const longest = [...perDay].sort((a, b) => b.playedMs - a.playedMs || b.plays - a.plays || a.day - b.day)[0];
        // Seven and twenty-four slots, zero where nothing played, so a chart can draw every one. Day 0 of the epoch was a
        // Thursday: (day + 4) % 7 is the day of the week, Sunday being 0.
        const byWeekday = Array.from({ length: 7 }, () => 0);
        for (const day of perDay) byWeekday[(day.day + 4) % 7] = (byWeekday[(day.day + 4) % 7] ?? 0) + day.plays;
        const byHour = Array.from({ length: 24 }, () => 0);
        for (const row of hours) byHour[int(row, 'hour')] = int(row, 'plays');
        // A track as the database has it, for the few shown.
        const track = async (id: number) => {
          const found = await this.store.tracks.get(id);
          if (!found) throw new StoreError(`track ${id} of the history cannot be read`);
          return found;
        };
        // The top tracks read one after the other, in their order, then the song's.
        const topTracks: { track: Track; plays: number; playedMs: number }[] = [];
        for (const entry of tracks) {
          topTracks.push({ track: await track(entry.id), plays: entry.plays, playedMs: entry.playedMs });
        }
        const songTrack = song ? await track(song.id) : null;
        return {
          plays: perTrack.reduce((sum, entry) => sum + entry.plays, 0),
          playedMs: perTrack.reduce((sum, entry) => sum + entry.playedMs, 0),
          tracks: perTrack.length,
          people: perPerson.length,
          days: perDay.length,
          topTracks,
          topPeople: people,
          weekdays: byWeekday,
          hours: byHour,
          longestDay: longest
            ? {
                day: dateOf(longest.day),
                plays: longest.plays,
                playedMs: longest.playedMs,
              }
            : null,
          firstPlay: first ? historyFrom(first) : null,
          song:
            song && songTrack
              ? { track: songTrack, plays: song.plays, playedMs: song.playedMs, days: song.days }
              : null,
        };
      },
      { snapshot: true },
    );
  }

  /** The newest play's ID of a server (0 when it has none): what changes whenever its history does. */
  async newest(guildId: string): Promise<number> {
    const row = await one(this.store.sql.get('SELECT MAX(id) AS id FROM history WHERE guild_id = ?', [guildId]));
    return intOrNull(row, 'id') ?? 0;
  }

  /**
   * The months a server has plays in, newest first (YYYY-MM in the viewer's time zone), and how far back its history
   * reaches: its oldest play, and whether it holds as many plays as it keeps (older ones were let go).
   */
  async months(guildId: string, offsetMs: number): Promise<{ months: string[]; oldest: number | null; full: boolean }> {
    const d = this.store.dialect;
    // Both questions of one moment's history (one snapshot).
    return this.store.transaction(
      async () => {
        // The days with plays (whole days of the viewer's time, as in stats()), made months here: a month is not a
        // number of days, and the databases write dates each their own way.
        const rows = await this.store.sql.all(
          `SELECT DISTINCT ${d.quotient(`played_at + ${d.wholeNumber}`, DAY_MS)} AS day FROM history WHERE guild_id = ?`,
          [Math.trunc(offsetMs), guildId],
        );
        const reach = await one(
          this.store.sql.get('SELECT MIN(played_at) AS oldest, COUNT(*) AS plays FROM history WHERE guild_id = ?', [
            guildId,
          ]),
        );
        // Each month once, newest first ("YYYY-MM" sorts as the months do).
        const months = [...new Set(rows.map((row) => dateOf(int(row, 'day')).slice(0, 7)))].sort().reverse();
        return {
          months,
          oldest: intOrNull(reach, 'oldest'),
          full: int(reach, 'plays') >= HISTORY_KEEP,
        };
      },
      { snapshot: true },
    );
  }

  /** The tracks of a server's newest `count` plays, newest first, each once. */
  async recentTrackIds(guildId: string, count: number): Promise<number[]> {
    const rows = await this.store.sql.all('SELECT track_id FROM history WHERE guild_id = ? ORDER BY id DESC LIMIT ?', [
      guildId,
      count,
    ]);
    return [...new Set(rows.map((row) => int(row, 'track_id')))];
  }

  /**
   * Every track a server played (within the history kept), with how often it played there and how many logins liked
   * it, for autoplay's picks; with its length, so a track over the limit is not picked.
   */
  async playCounts(
    guildId: string,
  ): Promise<{ trackId: number; plays: number; likes: number; durationMs: number | null }[]> {
    const rows = await this.store.sql.all(
      // The length is grouped by as well (it is the track's own, one per track): every database then takes it
      // beside the counts (MySQL's ONLY_FULL_GROUP_BY and PostgreSQL refuse a column the grouping does not name).
      `SELECT h.track_id, COUNT(*) AS plays, t.duration_ms,
                (SELECT COUNT(*) FROM likes l WHERE l.track_id = h.track_id) AS likes
         FROM history h JOIN tracks t ON t.id = h.track_id
         WHERE h.guild_id = ? GROUP BY h.track_id, t.duration_ms`,
      [guildId],
    );
    return rows.map((row) => ({
      trackId: int(row, 'track_id'),
      plays: int(row, 'plays'),
      likes: int(row, 'likes'),
      durationMs: intOrNull(row, 'duration_ms'),
    }));
  }
}

/** A server's time in music, for Wrapped (see HistoryRepository.wrapped). */
export interface HistoryWrapped {
  readonly plays: number;
  readonly playedMs: number;
  /** Distinct tracks played. */
  readonly tracks: number;
  /** Distinct people whose tracks were played; the host counts as one and autoplay as none, as in the statistics. */
  readonly people: number;
  /** The days with any music. */
  readonly days: number;
  readonly topTracks: readonly { readonly track: Track; readonly plays: number; readonly playedMs: number }[];
  readonly topPeople: readonly { readonly userId: string | null; readonly plays: number; readonly playedMs: number }[];
  /** Plays by day of the week, Sunday first (as JavaScript and SQLite count them). */
  readonly weekdays: readonly number[];
  /** Plays by hour of the day, index 0 being midnight to one. */
  readonly hours: readonly number[];
  /** The day with the most time listened (YYYY-MM-DD), or null with no plays. */
  readonly longestDay: { readonly day: string; readonly plays: number; readonly playedMs: number } | null;
  /** The first play of the time. */
  readonly firstPlay: HistoryEntry | null;
  /** The song of the time: the track played on the most days, then the most times, then the longest. */
  readonly song: {
    readonly track: Track;
    readonly plays: number;
    readonly playedMs: number;
    readonly days: number;
  } | null;
}

/** Listening figures for the statistics screen (see HistoryRepository.stats). */
export interface HistoryStats {
  readonly plays: number;
  readonly playedMs: number;
  /** Distinct tracks played. */
  readonly tracks: number;
  /** Distinct people whose tracks were played; the host (tracks added without a Discord login) counts as one. */
  readonly people: number;
  readonly days: readonly { readonly day: string; readonly plays: number; readonly playedMs: number }[];
  /** Plays per hour of the day, index 0 being midnight to one. */
  readonly hours: readonly number[];
  readonly topTracks: readonly { readonly track: Track; readonly plays: number; readonly playedMs: number }[];
  readonly topPeople: readonly { readonly userId: string | null; readonly plays: number; readonly playedMs: number }[];
}

function historyFrom(row: Row): HistoryEntry {
  return {
    id: int(row, 'id'),
    guildId: text(row, 'guild_id'),
    addedBy: textOrNull(row, 'added_by'),
    playedAt: int(row, 'played_at'),
    playedMs: int(row, 'played_ms'),
    track: trackFrom(row),
  };
}

/** Saved playlists, unique by name within a server. */
export class PlaylistRepository {
  private readonly store: Store;
  private readonly now: () => number;
  // A playlist saved under a name: the server's list of that name kept (only its time changes), or a new one.
  private readonly upsertSql: string;

  constructor(store: Store, now: () => number) {
    this.store = store;
    this.now = now;
    this.upsertSql = store.dialect.upsert({
      table: 'playlists',
      columns: ['guild_id', 'name', 'created_by', 'created_at', 'updated_at'],
      key: ['guild_id', 'name'],
      update: ['updated_at'],
      id: true,
    });
  }

  /** Saves tracks under a name, replacing the list if the name exists (saving twice keeps the latest). */
  async save(guildId: string, name: string, trackIds: readonly number[], createdBy: string | null): Promise<Playlist> {
    const clean = name.trim();
    // An empty name cannot be shown or typed back; a very long one breaks every list it appears in.
    if (clean.length === 0 || clean.length > 100) throw new StoreError('a playlist name is 1 to 100 characters');
    return this.store.transaction(async () => {
      const now = this.now();
      // The id of the list, new or kept.
      const id = await this.store.insertId(this.upsertSql, [guildId, clean, createdBy, now, now]);
      // Replace the items wholesale: the saved list is exactly what was passed (written in batches of rows).
      await this.store.sql.run('DELETE FROM playlist_items WHERE playlist_id = ?', [id]);
      const rows = trackIds.map((trackId, position): SqlValue[] => [id, position, trackId]);
      for (const batch of batches(rows)) {
        await this.store.sql.run(
          `INSERT INTO playlist_items (playlist_id, position, track_id) VALUES ${batch.map(() => '(?, ?, ?)').join(', ')}`,
          batch.flat(),
        );
      }
      const saved = await this.get(id);
      if (!saved) throw new StoreError('the playlist just written cannot be read back');
      return saved;
    });
  }

  /** One playlist by ID, or null. */
  async get(id: number): Promise<Playlist | null> {
    const row = await this.store.sql.get(
      `SELECT p.*, (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id = p.id) AS size
         FROM playlists p WHERE p.id = ?`,
      [id],
    );
    return row ? playlistFrom(row) : null;
  }

  /** A server's playlist by name (names are matched exactly, after trimming), or null. */
  async find(guildId: string, name: string): Promise<Playlist | null> {
    // The name looked up and the list read in one go: a rename or a save meanwhile cannot come between them.
    return this.store.transaction(async () => {
      const row = await this.store.sql.get('SELECT id FROM playlists WHERE guild_id = ? AND name = ?', [
        guildId,
        name.trim(),
      ]);
      return row ? this.get(int(row, 'id')) : null;
    });
  }

  /** A server's playlists, most recently saved first. */
  async list(guildId: string): Promise<Playlist[]> {
    const rows = await this.store.sql.all(
      `SELECT p.*, (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id = p.id) AS size
         FROM playlists p WHERE p.guild_id = ? ORDER BY p.updated_at DESC, p.id DESC`,
      [guildId],
    );
    return rows.map((row) => playlistFrom(row));
  }

  /** Whether one of a server's playlists holds a track (a server has a few lists of a few hundred tracks at most). */
  async has(guildId: string, trackId: number): Promise<boolean> {
    const row = await this.store.sql.get(
      `SELECT 1 AS found FROM playlist_items i JOIN playlists p ON p.id = i.playlist_id
         WHERE p.guild_id = ? AND i.track_id = ? LIMIT 1`,
      [guildId, trackId],
    );
    return row !== undefined;
  }

  /** The tracks of a playlist in their saved order. */
  async tracks(playlistId: number): Promise<Track[]> {
    const rows = await this.store.sql.all(
      `SELECT ${TRACK_COLUMNS} FROM playlist_items i JOIN tracks t ON t.id = i.track_id
         WHERE i.playlist_id = ? ORDER BY i.position`,
      [playlistId],
    );
    return rows.map((row) => trackFrom(row));
  }

  /** Renames a playlist; fails when the server already has one by the new name. */
  async rename(playlistId: number, name: string): Promise<Playlist> {
    const clean = name.trim();
    if (clean.length === 0 || clean.length > 100) throw new StoreError('a playlist name is 1 to 100 characters');
    // The rename and the read back in one go.
    return this.store.transaction(async () => {
      try {
        await this.store.sql.run('UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?', [
          clean,
          this.now(),
          playlistId,
        ]);
      } catch (error) {
        // The UNIQUE (guild_id, name) constraint is the check; turn its error (each driver's own) into one people can
        // read.
        if (isUniqueViolation(error)) throw new StoreError(`a playlist named "${clean}" exists`);
        throw error;
      }
      const renamed = await this.get(playlistId);
      if (!renamed) throw new StoreError(`playlist ${playlistId} does not exist`);
      return renamed;
    });
  }

  /** Deletes a playlist and its items; false when there was none. */
  async remove(playlistId: number): Promise<boolean> {
    return (await this.store.sql.run('DELETE FROM playlists WHERE id = ?', [playlistId])).changes > 0;
  }
}

function playlistFrom(row: Row): Playlist {
  return {
    id: int(row, 'id'),
    guildId: text(row, 'guild_id'),
    name: text(row, 'name'),
    createdBy: textOrNull(row, 'created_by'),
    createdAt: int(row, 'created_at'),
    updatedAt: int(row, 'updated_at'),
    size: int(row, 'size'),
  };
}

/** The repeat modes of a player. */
export type RepeatMode = 'off' | 'track' | 'queue';

/**
 * What a player does when its queue runs out: nothing, a track from the server's own plays, or one from YouTube's mix
 * of the last track (the server's plays when there is none).
 */
export type AutoplayMode = 'off' | 'history' | 'related';

/** What a server was playing when it was last saved. */
export interface SavedPlayerState {
  readonly guildId: string;
  /** The track that was current (playing or paused), or null when nothing was. */
  readonly trackId: number | null;
  readonly addedBy: string | null;
  /** "playing", "paused" or "idle"; a restart brings "playing" back as paused, so nobody is surprised by sound. */
  readonly status: 'playing' | 'paused' | 'idle';
  readonly positionMs: number;
  /** What happens at the end of a track: nothing special, the same track again, or the track back to the queue's end. */
  readonly repeat: RepeatMode;
  readonly updatedAt: number;
  /** What happens when the queue runs out (see AutoplayMode). */
  readonly autoplay: AutoplayMode;
}

/** The current track of each server, written on every change so a restart can come back to it. */
export class PlayerStateRepository {
  private readonly store: Store;
  private readonly now: () => number;
  // A server's state, replacing the one before.
  private readonly upsertSql: string;

  constructor(store: Store, now: () => number) {
    this.store = store;
    this.now = now;
    this.upsertSql = store.dialect.upsert({
      table: 'player_state',
      columns: ['guild_id', 'track_id', 'added_by', 'status', 'position_ms', 'repeat', 'updated_at', 'autoplay'],
      key: ['guild_id'],
      update: ['track_id', 'added_by', 'status', 'position_ms', 'repeat', 'updated_at', 'autoplay'],
    });
  }

  // The autoplay mode may be left out (callers from before it existed): it is off then.
  async save(
    state: Omit<SavedPlayerState, 'updatedAt' | 'autoplay'> & { readonly autoplay?: AutoplayMode },
  ): Promise<void> {
    await this.store.sql.run(this.upsertSql, [
      state.guildId,
      state.trackId,
      state.addedBy,
      state.status,
      Math.max(0, Math.round(state.positionMs)),
      state.repeat,
      this.now(),
      state.autoplay ?? 'off',
    ]);
  }

  async load(guildId: string): Promise<SavedPlayerState | null> {
    const row = await this.store.sql.get('SELECT * FROM player_state WHERE guild_id = ?', [guildId]);
    return row ? savedStateFrom(row) : null;
  }

  /** Every saved server, for restoring them all at start. */
  async all(): Promise<SavedPlayerState[]> {
    const rows = await this.store.sql.all('SELECT * FROM player_state ORDER BY guild_id');
    return rows.map((row) => savedStateFrom(row));
  }
}

function savedStateFrom(row: Row): SavedPlayerState {
  const status = text(row, 'status');
  // An unknown status (a newer version's, or a hand edit) is read as idle rather than trusted.
  const known = status === 'playing' || status === 'paused' ? status : 'idle';
  const repeat = text(row, 'repeat');
  const autoplay = text(row, 'autoplay');
  return {
    guildId: text(row, 'guild_id'),
    trackId: intOrNull(row, 'track_id'),
    addedBy: textOrNull(row, 'added_by'),
    status: known,
    positionMs: int(row, 'position_ms'),
    // Read like the status: an unknown value falls back to the safe default.
    repeat: repeat === 'track' || repeat === 'queue' ? repeat : 'off',
    updatedAt: int(row, 'updated_at'),
    // The same for autoplay: a value this version does not know is off.
    autoplay: autoplay === 'history' || autoplay === 'related' ? autoplay : 'off',
  };
}

/** Per-server choices. */
export interface GuildSettings {
  /** The role allowed to change the queue; null means every member of the server may. */
  readonly djRoleId: string | null;
  /** The text channel where jukecord tells the server about trouble; null for nowhere. */
  readonly alertsChannelId: string | null;
}

export class SettingsRepository {
  private readonly store: Store;
  private readonly now: () => number;

  constructor(store: Store, now: () => number) {
    this.store = store;
    this.now = now;
  }

  /** A server's settings; a server never configured gets the defaults. */
  async get(guildId: string): Promise<GuildSettings> {
    const row = await this.store.sql.get(
      'SELECT dj_role_id, alerts_channel_id FROM guild_settings WHERE guild_id = ?',
      [guildId],
    );
    return {
      djRoleId: row ? textOrNull(row, 'dj_role_id') : null,
      alertsChannelId: row ? textOrNull(row, 'alerts_channel_id') : null,
    };
  }

  /** Sets or clears (null) the text channel where jukecord tells the server about trouble. */
  async setAlertsChannel(guildId: string, channelId: string | null): Promise<void> {
    await this.store.sql.run(this.setting('alerts_channel_id'), [guildId, channelId, this.now()]);
  }

  // The upsert of one of a server's settings (with its time), the others left as they are or at their defaults.
  private setting(column: string): string {
    return this.store.dialect.upsert({
      table: 'guild_settings',
      columns: ['guild_id', column, 'updated_at'],
      key: ['guild_id'],
      update: [column, 'updated_at'],
    });
  }

  /** The servers that chose an alerts channel, with it. */
  async withAlerts(): Promise<{ readonly guildId: string; readonly channelId: string }[]> {
    const rows = await this.store.sql.all(
      'SELECT guild_id, alerts_channel_id FROM guild_settings WHERE alerts_channel_id IS NOT NULL',
    );
    return rows.map((row) => ({ guildId: text(row, 'guild_id'), channelId: text(row, 'alerts_channel_id') }));
  }

  /** Sets or clears (null) the role that may change the queue. */
  async setDjRole(guildId: string, roleId: string | null): Promise<void> {
    await this.store.sql.run(this.setting('dj_role_id'), [guildId, roleId, this.now()]);
  }

  /** How a server's people share the music (see CommunitySettings); a server never configured gets the defaults. */
  async community(guildId: string): Promise<CommunitySettings> {
    const row = await this.store.sql.get(
      'SELECT vote_skip, take_turns, person_limit, stay, volume, sound FROM guild_settings WHERE guild_id = ?',
      [guildId],
    );
    // No row yet: the same defaults the columns have (see the schema), so a new server and an old one agree.
    if (!row) return COMMUNITY_DEFAULTS;
    const sound = text(row, 'sound');
    return {
      voteSkip: int(row, 'vote_skip') !== 0,
      takeTurns: int(row, 'take_turns') !== 0,
      personLimit: int(row, 'person_limit'),
      stay: int(row, 'stay') !== 0,
      volume: int(row, 'volume'),
      // Read like the repeat mode: a value this version does not know falls back to the plain sound.
      sound: isPreset(sound) ? sound : 'off',
    };
  }

  /** Changes some of a server's community settings, leaving the others as they are. */
  async setCommunity(guildId: string, changes: Partial<CommunitySettings>): Promise<void> {
    // The columns come from this table in the code, never from input; the values are bound.
    const columns: [string, number | string][] = [];
    if (changes.voteSkip !== undefined) columns.push(['vote_skip', changes.voteSkip ? 1 : 0]);
    if (changes.takeTurns !== undefined) columns.push(['take_turns', changes.takeTurns ? 1 : 0]);
    if (changes.personLimit !== undefined) columns.push(['person_limit', changes.personLimit]);
    if (changes.stay !== undefined) columns.push(['stay', changes.stay ? 1 : 0]);
    if (changes.volume !== undefined) columns.push(['volume', changes.volume]);
    if (changes.sound !== undefined) columns.push(['sound', changes.sound]);
    // Nothing to change: nothing written.
    if (columns.length === 0) return;
    const names = columns.map(([name]) => name);
    await this.store.sql.run(
      this.store.dialect.upsert({
        table: 'guild_settings',
        columns: ['guild_id', 'updated_at', ...names],
        key: ['guild_id'],
        update: [...names, 'updated_at'],
      }),
      [guildId, this.now(), ...columns.map(([, value]) => value)],
    );
  }
}

/** How a server's people share the music, and how its voice channel sounds. */
export interface CommunitySettings {
  /** Whether Skip from someone without the DJ role counts as a vote to skip (when the server has a DJ role). */
  readonly voteSkip: boolean;
  /** Whether a track added goes after the last one of the first round in which its person has no track yet. */
  readonly takeTurns: boolean;
  /** The most tracks one person may have in the queue at once; 0 for no limit. */
  readonly personLimit: number;
  /** Whether the bot stays in its voice channel when everyone has left it. */
  readonly stay: boolean;
  /** The voice channel's volume, in percent (0 to 200). */
  readonly volume: number;
  /** The voice channel's sound preset, which browsers listening along apply too. */
  readonly sound: SoundPreset;
}

/** A server's community settings before anyone chose them (the columns' own defaults). */
export const COMMUNITY_DEFAULTS: CommunitySettings = {
  voteSkip: true,
  takeTurns: false,
  personLimit: 0,
  stay: false,
  volume: 100,
  sound: 'off',
};

/** What jukecord remembers about Discord per server: the fingerprint of the commands it registered there. */
export class DiscordRepository {
  private readonly store: Store;
  private readonly now: () => number;

  constructor(store: Store, now: () => number) {
    this.store = store;
    this.now = now;
  }

  /** The fingerprint of the commands registered in a server, or null when none were. */
  async commandsHash(guildId: string): Promise<string | null> {
    const row = await this.store.sql.get('SELECT hash FROM discord_commands WHERE guild_id = ?', [guildId]);
    return row ? text(row, 'hash') : null;
  }

  /** Forgets that commands were registered in a server (the bot left it, and Discord removed them). */
  async clearCommandsHash(guildId: string): Promise<void> {
    await this.store.sql.run('DELETE FROM discord_commands WHERE guild_id = ?', [guildId]);
  }

  async setCommandsHash(guildId: string, hash: string): Promise<void> {
    await this.store.sql.run(
      this.store.dialect.upsert({
        table: 'discord_commands',
        columns: ['guild_id', 'hash', 'updated_at'],
        key: ['guild_id'],
        update: ['hash', 'updated_at'],
      }),
      [guildId, hash, this.now()],
    );
  }
}

/** Someone from Discord, as the panel shows them. */
export interface Person {
  readonly id: string;
  /** The display name (server nickname aside): global name, else user name. */
  readonly name: string;
  /** The avatar's hash, from which the panel builds the picture's address; null for the default avatar. */
  readonly avatar: string | null;
}

/** People jukecord has met, by Discord user ID. */
export class UserRepository {
  private readonly store: Store;
  private readonly now: () => number;

  constructor(store: Store, now: () => number) {
    this.store = store;
    this.now = now;
  }

  /** Records or refreshes a person; names and avatars change, so the newest wins. */
  async upsert(person: Person): Promise<void> {
    await this.store.sql.run(
      this.store.dialect.upsert({
        table: 'users',
        columns: ['id', 'name', 'avatar', 'updated_at'],
        key: ['id'],
        update: ['name', 'avatar', 'updated_at'],
      }),
      [person.id, person.name, person.avatar, this.now()],
    );
  }

  async get(id: string): Promise<Person | null> {
    const row = await this.store.sql.get('SELECT id, name, avatar FROM users WHERE id = ?', [id]);
    return row ? { id: text(row, 'id'), name: text(row, 'name'), avatar: textOrNull(row, 'avatar') } : null;
  }

  /** The people among `ids` that are known; unknown IDs are simply absent from the map. */
  async many(ids: Iterable<string>): Promise<Map<string, Person>> {
    const people = new Map<string, Person>();
    // One lookup per distinct ID: a queue of a thousand tracks is added by a handful of people.
    for (const id of new Set(ids)) {
      const person = await this.get(id);
      if (person) people.set(id, person);
    }
    return people;
  }
}

/** Whose login or token it is: the host (the machine running jukecord) or a Discord user. */
export type PrincipalKind = 'host' | 'user';

/** Whose panel login it is: the host's, a Discord user's, or a friend's the host let in with a login link. */
export type SessionKind = PrincipalKind | 'friend';

/** One panel login. */
export interface SessionRow {
  /** SHA-256 of the cookie's secret, in hex. */
  readonly idHash: string;
  readonly kind: SessionKind;
  /** The Discord user, for kind "user". */
  readonly userId: string | null;
  /** The token the panel sends with every change, so another site cannot make changes with the cookie. */
  readonly csrf: string;
  /** What it may do: everything its login may (admin), or a friend's view (read) or control. */
  readonly scope: TokenScope;
  readonly createdAt: number;
  readonly seenAt: number;
  readonly expiresAt: number;
}

/** Panel logins, looked up by the hash of the cookie's secret. */
export class SessionRepository {
  private readonly store: Store;
  private readonly now: () => number;

  constructor(store: Store, now: () => number) {
    this.store = store;
    this.now = now;
  }

  async create(session: Omit<SessionRow, 'createdAt' | 'seenAt'>): Promise<SessionRow> {
    const now = this.now();
    await this.store.sql.run(
      `INSERT INTO sessions (id_hash, kind, user_id, csrf, scope, created_at, seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [session.idHash, session.kind, session.userId, session.csrf, session.scope, now, now, session.expiresAt],
    );
    return { ...session, createdAt: now, seenAt: now };
  }

  /** The login with this hash, or null when there is none or it has expired (an expired one is removed). */
  async get(idHash: string): Promise<SessionRow | null> {
    const row = await this.store.sql.get('SELECT * FROM sessions WHERE id_hash = ?', [idHash]);
    if (!row) return null;
    const session = sessionFrom(row);
    if (session.expiresAt <= this.now()) {
      await this.remove(idHash);
      return null;
    }
    return session;
  }

  /** Notes that the login was used now (shown nowhere yet; kept for pruning logins nobody uses). */
  async touch(idHash: string): Promise<void> {
    await this.store.sql.run('UPDATE sessions SET seen_at = ? WHERE id_hash = ?', [this.now(), idHash]);
  }

  async remove(idHash: string): Promise<boolean> {
    return (await this.store.sql.run('DELETE FROM sessions WHERE id_hash = ?', [idHash])).changes > 0;
  }

  /** Deletes expired logins and returns how many went. */
  async prune(): Promise<number> {
    return (await this.store.sql.run('DELETE FROM sessions WHERE expires_at <= ?', [this.now()])).changes;
  }
}

function sessionFrom(row: Row): SessionRow {
  const kind = text(row, 'kind');
  const scope = text(row, 'scope');
  return {
    idHash: text(row, 'id_hash'),
    // Anything but "host" or "friend" is read as a user: a stored row cannot widen itself into host rights.
    kind: kind === 'host' || kind === 'friend' ? kind : 'user',
    userId: textOrNull(row, 'user_id'),
    csrf: text(row, 'csrf'),
    // An unknown scope (a hand edit) is read as the narrowest one, as a token's is; a friend's is never wider than
    // control.
    scope:
      scope === 'admin' && kind !== 'friend' ? 'admin' : scope === 'control' || scope === 'admin' ? 'control' : 'read',
    createdAt: int(row, 'created_at'),
    seenAt: int(row, 'seen_at'),
    expiresAt: int(row, 'expires_at'),
  };
}

/** What an API token may do: look, change the music, or also manage settings and tokens. */
export type TokenScope = 'read' | 'control' | 'admin';

/** An API token as it is listed (never with its secret or hash). */
export interface TokenRow {
  readonly id: number;
  readonly name: string;
  readonly kind: PrincipalKind;
  readonly userId: string | null;
  readonly scope: TokenScope;
  readonly createdAt: number;
  readonly usedAt: number | null;
}

/** API tokens, looked up by the hash of the secret. */
export class TokenRepository {
  private readonly store: Store;
  private readonly now: () => number;

  constructor(store: Store, now: () => number) {
    this.store = store;
    this.now = now;
  }

  async create(token: {
    hash: string;
    name: string;
    kind: PrincipalKind;
    userId: string | null;
    scope: TokenScope;
  }): Promise<TokenRow> {
    const name = token.name.trim();
    if (name.length === 0 || name.length > 100) throw new StoreError('a token name is 1 to 100 characters');
    // The write and the read back in one go (MySQL says only the new id; the row is read after it).
    return this.store.transaction(async () => {
      const id = await this.store.insertId(
        'INSERT INTO api_tokens (hash, name, kind, user_id, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [token.hash, name, token.kind, token.userId, token.scope, this.now()],
      );
      const made = await this.get(id);
      if (!made) throw new StoreError('the token just written cannot be read back');
      return made;
    });
  }

  /** The token with this hash, or null. */
  async byHash(hash: string): Promise<TokenRow | null> {
    const row = await this.store.sql.get(
      'SELECT id, name, kind, user_id, scope, created_at, used_at FROM api_tokens WHERE hash = ?',
      [hash],
    );
    return row ? tokenFrom(row) : null;
  }

  async get(id: number): Promise<TokenRow | null> {
    const row = await this.store.sql.get(
      'SELECT id, name, kind, user_id, scope, created_at, used_at FROM api_tokens WHERE id = ?',
      [id],
    );
    return row ? tokenFrom(row) : null;
  }

  /** Every token (for the host), or the tokens of one user. Newest first. */
  async list(userId?: string): Promise<TokenRow[]> {
    const rows =
      userId === undefined
        ? await this.store.sql.all(
            'SELECT id, name, kind, user_id, scope, created_at, used_at FROM api_tokens ORDER BY id DESC',
          )
        : await this.store.sql.all(
            `SELECT id, name, kind, user_id, scope, created_at, used_at FROM api_tokens
               WHERE kind = 'user' AND user_id = ? ORDER BY id DESC`,
            [userId],
          );
    return rows.map((row) => tokenFrom(row));
  }

  /** Notes that the token was used now, so a list can show tokens nobody uses any more. */
  async touch(id: number): Promise<void> {
    await this.store.sql.run('UPDATE api_tokens SET used_at = ? WHERE id = ?', [this.now(), id]);
  }

  async remove(id: number): Promise<boolean> {
    return (await this.store.sql.run('DELETE FROM api_tokens WHERE id = ?', [id])).changes > 0;
  }
}

function tokenFrom(row: Row): TokenRow {
  const scope = text(row, 'scope');
  return {
    id: int(row, 'id'),
    name: text(row, 'name'),
    kind: text(row, 'kind') === 'host' ? 'host' : 'user',
    userId: textOrNull(row, 'user_id'),
    // An unknown scope (a hand edit) is read as the narrowest one.
    scope: scope === 'admin' || scope === 'control' ? scope : 'read',
    createdAt: int(row, 'created_at'),
    usedAt: intOrNull(row, 'used_at'),
  };
}

/**
 * The voice channel the bot is in, per server, kept for a restart: jukecord goes back to it when people are there
 * (see discord/rejoin.ts). One per server; leaving forgets it.
 */
export class VoiceChannelRepository {
  private readonly store: Store;
  private readonly now: () => number;

  constructor(store: Store, now: () => number) {
    this.store = store;
    this.now = now;
  }

  /** Keeps the channel the bot is in now (replacing the one before). */
  async remember(guildId: string, channelId: string): Promise<void> {
    // The row of a server kept already is changed in place, so it keeps its place in the order they were first kept.
    await this.store.sql.run(
      this.store.dialect.upsert({
        table: 'voice_channels',
        columns: ['guild_id', 'channel_id', 'updated_at'],
        key: ['guild_id'],
        update: ['channel_id', 'updated_at'],
      }),
      [guildId, channelId, this.now()],
    );
  }

  /** Forgets a server's channel (the bot left it). */
  async forget(guildId: string): Promise<void> {
    await this.store.sql.run('DELETE FROM voice_channels WHERE guild_id = ?', [guildId]);
  }

  /** The channel kept for a server, or null when there is none. */
  async get(guildId: string): Promise<string | null> {
    const row = await this.store.sql.get('SELECT channel_id FROM voice_channels WHERE guild_id = ?', [guildId]);
    return row ? text(row, 'channel_id') : null;
  }

  /** Notes that the bot said in a server's channel that it came back, now. */
  async told(guildId: string): Promise<void> {
    await this.store.sql.run('UPDATE voice_channels SET told_at = ? WHERE guild_id = ?', [this.now(), guildId]);
  }

  /** When the bot last said in a server's channel that it came back (ms since 1970), or null for never. */
  async toldAt(guildId: string): Promise<number | null> {
    const row = await this.store.sql.get('SELECT told_at FROM voice_channels WHERE guild_id = ?', [guildId]);
    return row ? intOrNull(row, 'told_at') : null;
  }

  /** Every channel kept, in the order they were first kept. */
  async all(): Promise<{ readonly guildId: string; readonly channelId: string }[]> {
    // The order they were first kept in: SQLite's rowid, the servers' seq (see src/store/dialect.ts).
    const rows = await this.store.sql.all(
      `SELECT guild_id, channel_id FROM voice_channels ORDER BY ${this.store.dialect.insertionOrder}`,
    );
    return rows.map((row) => ({ guildId: text(row, 'guild_id'), channelId: text(row, 'channel_id') }));
  }
}

/** What is known about a track's lyrics: timed lines, words without timings, an instrumental, or that none were found. */
export type LyricsKind = 'synced' | 'plain' | 'instrumental' | 'none';

/** A track's lyrics as they are kept. */
export interface LyricsRow {
  readonly trackId: number;
  readonly kind: LyricsKind;
  /** The timed lines as LRC ("[01:02.30] words"), for kind synced. */
  readonly synced: string | null;
  /** The words without timings (synced lyrics have them too). */
  readonly plain: string | null;
  /** The record's number at the source (LRCLIB), or null when none was found. */
  readonly sourceId: number | null;
  /** When they were looked up: a "none" is looked up again after a while, as the source may have them by then. */
  readonly fetchedAt: number;
}

// The most characters kept of one track's lyrics, timed or plain: songs have a few thousand, and a record far longer
// is not a song's words. Past it the words are cut at the end of a line.
const LYRICS_MAX = 64_000;

// Text cut to the limit at the last line break before it, so no line is kept half.
function capped(value: string | null): string | null {
  if (value === null || value.length <= LYRICS_MAX) return value;
  const cut = value.lastIndexOf('\n', LYRICS_MAX);
  return value.slice(0, cut > 0 ? cut : LYRICS_MAX);
}

/** Lyrics by track, one row each: what was found for it, or that nothing was. */
export class LyricsRepository {
  private readonly store: Store;
  private readonly now: () => number;

  constructor(store: Store, now: () => number) {
    this.store = store;
    this.now = now;
  }

  /** What is kept for a track, or null when it was never looked up. */
  async get(trackId: number): Promise<LyricsRow | null> {
    const row = await this.store.sql.get('SELECT * FROM lyrics WHERE track_id = ?', [trackId]);
    return row ? lyricsFrom(row) : null;
  }

  /** Keeps what a lookup found (or that it found nothing), replacing what was kept, and returns it as kept. */
  async save(lyrics: Omit<LyricsRow, 'fetchedAt'>): Promise<LyricsRow> {
    // The write and the read back in one go (MySQL has no RETURNING; one statement more on the others too).
    return this.store.transaction(async () => {
      await this.store.sql.run(
        this.store.dialect.upsert({
          table: 'lyrics',
          columns: ['track_id', 'kind', 'synced', 'plain', 'source_id', 'fetched_at'],
          key: ['track_id'],
          update: ['kind', 'synced', 'plain', 'source_id', 'fetched_at'],
        }),
        [lyrics.trackId, lyrics.kind, capped(lyrics.synced), capped(lyrics.plain), lyrics.sourceId, this.now()],
      );
      const saved = await this.get(lyrics.trackId);
      if (!saved) throw new StoreError('the lyrics just written cannot be read back');
      return saved;
    });
  }
}

function lyricsFrom(row: Row): LyricsRow {
  const kind = text(row, 'kind');
  return {
    trackId: int(row, 'track_id'),
    // An unknown kind (a newer version's, or a hand edit) is read as none found, which is looked up again in time.
    kind: kind === 'synced' || kind === 'plain' || kind === 'instrumental' ? kind : 'none',
    synced: textOrNull(row, 'synced'),
    plain: textOrNull(row, 'plain'),
    sourceId: intOrNull(row, 'source_id'),
    fetchedAt: int(row, 'fetched_at'),
  };
}

/** What a site says a recording is: the song, its artist and its album (YouTube says it for many music videos). */
export interface TrackMusic {
  readonly artist: string;
  readonly title: string;
  readonly album: string | null;
}

// The longest name kept for an artist, a song or an album: longer is not a name.
const MUSIC_NAME_MAX = 300;

/** The song, artist and album of tracks whose site said them, by track. */
export class MusicRepository {
  private readonly store: Store;
  private readonly now: () => number;

  constructor(store: Store, now: () => number) {
    this.store = store;
    this.now = now;
  }

  /** What the site said a track is, or null when it said nothing. */
  async get(trackId: number): Promise<TrackMusic | null> {
    const row = await this.store.sql.get('SELECT artist, title, album FROM track_music WHERE track_id = ?', [trackId]);
    return row ? { artist: text(row, 'artist'), title: text(row, 'title'), album: textOrNull(row, 'album') } : null;
  }

  /** Keeps what a site said a track is; a later lookup that says it again replaces it. */
  async set(trackId: number, music: TrackMusic): Promise<void> {
    const cut = (value: string) => value.trim().slice(0, MUSIC_NAME_MAX);
    await this.store.sql.run(
      this.store.dialect.upsert({
        table: 'track_music',
        columns: ['track_id', 'artist', 'title', 'album', 'updated_at'],
        key: ['track_id'],
        update: ['artist', 'title', 'album', 'updated_at'],
      }),
      [trackId, cut(music.artist), cut(music.title), music.album === null ? null : cut(music.album), this.now()],
    );
  }
}

/** A listening link as it is listed (never with its code, which is kept only as a hash). */
export interface ListenLinkRow {
  readonly id: number;
  readonly guildId: string;
  /** The Discord user who made it, or null for the host. */
  readonly createdBy: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** How many browsers it lets in at most. */
  readonly maxGuests: number;
  /** How many browsers came in with it and are in still. */
  readonly guests: number;
}

// A link's columns with how many of its guests are in still (their sessions not expired), for `now` (bound first).
const LINK_SELECT = `SELECT l.*, (SELECT COUNT(*) FROM guest_sessions g WHERE g.link_id = l.id AND g.expires_at > ?)
  AS guests FROM listen_links l`;

/** Listening links by server. An expired link counts as gone (it is deleted the next time links are pruned). */
export class ListenLinkRepository {
  private readonly store: Store;
  private readonly now: () => number;

  constructor(store: Store, now: () => number) {
    this.store = store;
    this.now = now;
  }

  /** Keeps a new link, working from now for `lastsMs`. */
  async create(link: {
    hash: string;
    guildId: string;
    createdBy: string | null;
    lastsMs: number;
    maxGuests: number;
  }): Promise<ListenLinkRow> {
    // The write and the read back in one go.
    return this.store.transaction(async () => {
      const now = this.now();
      const id = await this.store.insertId(
        `INSERT INTO listen_links (hash, guild_id, created_by, created_at, expires_at, max_guests)
           VALUES (?, ?, ?, ?, ?, ?)`,
        [link.hash, link.guildId, link.createdBy, now, now + link.lastsMs, link.maxGuests],
      );
      const made = await this.get(id);
      if (!made) throw new StoreError('the listening link just written cannot be read back');
      return made;
    });
  }

  /** The link with this ID while it has not expired, or null. */
  async get(id: number): Promise<ListenLinkRow | null> {
    const now = this.now();
    const row = await this.store.sql.get(`${LINK_SELECT} WHERE l.id = ? AND l.expires_at > ?`, [now, id, now]);
    return row ? linkFrom(row) : null;
  }

  /** The link whose code has this hash while it has not expired, or null. */
  async byHash(hash: string): Promise<ListenLinkRow | null> {
    const now = this.now();
    const row = await this.store.sql.get(`${LINK_SELECT} WHERE l.hash = ? AND l.expires_at > ?`, [now, hash, now]);
    return row ? linkFrom(row) : null;
  }

  /** A server's links that have not expired, newest first: everyone's, or one person's (`createdBy`). */
  async list(guildId: string, createdBy?: string): Promise<ListenLinkRow[]> {
    const now = this.now();
    const rows =
      createdBy === undefined
        ? await this.store.sql.all(`${LINK_SELECT} WHERE l.guild_id = ? AND l.expires_at > ? ORDER BY l.id DESC`, [
            now,
            guildId,
            now,
          ])
        : await this.store.sql.all(
            `${LINK_SELECT} WHERE l.guild_id = ? AND l.expires_at > ? AND l.created_by = ? ORDER BY l.id DESC`,
            [now, guildId, now, createdBy],
          );
    return rows.map((row) => linkFrom(row));
  }

  /** How many links of a server have not expired. */
  async count(guildId: string): Promise<number> {
    const row = await one(
      this.store.sql.get('SELECT COUNT(*) AS n FROM listen_links WHERE guild_id = ? AND expires_at > ?', [
        guildId,
        this.now(),
      ]),
    );
    return int(row, 'n');
  }

  /** Deletes a link and, with it, the sessions of its guests; false when there was none. */
  async remove(id: number): Promise<boolean> {
    return (await this.store.sql.run('DELETE FROM listen_links WHERE id = ?', [id])).changes > 0;
  }

  /** Deletes the links that have expired (their guests' sessions go with them) and returns how many went. */
  async prune(): Promise<number> {
    return (await this.store.sql.run('DELETE FROM listen_links WHERE expires_at <= ?', [this.now()])).changes;
  }
}

function linkFrom(row: Row): ListenLinkRow {
  return {
    id: int(row, 'id'),
    guildId: text(row, 'guild_id'),
    createdBy: textOrNull(row, 'created_by'),
    createdAt: int(row, 'created_at'),
    expiresAt: int(row, 'expires_at'),
    maxGuests: int(row, 'max_guests'),
    guests: int(row, 'guests'),
  };
}

/** A browser that came in with a listening link. */
export interface GuestSessionRow {
  /** SHA-256 of the cookie's secret, in hex. */
  readonly idHash: string;
  readonly linkId: number;
  /** The one server its link opens. */
  readonly guildId: string;
  /** The token its changes would need (a guest's only change is leaving). */
  readonly csrf: string;
  readonly createdAt: number;
  readonly seenAt: number;
  /** When its link expires: a guest's session never outlives the link. */
  readonly expiresAt: number;
}

/** The sessions of guests, looked up by the hash of the cookie's secret. */
export class GuestSessionRepository {
  private readonly store: Store;
  private readonly now: () => number;

  constructor(store: Store, now: () => number) {
    this.store = store;
    this.now = now;
  }

  async create(session: { idHash: string; linkId: number; csrf: string; expiresAt: number }): Promise<void> {
    const now = this.now();
    await this.store.sql.run(
      `INSERT INTO guest_sessions (id_hash, link_id, csrf, created_at, seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      [session.idHash, session.linkId, session.csrf, now, now, session.expiresAt],
    );
  }

  /**
   * The guest with this hash, with the server of its link, or null when there is none: never was, logged out, its
   * link revoked (deleted with it) or expired (an expired one is removed).
   */
  async get(idHash: string): Promise<GuestSessionRow | null> {
    const row = await this.store.sql.get(
      `SELECT g.*, l.guild_id FROM guest_sessions g JOIN listen_links l ON l.id = g.link_id WHERE g.id_hash = ?`,
      [idHash],
    );
    if (!row) return null;
    const session: GuestSessionRow = {
      idHash: text(row, 'id_hash'),
      linkId: int(row, 'link_id'),
      guildId: text(row, 'guild_id'),
      csrf: text(row, 'csrf'),
      createdAt: int(row, 'created_at'),
      seenAt: int(row, 'seen_at'),
      expiresAt: int(row, 'expires_at'),
    };
    if (session.expiresAt <= this.now()) {
      await this.remove(idHash);
      return null;
    }
    return session;
  }

  /** Notes that the guest was seen now (at most once a minute, by its caller). */
  async touch(idHash: string): Promise<void> {
    await this.store.sql.run('UPDATE guest_sessions SET seen_at = ? WHERE id_hash = ?', [this.now(), idHash]);
  }

  /** Ends a guest's session (the guest left); false when there was none. */
  async remove(idHash: string): Promise<boolean> {
    return (await this.store.sql.run('DELETE FROM guest_sessions WHERE id_hash = ?', [idHash])).changes > 0;
  }

  /** How many guests of a link are in (their sessions not expired). */
  async count(linkId: number): Promise<number> {
    const row = await one(
      this.store.sql.get('SELECT COUNT(*) AS n FROM guest_sessions WHERE link_id = ? AND expires_at > ?', [
        linkId,
        this.now(),
      ]),
    );
    return int(row, 'n');
  }

  /** Deletes the expired sessions of guests and returns how many went. */
  async prune(): Promise<number> {
    return (await this.store.sql.run('DELETE FROM guest_sessions WHERE expires_at <= ?', [this.now()])).changes;
  }
}

/** The most tracks one login keeps liked: a long list for a person, and a bound on the table. */
export const LIKES_MAX = 1000;

/** The tracks each login liked; "owner" is a Discord user ID, or "host" for the host's login. */
export class LikeRepository {
  private readonly store: Store;
  private readonly now: () => number;

  constructor(store: Store, now: () => number) {
    this.store = store;
    this.now = now;
  }

  /** Likes a track; false when it was liked already (liking twice changes nothing, not even when). */
  async add(owner: string, trackId: number): Promise<boolean> {
    const dialect = this.store.dialect;
    try {
      const result = await this.store.sql.run(dialect.insertOrIgnore('likes', ['owner', 'track_id', 'created_at']), [
        owner,
        trackId,
        this.now(),
      ]);
      return result.changes > 0;
    } catch (error) {
      // MySQL's INSERT refused for the like that is there already: liked before, nothing changes (see the dialect).
      if (!dialect.ignoresDuplicates && isUniqueViolation(error)) return false;
      throw error;
    }
  }

  /** Takes a like back; false when there was none. */
  async remove(owner: string, trackId: number): Promise<boolean> {
    const result = await this.store.sql.run('DELETE FROM likes WHERE owner = ? AND track_id = ?', [owner, trackId]);
    return result.changes > 0;
  }

  /** Whether a login liked a track. */
  async has(owner: string, trackId: number): Promise<boolean> {
    const row = await this.store.sql.get('SELECT 1 AS found FROM likes WHERE owner = ? AND track_id = ?', [
      owner,
      trackId,
    ]);
    return row !== undefined;
  }

  /** How many tracks a login liked. */
  async count(owner: string): Promise<number> {
    const row = await one(this.store.sql.get('SELECT COUNT(*) AS n FROM likes WHERE owner = ?', [owner]));
    return int(row, 'n');
  }

  /** A login's liked tracks, newest first (by the index on owner and time). */
  async list(owner: string, limit = LIKES_MAX): Promise<LikedTrack[]> {
    const rows = await this.store.sql.all(
      `SELECT l.created_at, ${TRACK_COLUMNS} FROM likes l JOIN tracks t ON t.id = l.track_id
         WHERE l.owner = ? ORDER BY l.created_at DESC, l.track_id DESC LIMIT ?`,
      [owner, limit],
    );
    return rows.map((row) => ({ track: trackFrom(row), likedAt: int(row, 'created_at') }));
  }
}
