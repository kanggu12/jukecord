/**
 * The database: one SQLite file in the data directory, opened with Node's built-in driver.
 *
 * node:sqlite needs no native add-on, so the same code runs on amd64 and arm64 without a compiler in the image.
 * Every table is reached through the repositories below; nothing else in jukecord writes SQL. The driver is still
 * marked experimental in Node 24, which is why it stays behind this one file: if its interface changes, only this
 * file changes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import type { HistoryEntry, NewTrack, Playlist, QueueItem, Track } from '../core/types.ts';
import { MIGRATIONS } from './schema.ts';

/** A row as the driver returns it. */
type Row = Record<string, SQLOutputValue>;

/** Raised for requests the data does not allow: an unknown queue item, a playlist name already taken. */
export class StoreError extends Error {
  override name = 'StoreError';
}

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

/** The open database and its repositories. One per process. */
export class Store {
  readonly db: DatabaseSync;
  /** The file path, or ":memory:" for the throwaway databases tests use. */
  readonly file: string;
  readonly tracks: TrackRepository;
  readonly queue: QueueRepository;
  readonly history: HistoryRepository;
  readonly playlists: PlaylistRepository;
  readonly playerState: PlayerStateRepository;
  readonly settings: SettingsRepository;
  readonly discord: DiscordRepository;
  // How deep the current transaction is nested; inner ones become savepoints.
  private depth = 0;

  private constructor(db: DatabaseSync, file: string, now: () => number) {
    this.db = db;
    this.file = file;
    this.tracks = new TrackRepository(this, now);
    this.queue = new QueueRepository(this, now);
    this.history = new HistoryRepository(this);
    this.playlists = new PlaylistRepository(this, now);
    this.playerState = new PlayerStateRepository(this, now);
    this.settings = new SettingsRepository(this, now);
    this.discord = new DiscordRepository(this, now);
  }

  /**
   * Opens (creating if needed) the database and brings its schema up to date.
   *
   * Refuses a database written by a newer jukecord: running old code on a newer schema could lose what the newer
   * version stored, and going back to an older version is a thing people do after a bad upgrade.
   */
  static open(file: string, options: StoreOptions = {}): Store {
    // The data directory may be new; SQLite does not create parent folders.
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    // Foreign keys on (the driver's default, written out so it is not lost on a change of default); wait up to 5 s
    // for a lock instead of failing at once, which covers a backup running while the bot writes.
    const db = new DatabaseSync(file, { enableForeignKeyConstraints: true, timeout: 5000 });
    // WAL lets the panel read while the player writes; NORMAL sync is safe with WAL and much faster than FULL.
    if (file !== ':memory:') {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
    }
    const store = new Store(db, file, options.now ?? Date.now);
    try {
      store.migrate();
    } catch (error) {
      // A failed migration leaves the database untouched (it runs in a transaction); close it so the file is not held.
      db.close();
      throw error;
    }
    return store;
  }

  /** The schema version the database is at (SQLite's user_version). */
  schemaVersion(): number {
    const row = this.db.prepare('PRAGMA user_version').get() as Row;
    return int(row, 'user_version');
  }

  // Applies every migration newer than the database, each in its own transaction with its version.
  private migrate(): void {
    const current = this.schemaVersion();
    const latest = MIGRATIONS.at(-1)?.version ?? 0;
    if (current > latest) {
      throw new StoreError(
        `the database is at schema ${current}, newer than this jukecord knows (${latest}); use the newer jukecord or restore a backup`,
      );
    }
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      this.transaction(() => {
        this.db.exec(migration.sql);
        // PRAGMA takes no bound parameters; the version is a number from the code, not from input.
        this.db.exec(`PRAGMA user_version = ${migration.version}`);
      });
    }
  }

  /**
   * Runs `fn` in a transaction: everything it writes is kept, or nothing is if it throws.
   *
   * Nested calls become savepoints, so a repository method that uses a transaction can be called from inside another.
   */
  transaction<T>(fn: () => T): T {
    const name = `sp${this.depth}`;
    // The outermost level takes the write lock at once (IMMEDIATE), so two writers queue up instead of deadlocking.
    this.db.exec(this.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
    this.depth += 1;
    try {
      const result = fn();
      this.depth -= 1;
      this.db.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${name}`);
      return result;
    } catch (error) {
      this.depth -= 1;
      // Roll back only this level; an outer level decides for itself what to do with the error.
      this.db.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
      throw error;
    }
  }

  /** Writes a consistent copy of the database to `target` (an online backup; the bot keeps running). */
  backup(target: string): void {
    // VACUUM INTO refuses to overwrite, so a backup never replaces an older one by accident.
    if (fs.existsSync(target)) throw new StoreError(`${target} already exists`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    this.db.prepare('VACUUM INTO ?').run(target);
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}

/** Tracks: one row per distinct source, updated when a later lookup knows more about it. */
export class TrackRepository {
  private readonly store: Store;
  private readonly now: () => number;

  constructor(store: Store, now: () => number) {
    this.store = store;
    this.now = now;
  }

  /**
   * Stores a track looked up from a site, or refreshes the row for the same source, and returns it.
   *
   * Fields the new lookup does not know (null) keep their old value: a flat playlist listing has no thumbnails, and
   * adding a playlist must not erase the thumbnails of tracks already known.
   */
  upsert(track: NewTrack): Track {
    const now = this.now();
    const row = this.store.db
      .prepare(
        `INSERT INTO tracks (source, url, title, uploader, duration_ms, thumbnail, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source) DO UPDATE SET
           url = excluded.url,
           title = excluded.title,
           uploader = COALESCE(excluded.uploader, tracks.uploader),
           duration_ms = COALESCE(excluded.duration_ms, tracks.duration_ms),
           thumbnail = COALESCE(excluded.thumbnail, tracks.thumbnail),
           updated_at = excluded.updated_at
         RETURNING id`,
      )
      .get(track.source, track.url, track.title, track.uploader, track.durationMs, track.thumbnail, now, now) as Row;
    // RETURNING gives the ID whether the row was inserted or updated; read it back whole through the one reader.
    const stored = this.get(int(row, 'id'));
    if (!stored) throw new StoreError('the track just written cannot be read back');
    return stored;
  }

  /** The track with this ID, or null. */
  get(id: number): Track | null {
    const row = this.store.db.prepare(`SELECT ${TRACK_COLUMNS} FROM tracks t WHERE t.id = ?`).get(id) as
      | Row
      | undefined;
    return row ? trackFrom(row) : null;
  }

  /** The track for a normalised source address, or null when it was never added. */
  bySource(source: string): Track | null {
    const row = this.store.db.prepare(`SELECT ${TRACK_COLUMNS} FROM tracks t WHERE t.source = ?`).get(source) as
      | Row
      | undefined;
    return row ? trackFrom(row) : null;
  }

  /** Records the measured loudness, so the next play of this track skips the measurement. */
  setLoudness(id: number, lufs: number): void {
    this.store.db.prepare('UPDATE tracks SET loudness = ?, updated_at = ? WHERE id = ?').run(lufs, this.now(), id);
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
  list(guildId: string): QueueItem[] {
    // id breaks ties in the unlikely case of equal positions, so the order is always the same.
    const rows = this.store.db.prepare(`${QUEUE_SELECT} WHERE q.guild_id = ? ORDER BY q.position, q.id`).all(guildId);
    return rows.map((row) => queueItemFrom(row as Row));
  }

  /** How many tracks wait in a server's queue. */
  count(guildId: string): number {
    const row = this.store.db.prepare('SELECT COUNT(*) AS n FROM queue_items WHERE guild_id = ?').get(guildId) as Row;
    return int(row, 'n');
  }

  /** One queue item by its ID, or null. */
  get(itemId: number): QueueItem | null {
    const row = this.store.db.prepare(`${QUEUE_SELECT} WHERE q.id = ?`).get(itemId) as Row | undefined;
    return row ? queueItemFrom(row) : null;
  }

  /**
   * Inserts tracks at `index` (0 = play next, the queue length = the end) and returns the new items in order.
   *
   * Tracks already queued are queued again: a person who adds a song twice wants it twice. Duplicates are removed
   * only when someone asks (the dedupe action).
   */
  insert(guildId: string, trackIds: readonly number[], index: number, addedBy: string | null): QueueItem[] {
    return this.store.transaction(() => {
      const length = this.count(guildId);
      // An index past the end means the end; a negative one is a caller's mistake.
      if (index < 0) throw new StoreError(`position ${index} is before the start of the queue`);
      const at = Math.min(index, length);
      // Make room: everything from `at` onwards moves down by the number of new tracks.
      this.store.db
        .prepare('UPDATE queue_items SET position = position + ? WHERE guild_id = ? AND position >= ?')
        .run(trackIds.length, guildId, at);
      const insert = this.store.db.prepare(
        'INSERT INTO queue_items (guild_id, position, track_id, added_by, added_at) VALUES (?, ?, ?, ?, ?) RETURNING id',
      );
      const now = this.now();
      const ids = trackIds.map((trackId, offset) =>
        int(insert.get(guildId, at + offset, trackId, addedBy, now) as Row, 'id'),
      );
      // Read the rows back so callers get complete items, tracks included.
      return ids.map((id) => {
        const item = this.get(id);
        if (!item) throw new StoreError('a queue item just written cannot be read back');
        return item;
      });
    });
  }

  /** Removes one item; false when it is not in that server's queue (already played or removed by someone else). */
  remove(guildId: string, itemId: number): boolean {
    return this.store.transaction(() => {
      const result = this.store.db
        .prepare('DELETE FROM queue_items WHERE id = ? AND guild_id = ?')
        .run(itemId, guildId);
      if (Number(result.changes) === 0) return false;
      this.compact(guildId);
      return true;
    });
  }

  /** Moves one item to `index` (counted in the queue as it is before the move). */
  move(guildId: string, itemId: number, index: number): void {
    this.store.transaction(() => {
      const ids = this.ids(guildId);
      const from = ids.indexOf(itemId);
      if (from === -1) throw new StoreError(`item ${itemId} is not in the queue`);
      if (index < 0 || index >= ids.length)
        throw new StoreError(`position ${index} is outside the queue (0-${ids.length - 1})`);
      // Take it out and put it back at the target place.
      ids.splice(from, 1);
      ids.splice(index, 0, itemId);
      this.writeOrder(guildId, ids);
    });
  }

  /** Puts the queue in exactly this order; `itemIds` must hold every item once (used by shuffle and drag-and-drop). */
  reorder(guildId: string, itemIds: readonly number[]): void {
    this.store.transaction(() => {
      const current = new Set(this.ids(guildId));
      const wanted = new Set(itemIds);
      // The same items exactly once each: a missing, extra or repeated ID means the caller's view is out of date.
      const same =
        wanted.size === itemIds.length && wanted.size === current.size && [...wanted].every((id) => current.has(id));
      if (!same) throw new StoreError('the new order does not hold exactly the items in the queue');
      this.writeOrder(guildId, itemIds);
    });
  }

  /** Removes every item of a server's queue and returns how many there were. */
  clear(guildId: string): number {
    const result = this.store.db.prepare('DELETE FROM queue_items WHERE guild_id = ?').run(guildId);
    return Number(result.changes);
  }

  /** Takes the first item out of the queue (the next to play), or null when the queue is empty. */
  shift(guildId: string): QueueItem | null {
    return this.store.transaction(() => {
      const first = this.list(guildId)[0];
      if (!first) return null;
      this.store.db.prepare('DELETE FROM queue_items WHERE id = ?').run(first.id);
      this.compact(guildId);
      return first;
    });
  }

  // The item IDs in queue order.
  private ids(guildId: string): number[] {
    return this.store.db
      .prepare('SELECT id FROM queue_items WHERE guild_id = ? ORDER BY position, id')
      .all(guildId)
      .map((row) => int(row as Row, 'id'));
  }

  // Rewrites positions to 0..n-1 in the current order, after a removal left a gap.
  private compact(guildId: string): void {
    this.writeOrder(guildId, this.ids(guildId));
  }

  // Writes position = index for each ID; rows already in place are left alone.
  private writeOrder(guildId: string, ids: readonly number[]): void {
    const update = this.store.db.prepare(
      'UPDATE queue_items SET position = ? WHERE id = ? AND guild_id = ? AND position != ?',
    );
    ids.forEach((id, index) => {
      update.run(index, id, guildId, index);
    });
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
  add(entry: {
    guildId: string;
    trackId: number;
    addedBy: string | null;
    playedAt: number;
    playedMs: number;
  }): HistoryEntry {
    const row = this.store.db
      .prepare(
        'INSERT INTO history (guild_id, track_id, added_by, played_at, played_ms) VALUES (?, ?, ?, ?, ?) RETURNING id',
      )
      .get(entry.guildId, entry.trackId, entry.addedBy, entry.playedAt, entry.playedMs) as Row;
    const id = int(row, 'id');
    // Pruned every hundred plays, not every play: the delete walks a server's history.
    if (id % 100 === 0) this.prune(entry.guildId);
    const stored = this.get(id);
    if (!stored) throw new StoreError('the history entry just written cannot be read back');
    return stored;
  }

  /** Deletes a server's oldest entries beyond `keep` and returns how many went. */
  prune(guildId: string, keep = HISTORY_KEEP): number {
    const result = this.store.db
      .prepare(
        `DELETE FROM history WHERE guild_id = ? AND id < (
           SELECT id FROM history WHERE guild_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
      )
      .run(guildId, guildId, keep - 1);
    return Number(result.changes);
  }

  /** One entry by ID, or null. */
  get(id: number): HistoryEntry | null {
    const row = this.store.db
      .prepare(
        `SELECT h.id, h.guild_id, h.added_by, h.played_at, h.played_ms, ${TRACK_COLUMNS}
         FROM history h JOIN tracks t ON t.id = h.track_id WHERE h.id = ?`,
      )
      .get(id) as Row | undefined;
    return row ? historyFrom(row) : null;
  }

  /** The newest `limit` entries of a server; `beforeId` pages further back. */
  list(guildId: string, limit = 50, beforeId?: number): HistoryEntry[] {
    const rows = this.store.db
      .prepare(
        `SELECT h.id, h.guild_id, h.added_by, h.played_at, h.played_ms, ${TRACK_COLUMNS}
         FROM history h JOIN tracks t ON t.id = h.track_id
         WHERE h.guild_id = ? AND h.id < ?
         ORDER BY h.played_at DESC, h.id DESC LIMIT ?`,
      )
      // Without a cursor every ID qualifies; MAX_SAFE_INTEGER stands in for "no upper bound".
      .all(guildId, beforeId ?? Number.MAX_SAFE_INTEGER, limit);
    return rows.map((row) => historyFrom(row as Row));
  }
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

  constructor(store: Store, now: () => number) {
    this.store = store;
    this.now = now;
  }

  /** Saves tracks under a name, replacing the list if the name exists (saving twice keeps the latest). */
  save(guildId: string, name: string, trackIds: readonly number[], createdBy: string | null): Playlist {
    const clean = name.trim();
    // An empty name cannot be shown or typed back; a very long one breaks every list it appears in.
    if (clean.length === 0 || clean.length > 100) throw new StoreError('a playlist name is 1 to 100 characters');
    return this.store.transaction(() => {
      const now = this.now();
      const row = this.store.db
        .prepare(
          `INSERT INTO playlists (guild_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (guild_id, name) DO UPDATE SET updated_at = excluded.updated_at
           RETURNING id`,
        )
        .get(guildId, clean, createdBy, now, now) as Row;
      const id = int(row, 'id');
      // Replace the items wholesale: the saved list is exactly what was passed.
      this.store.db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(id);
      const insert = this.store.db.prepare(
        'INSERT INTO playlist_items (playlist_id, position, track_id) VALUES (?, ?, ?)',
      );
      trackIds.forEach((trackId, position) => {
        insert.run(id, position, trackId);
      });
      const saved = this.get(id);
      if (!saved) throw new StoreError('the playlist just written cannot be read back');
      return saved;
    });
  }

  /** One playlist by ID, or null. */
  get(id: number): Playlist | null {
    const row = this.store.db
      .prepare(
        `SELECT p.*, (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id = p.id) AS size
         FROM playlists p WHERE p.id = ?`,
      )
      .get(id) as Row | undefined;
    return row ? playlistFrom(row) : null;
  }

  /** A server's playlist by name (names are matched exactly, after trimming), or null. */
  find(guildId: string, name: string): Playlist | null {
    const row = this.store.db
      .prepare('SELECT id FROM playlists WHERE guild_id = ? AND name = ?')
      .get(guildId, name.trim()) as Row | undefined;
    return row ? this.get(int(row, 'id')) : null;
  }

  /** A server's playlists, most recently saved first. */
  list(guildId: string): Playlist[] {
    const rows = this.store.db
      .prepare(
        `SELECT p.*, (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id = p.id) AS size
         FROM playlists p WHERE p.guild_id = ? ORDER BY p.updated_at DESC, p.id DESC`,
      )
      .all(guildId);
    return rows.map((row) => playlistFrom(row as Row));
  }

  /** The tracks of a playlist in their saved order. */
  tracks(playlistId: number): Track[] {
    const rows = this.store.db
      .prepare(
        `SELECT ${TRACK_COLUMNS} FROM playlist_items i JOIN tracks t ON t.id = i.track_id
         WHERE i.playlist_id = ? ORDER BY i.position`,
      )
      .all(playlistId);
    return rows.map((row) => trackFrom(row as Row));
  }

  /** Renames a playlist; fails when the server already has one by the new name. */
  rename(playlistId: number, name: string): Playlist {
    const clean = name.trim();
    if (clean.length === 0 || clean.length > 100) throw new StoreError('a playlist name is 1 to 100 characters');
    try {
      this.store.db
        .prepare('UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?')
        .run(clean, this.now(), playlistId);
    } catch (error) {
      // The UNIQUE (guild_id, name) constraint is the check; turn its error into one people can read.
      if (error instanceof Error && /UNIQUE/.test(error.message))
        throw new StoreError(`a playlist named "${clean}" exists`);
      throw error;
    }
    const renamed = this.get(playlistId);
    if (!renamed) throw new StoreError(`playlist ${playlistId} does not exist`);
    return renamed;
  }

  /** Deletes a playlist and its items; false when there was none. */
  remove(playlistId: number): boolean {
    const result = this.store.db.prepare('DELETE FROM playlists WHERE id = ?').run(playlistId);
    return Number(result.changes) > 0;
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
}

/** The current track of each server, written on every change so a restart can come back to it. */
export class PlayerStateRepository {
  private readonly store: Store;
  private readonly now: () => number;

  constructor(store: Store, now: () => number) {
    this.store = store;
    this.now = now;
  }

  save(state: Omit<SavedPlayerState, 'updatedAt'>): void {
    this.store.db
      .prepare(
        `INSERT INTO player_state (guild_id, track_id, added_by, status, position_ms, repeat, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (guild_id) DO UPDATE SET track_id = excluded.track_id, added_by = excluded.added_by,
           status = excluded.status, position_ms = excluded.position_ms, repeat = excluded.repeat,
           updated_at = excluded.updated_at`,
      )
      .run(
        state.guildId,
        state.trackId,
        state.addedBy,
        state.status,
        Math.max(0, Math.round(state.positionMs)),
        state.repeat,
        this.now(),
      );
  }

  load(guildId: string): SavedPlayerState | null {
    const row = this.store.db.prepare('SELECT * FROM player_state WHERE guild_id = ?').get(guildId) as Row | undefined;
    return row ? savedStateFrom(row) : null;
  }

  /** Every saved server, for restoring them all at start. */
  all(): SavedPlayerState[] {
    return this.store.db
      .prepare('SELECT * FROM player_state ORDER BY guild_id')
      .all()
      .map((row) => savedStateFrom(row as Row));
  }
}

function savedStateFrom(row: Row): SavedPlayerState {
  const status = text(row, 'status');
  // An unknown status (a newer version's, or a hand edit) is read as idle rather than trusted.
  const known = status === 'playing' || status === 'paused' ? status : 'idle';
  const repeat = text(row, 'repeat');
  return {
    guildId: text(row, 'guild_id'),
    trackId: intOrNull(row, 'track_id'),
    addedBy: textOrNull(row, 'added_by'),
    status: known,
    positionMs: int(row, 'position_ms'),
    // Read like the status: an unknown value falls back to the safe default.
    repeat: repeat === 'track' || repeat === 'queue' ? repeat : 'off',
    updatedAt: int(row, 'updated_at'),
  };
}

/** Per-server choices. */
export interface GuildSettings {
  /** The role allowed to change the queue; null means every member of the server may. */
  readonly djRoleId: string | null;
}

export class SettingsRepository {
  private readonly store: Store;
  private readonly now: () => number;

  constructor(store: Store, now: () => number) {
    this.store = store;
    this.now = now;
  }

  /** A server's settings; a server never configured gets the defaults. */
  get(guildId: string): GuildSettings {
    const row = this.store.db.prepare('SELECT dj_role_id FROM guild_settings WHERE guild_id = ?').get(guildId) as
      | Row
      | undefined;
    return { djRoleId: row ? textOrNull(row, 'dj_role_id') : null };
  }

  /** Sets or clears (null) the role that may change the queue. */
  setDjRole(guildId: string, roleId: string | null): void {
    this.store.db
      .prepare(
        `INSERT INTO guild_settings (guild_id, dj_role_id, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (guild_id) DO UPDATE SET dj_role_id = excluded.dj_role_id, updated_at = excluded.updated_at`,
      )
      .run(guildId, roleId, this.now());
  }
}

/** What jukecord remembers about Discord per server: the fingerprint of the commands it registered there. */
export class DiscordRepository {
  private readonly store: Store;
  private readonly now: () => number;

  constructor(store: Store, now: () => number) {
    this.store = store;
    this.now = now;
  }

  /** The fingerprint of the commands registered in a server, or null when none were. */
  commandsHash(guildId: string): string | null {
    const row = this.store.db.prepare('SELECT hash FROM discord_commands WHERE guild_id = ?').get(guildId) as
      | Row
      | undefined;
    return row ? text(row, 'hash') : null;
  }

  setCommandsHash(guildId: string, hash: string): void {
    this.store.db
      .prepare(
        `INSERT INTO discord_commands (guild_id, hash, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (guild_id) DO UPDATE SET hash = excluded.hash, updated_at = excluded.updated_at`,
      )
      .run(guildId, hash, this.now());
  }
}
