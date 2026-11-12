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
import { Worker } from 'node:worker_threads';
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
  readonly users: UserRepository;
  readonly sessions: SessionRepository;
  readonly tokens: TokenRepository;
  readonly voiceChannels: VoiceChannelRepository;
  readonly lyrics: LyricsRepository;
  readonly music: MusicRepository;
  readonly listenLinks: ListenLinkRepository;
  readonly guests: GuestSessionRepository;
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
    this.users = new UserRepository(this, now);
    this.sessions = new SessionRepository(this, now);
    this.tokens = new TokenRepository(this, now);
    this.voiceChannels = new VoiceChannelRepository(this, now);
    this.lyrics = new LyricsRepository(this, now);
    this.music = new MusicRepository(this, now);
    this.listenLinks = new ListenLinkRepository(this, now);
    this.guests = new GuestSessionRepository(this, now);
  }

  /**
   * Opens (creating if needed) the database and brings its schema up to date.
   *
   * Refuses a database written by a newer jukecord: running old code on a newer schema could lose what the newer
   * version stored, and going back to an older version is a thing people do after a bad upgrade.
   */
  static open(file: string, options: StoreOptions = {}): Store {
    // The data directory may be new; SQLite does not create parent folders.
    if (file !== ':memory:') {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // A database copied in from elsewhere (a restore, a move between machines) keeps the mode it was copied with;
      // it is made this user's alone again, with its log files, which SQLite creates with the database's mode.
      for (const part of [file, `${file}-wal`, `${file}-shm`]) {
        try {
          fs.chmodSync(part, 0o600);
        } catch {
          // Not there yet (a new database), or not this user's to change: nothing to tighten.
        }
      }
    }
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
    const outer = this.depth === 0;
    const name = `sp${this.depth}`;
    // The outermost level takes the write lock at once (IMMEDIATE), so two writers queue up instead of deadlocking.
    this.db.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
    this.depth += 1;
    let result: T;
    try {
      result = fn();
    } catch (error) {
      // Roll back only this level; an outer level decides for itself what to do with the error. SQLite may have
      // rolled back by itself already (a full disk, an I/O error); then there is nothing to undo, and the error that
      // happened is the one reported, not the rollback's. The level is left either way.
      try {
        if (!outer) this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
        else if (this.db.isTransaction) this.db.exec('ROLLBACK');
      } catch {
        // Nothing left to roll back.
      } finally {
        this.depth -= 1;
      }
      throw error;
    }
    try {
      this.db.exec(outer ? 'COMMIT' : `RELEASE ${name}`);
    } catch (error) {
      // The commit itself failed (a full disk shows up here in WAL mode): undo what is left of the transaction, so the
      // next one starts clean, and report the commit's own error.
      if (outer && this.db.isTransaction) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // Already rolled back by SQLite; nothing more to undo.
        }
      }
      this.depth -= 1;
      throw error;
    }
    this.depth -= 1;
    return result;
  }

  /** Writes a consistent copy of the database to `target` (an online backup; the bot keeps running). */
  backup(target: string): void {
    // VACUUM INTO refuses to overwrite, so a backup never replaces an older one by accident.
    if (fs.existsSync(target)) throw new StoreError(`${target} already exists`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    this.db.prepare('VACUUM INTO ?').run(target);
  }

  /**
   * backup(), written by a worker thread with a connection of its own: a copy of a large database takes seconds, and
   * made here it held the main thread all that time (the voices' audio stood still, the panel waited, and past thirty
   * seconds the watchdog ended jukecord). The copy is the same consistent snapshot: the database is in WAL mode, where
   * a reader and this connection's writes do not wait for each other. An in-memory database (the tests') has no file
   * for another connection to open, and is copied here.
   */
  async backupAside(target: string): Promise<void> {
    if (this.file === ':memory:') return this.backup(target);
    if (fs.existsSync(target)) throw new StoreError(`${target} already exists`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Written under another name, and named a backup once whole: jukecord stopped in the middle (the worker ends with
    // it) leaves a ".partial" file, which no list takes for a backup (app/backups.ts clears it away later).
    const partial = `${target}.partial`;
    await vacuumInto(this.file, partial);
    fs.renameSync(partial, target);
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}

// The worker's own code (plain JavaScript, run as it is): a read-only connection to the database file, VACUUM INTO
// the target, and the outcome posted back. Waits up to five seconds for a lock, as the main connection does.
const VACUUM_WORKER = `
const { workerData, parentPort } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
let db = null;
try {
  db = new DatabaseSync(workerData.source, { readOnly: true, timeout: 5000 });
  db.prepare('VACUUM INTO ?').run(workerData.target);
  parentPort.postMessage({ ok: true });
} catch (error) {
  parentPort.postMessage({ ok: false, message: String((error && error.message) || error) });
} finally {
  if (db) db.close();
}
`;

// Copies the database file `source` into `target` in a worker thread; rejects with the worker's reason.
function vacuumInto(source: string, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(VACUUM_WORKER, { eval: true, workerData: { source, target } });
    // The worker's answer: done, or why not.
    worker.once('message', (answer: { ok: boolean; message?: string }) => {
      if (answer.ok) resolve();
      else reject(new StoreError(`could not write the backup: ${answer.message ?? 'no reason given'}`));
    });
    // A worker that could not start, or ended without an answer (out of memory).
    worker.once('error', (error) => reject(error));
    worker.once('exit', (code) => {
      if (code !== 0) reject(new StoreError(`the backup's worker ended with code ${code}`));
    });
  });
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

  /** Whether a track is in a server's queue, read without reading the queue itself. */
  has(guildId: string, trackId: number): boolean {
    const row = this.store.db
      .prepare('SELECT 1 AS found FROM queue_items WHERE guild_id = ? AND track_id = ? LIMIT 1')
      .get(guildId, trackId);
    return row !== undefined;
  }

  /** Removes one item; false when it is not in that server's queue (already played or removed by someone else). */
  remove(guildId: string, itemId: number): boolean {
    return this.store.transaction(() => {
      // RETURNING gives the place it had, so the items after it move up with one statement instead of a renumbering.
      const row = this.store.db
        .prepare('DELETE FROM queue_items WHERE id = ? AND guild_id = ? RETURNING position')
        .get(itemId, guildId) as Row | undefined;
      if (!row) return false;
      this.closeGap(guildId, int(row, 'position'));
      return true;
    });
  }

  /**
   * Removes several items in one transaction with one renumbering at the end, and returns how many were there.
   *
   * Removing them one by one renumbers the whole queue after each: 900 duplicates of a thousand-track queue took most
   * of a second, during which no server's music was fed.
   */
  removeMany(guildId: string, itemIds: readonly number[]): number {
    // Nothing asked: nothing written, not even an empty transaction.
    if (itemIds.length === 0) return 0;
    return this.store.transaction(() => {
      const remove = this.store.db.prepare('DELETE FROM queue_items WHERE id = ? AND guild_id = ?');
      let removed = 0;
      // Each delete is a lookup by the primary key; one already gone (played meanwhile) changes nothing.
      for (const id of itemIds) removed += Number(remove.run(id, guildId).changes);
      // The gaps they left are closed once, for all of them.
      if (removed > 0) this.compact(guildId);
      return removed;
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
      // Only the first row is read (the index on guild and position finds it): every track change used to read the
      // whole queue, a thousand rows with their tracks, to take one.
      const row = this.store.db
        .prepare(`${QUEUE_SELECT} WHERE q.guild_id = ? ORDER BY q.position, q.id LIMIT 1`)
        .get(guildId) as Row | undefined;
      if (!row) return null;
      const first = queueItemFrom(row);
      this.store.db.prepare('DELETE FROM queue_items WHERE id = ?').run(first.id);
      this.closeGap(guildId, first.position);
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

  // Closes the gap one removed item left at `position`: everything after it moves up one place, in one statement.
  // Positions stay 0..n-1 (every change keeps them so), and the order of the rest does not change.
  private closeGap(guildId: string, position: number): void {
    this.store.db
      .prepare('UPDATE queue_items SET position = position - 1 WHERE guild_id = ? AND position > ?')
      .run(guildId, position);
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

  /** Whether a server's history has a track (asked of the index on server and track, for each cover shown). */
  has(guildId: string, trackId: number): boolean {
    const row = this.store.db
      .prepare('SELECT 1 AS found FROM history WHERE guild_id = ? AND track_id = ? LIMIT 1')
      .get(guildId, trackId);
    return row !== undefined;
  }

  /** The newest `limit` entries of a server; `beforeId` pages further back. */
  list(guildId: string, limit = 50, beforeId?: number): HistoryEntry[] {
    // Newest first by ID, the order entries were written in, which is also what the cursor pages by: the index on
    // (guild, id) gives the page directly. Sorting by the time played needed a sort of every row of the server, and a
    // clock set back between two plays would have put an entry on two pages or none.
    const rows = this.store.db
      .prepare(
        `SELECT h.id, h.guild_id, h.added_by, h.played_at, h.played_ms, ${TRACK_COLUMNS}
         FROM history h JOIN tracks t ON t.id = h.track_id
         WHERE h.guild_id = ? AND h.id < ?
         ORDER BY h.id DESC LIMIT ?`,
      )
      // Without a cursor every ID qualifies; MAX_SAFE_INTEGER stands in for "no upper bound".
      .all(guildId, beforeId ?? Number.MAX_SAFE_INTEGER, limit);
    return rows.map((row) => historyFrom(row as Row));
  }

  /**
   * Listening figures of a server since `since`: totals, plays per day and per hour of the day, the most played
   * tracks and the people whose tracks were played most.
   *
   * Days and hours are in the viewer's time zone: `offsetMs` is added to every timestamp before it is cut into days,
   * so "Tuesday" means the viewer's Tuesday. Only days with plays are listed; the caller fills the gaps.
   */
  stats(guildId: string, since: number, offsetMs: number, top = 10): HistoryStats {
    const db = this.store.db;
    const totals = db
      .prepare(
        `SELECT COUNT(*) AS plays, COALESCE(SUM(played_ms), 0) AS played_ms,
                COUNT(DISTINCT track_id) AS tracks, COUNT(DISTINCT COALESCE(added_by, '')) AS people
         FROM history WHERE guild_id = ? AND played_at >= ?`,
      )
      .get(guildId, since) as Row;
    // The timestamps are milliseconds; unixepoch wants seconds, and integer division keeps whole seconds.
    const days = db
      .prepare(
        `SELECT strftime('%Y-%m-%d', (played_at + ?) / 1000, 'unixepoch') AS day, COUNT(*) AS plays,
                SUM(played_ms) AS played_ms
         FROM history WHERE guild_id = ? AND played_at >= ? GROUP BY day ORDER BY day`,
      )
      .all(offsetMs, guildId, since) as Row[];
    const hours = db
      .prepare(
        `SELECT CAST(strftime('%H', (played_at + ?) / 1000, 'unixepoch') AS INTEGER) AS hour, COUNT(*) AS plays
         FROM history WHERE guild_id = ? AND played_at >= ? GROUP BY hour`,
      )
      .all(offsetMs, guildId, since) as Row[];
    // Ties are broken by listening time, then by the track's ID, so the order is the same on every run.
    const tracks = db
      .prepare(
        `SELECT COUNT(*) AS plays, SUM(h.played_ms) AS played_ms, ${TRACK_COLUMNS}
         FROM history h JOIN tracks t ON t.id = h.track_id
         WHERE h.guild_id = ? AND h.played_at >= ?
         GROUP BY h.track_id ORDER BY plays DESC, played_ms DESC, h.track_id LIMIT ?`,
      )
      .all(guildId, since, top) as Row[];
    const people = db
      .prepare(
        `SELECT added_by, COUNT(*) AS plays, SUM(played_ms) AS played_ms
         FROM history WHERE guild_id = ? AND played_at >= ?
         GROUP BY added_by ORDER BY plays DESC, played_ms DESC, added_by LIMIT ?`,
      )
      .all(guildId, since, top) as Row[];
    // Twenty-four slots, zero where nothing played, so a chart can draw every hour.
    const byHour = Array.from({ length: 24 }, () => 0);
    for (const row of hours) byHour[int(row, 'hour')] = int(row, 'plays');
    return {
      plays: int(totals, 'plays'),
      playedMs: int(totals, 'played_ms'),
      tracks: int(totals, 'tracks'),
      people: int(totals, 'people'),
      days: days.map((row) => ({ day: text(row, 'day'), plays: int(row, 'plays'), playedMs: int(row, 'played_ms') })),
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
  }

  /**
   * A server's time in music from `since` up to `until` (Wrapped): the totals, the days with music, the top tracks
   * and people, plays by day of the week and by hour, the longest day, the first play and the song of the time.
   *
   * Days, weekdays and hours are the viewer's, as in stats(): `offsetMs` is added to every timestamp first. A day is
   * the whole number of days since the epoch of that sum, which SQLite's integer division gives without formatting a
   * date for each row (the offset is cast to an integer for it: the driver binds every JavaScript number as a real,
   * and a real's division keeps the fraction). Five questions, each one pass over the server's plays of the time by
   * the index on (server, time played): per track, per person, per day and per hour, and the first play; the totals,
   * the weekdays, the longest day and the song are summed from those answers here (the seven questions this took
   * before cost twice the time on a year of 10,000 plays).
   */
  wrapped(guildId: string, since: number, until: number, offsetMs: number, top = 5): HistoryWrapped {
    const db = this.store.db;
    // The plays of the time, the same three bound values in every question below.
    const span = 'h.guild_id = ? AND h.played_at >= ? AND h.played_at < ?';
    const within = [guildId, since, until] as const;
    // Each track's plays, time and days with plays; its title and the rest are read for the few shown only.
    const perTrack = (
      db
        .prepare(
          `SELECT h.track_id, COUNT(*) AS plays, SUM(h.played_ms) AS played_ms,
                  COUNT(DISTINCT (h.played_at + CAST(? AS INTEGER)) / 86400000) AS days
           FROM history h WHERE ${span} GROUP BY h.track_id`,
        )
        .all(offsetMs, ...within) as Row[]
    ).map((row) => ({
      id: int(row, 'track_id'),
      plays: int(row, 'plays'),
      playedMs: int(row, 'played_ms'),
      days: int(row, 'days'),
    }));
    const perPerson = (
      db
        .prepare(
          `SELECT h.added_by, COUNT(*) AS plays, SUM(h.played_ms) AS played_ms FROM history h WHERE ${span}
           GROUP BY h.added_by`,
        )
        .all(...within) as Row[]
    ).map((row) => ({
      userId: textOrNull(row, 'added_by'),
      plays: int(row, 'plays'),
      playedMs: int(row, 'played_ms'),
    }));
    const perDay = (
      db
        .prepare(
          `SELECT (h.played_at + CAST(? AS INTEGER)) / 86400000 AS day, COUNT(*) AS plays,
                  SUM(h.played_ms) AS played_ms
           FROM history h WHERE ${span} GROUP BY day`,
        )
        .all(offsetMs, ...within) as Row[]
    ).map((row) => ({ day: int(row, 'day'), plays: int(row, 'plays'), playedMs: int(row, 'played_ms') }));
    const hours = db
      .prepare(
        `SELECT ((h.played_at + CAST(? AS INTEGER)) % 86400000) / 3600000 AS hour, COUNT(*) AS plays
         FROM history h WHERE ${span} GROUP BY hour`,
      )
      .all(offsetMs, ...within) as Row[];
    const first = db
      .prepare(
        `SELECT h.id, h.guild_id, h.added_by, h.played_at, h.played_ms, ${TRACK_COLUMNS}
         FROM history h JOIN tracks t ON t.id = h.track_id WHERE ${span} ORDER BY h.played_at, h.id LIMIT 1`,
      )
      .get(...within) as Row | undefined;
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
    const track = (id: number) => {
      const found = this.store.tracks.get(id);
      if (!found) throw new StoreError(`track ${id} of the history cannot be read`);
      return found;
    };
    return {
      plays: perTrack.reduce((sum, entry) => sum + entry.plays, 0),
      playedMs: perTrack.reduce((sum, entry) => sum + entry.playedMs, 0),
      tracks: perTrack.length,
      people: perPerson.length,
      days: perDay.length,
      topTracks: tracks.map((entry) => ({ track: track(entry.id), plays: entry.plays, playedMs: entry.playedMs })),
      topPeople: people,
      weekdays: byWeekday,
      hours: byHour,
      longestDay: longest
        ? {
            day: new Date(longest.day * 86_400_000).toISOString().slice(0, 10),
            plays: longest.plays,
            playedMs: longest.playedMs,
          }
        : null,
      firstPlay: first ? historyFrom(first) : null,
      song: song ? { track: track(song.id), plays: song.plays, playedMs: song.playedMs, days: song.days } : null,
    };
  }

  /** The newest play's ID of a server (0 when it has none): what changes whenever its history does. */
  newest(guildId: string): number {
    const row = this.store.db.prepare('SELECT MAX(id) AS id FROM history WHERE guild_id = ?').get(guildId) as Row;
    return intOrNull(row, 'id') ?? 0;
  }

  /**
   * The months a server has plays in, newest first (YYYY-MM in the viewer's time zone), and how far back its history
   * reaches: its oldest play, and whether it holds as many plays as it keeps (older ones were let go).
   */
  months(guildId: string, offsetMs: number): { months: string[]; oldest: number | null; full: boolean } {
    const rows = this.store.db
      .prepare(
        `SELECT DISTINCT strftime('%Y-%m', (played_at + ?) / 1000, 'unixepoch') AS month FROM history
         WHERE guild_id = ? ORDER BY month DESC`,
      )
      .all(offsetMs, guildId) as Row[];
    const reach = this.store.db
      .prepare('SELECT MIN(played_at) AS oldest, COUNT(*) AS plays FROM history WHERE guild_id = ?')
      .get(guildId) as Row;
    return {
      months: rows.map((row) => text(row, 'month')),
      oldest: intOrNull(reach, 'oldest'),
      full: int(reach, 'plays') >= HISTORY_KEEP,
    };
  }
}

/** A server's time in music, for Wrapped (see HistoryRepository.wrapped). */
export interface HistoryWrapped {
  readonly plays: number;
  readonly playedMs: number;
  /** Distinct tracks played. */
  readonly tracks: number;
  /** Distinct people whose tracks were played; the host counts as one, as in the statistics. */
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

  /** Whether one of a server's playlists holds a track (a server has a few lists of a few hundred tracks at most). */
  has(guildId: string, trackId: number): boolean {
    const row = this.store.db
      .prepare(
        `SELECT 1 AS found FROM playlist_items i JOIN playlists p ON p.id = i.playlist_id
         WHERE p.guild_id = ? AND i.track_id = ? LIMIT 1`,
      )
      .get(guildId, trackId);
    return row !== undefined;
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
  get(guildId: string): GuildSettings {
    const row = this.store.db
      .prepare('SELECT dj_role_id, alerts_channel_id FROM guild_settings WHERE guild_id = ?')
      .get(guildId) as Row | undefined;
    return {
      djRoleId: row ? textOrNull(row, 'dj_role_id') : null,
      alertsChannelId: row ? textOrNull(row, 'alerts_channel_id') : null,
    };
  }

  /** Sets or clears (null) the text channel where jukecord tells the server about trouble. */
  setAlertsChannel(guildId: string, channelId: string | null): void {
    this.store.db
      .prepare(
        `INSERT INTO guild_settings (guild_id, alerts_channel_id, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (guild_id) DO UPDATE SET alerts_channel_id = excluded.alerts_channel_id,
           updated_at = excluded.updated_at`,
      )
      .run(guildId, channelId, this.now());
  }

  /** The servers that chose an alerts channel, with it. */
  withAlerts(): { readonly guildId: string; readonly channelId: string }[] {
    const rows = this.store.db
      .prepare('SELECT guild_id, alerts_channel_id FROM guild_settings WHERE alerts_channel_id IS NOT NULL')
      .all() as Row[];
    return rows.map((row) => ({ guildId: text(row, 'guild_id'), channelId: text(row, 'alerts_channel_id') }));
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

  /** Forgets that commands were registered in a server (the bot left it, and Discord removed them). */
  clearCommandsHash(guildId: string): void {
    this.store.db.prepare('DELETE FROM discord_commands WHERE guild_id = ?').run(guildId);
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
  upsert(person: Person): void {
    this.store.db
      .prepare(
        `INSERT INTO users (id, name, avatar, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, avatar = excluded.avatar, updated_at = excluded.updated_at`,
      )
      .run(person.id, person.name, person.avatar, this.now());
  }

  get(id: string): Person | null {
    const row = this.store.db.prepare('SELECT id, name, avatar FROM users WHERE id = ?').get(id) as Row | undefined;
    return row ? { id: text(row, 'id'), name: text(row, 'name'), avatar: textOrNull(row, 'avatar') } : null;
  }

  /** The people among `ids` that are known; unknown IDs are simply absent from the map. */
  many(ids: Iterable<string>): Map<string, Person> {
    const people = new Map<string, Person>();
    // One lookup per distinct ID: a queue of a thousand tracks is added by a handful of people.
    for (const id of new Set(ids)) {
      const person = this.get(id);
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

  create(session: Omit<SessionRow, 'createdAt' | 'seenAt'>): SessionRow {
    const now = this.now();
    this.store.db
      .prepare(
        `INSERT INTO sessions (id_hash, kind, user_id, csrf, scope, created_at, seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(session.idHash, session.kind, session.userId, session.csrf, session.scope, now, now, session.expiresAt);
    return { ...session, createdAt: now, seenAt: now };
  }

  /** The login with this hash, or null when there is none or it has expired (an expired one is removed). */
  get(idHash: string): SessionRow | null {
    const row = this.store.db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(idHash) as Row | undefined;
    if (!row) return null;
    const session = sessionFrom(row);
    if (session.expiresAt <= this.now()) {
      this.remove(idHash);
      return null;
    }
    return session;
  }

  /** Notes that the login was used now (shown nowhere yet; kept for pruning logins nobody uses). */
  touch(idHash: string): void {
    this.store.db.prepare('UPDATE sessions SET seen_at = ? WHERE id_hash = ?').run(this.now(), idHash);
  }

  remove(idHash: string): boolean {
    return Number(this.store.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash).changes) > 0;
  }

  /** Deletes expired logins and returns how many went. */
  prune(): number {
    return Number(this.store.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(this.now()).changes);
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

  create(token: {
    hash: string;
    name: string;
    kind: PrincipalKind;
    userId: string | null;
    scope: TokenScope;
  }): TokenRow {
    const name = token.name.trim();
    if (name.length === 0 || name.length > 100) throw new StoreError('a token name is 1 to 100 characters');
    const row = this.store.db
      .prepare(
        `INSERT INTO api_tokens (hash, name, kind, user_id, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)
         RETURNING id, name, kind, user_id, scope, created_at, used_at`,
      )
      .get(token.hash, name, token.kind, token.userId, token.scope, this.now()) as Row;
    return tokenFrom(row);
  }

  /** The token with this hash, or null. */
  byHash(hash: string): TokenRow | null {
    const row = this.store.db
      .prepare('SELECT id, name, kind, user_id, scope, created_at, used_at FROM api_tokens WHERE hash = ?')
      .get(hash) as Row | undefined;
    return row ? tokenFrom(row) : null;
  }

  get(id: number): TokenRow | null {
    const row = this.store.db
      .prepare('SELECT id, name, kind, user_id, scope, created_at, used_at FROM api_tokens WHERE id = ?')
      .get(id) as Row | undefined;
    return row ? tokenFrom(row) : null;
  }

  /** Every token (for the host), or the tokens of one user. Newest first. */
  list(userId?: string): TokenRow[] {
    const rows =
      userId === undefined
        ? this.store.db
            .prepare('SELECT id, name, kind, user_id, scope, created_at, used_at FROM api_tokens ORDER BY id DESC')
            .all()
        : this.store.db
            .prepare(
              `SELECT id, name, kind, user_id, scope, created_at, used_at FROM api_tokens
               WHERE kind = 'user' AND user_id = ? ORDER BY id DESC`,
            )
            .all(userId);
    return rows.map((row) => tokenFrom(row as Row));
  }

  /** Notes that the token was used now, so a list can show tokens nobody uses any more. */
  touch(id: number): void {
    this.store.db.prepare('UPDATE api_tokens SET used_at = ? WHERE id = ?').run(this.now(), id);
  }

  remove(id: number): boolean {
    return Number(this.store.db.prepare('DELETE FROM api_tokens WHERE id = ?').run(id).changes) > 0;
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
  remember(guildId: string, channelId: string): void {
    this.store.db
      .prepare(
        `INSERT INTO voice_channels (guild_id, channel_id, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (guild_id) DO UPDATE SET channel_id = excluded.channel_id, updated_at = excluded.updated_at`,
      )
      .run(guildId, channelId, this.now());
  }

  /** Forgets a server's channel (the bot left it). */
  forget(guildId: string): void {
    this.store.db.prepare('DELETE FROM voice_channels WHERE guild_id = ?').run(guildId);
  }

  /** The channel kept for a server, or null when there is none. */
  get(guildId: string): string | null {
    const row = this.store.db.prepare('SELECT channel_id FROM voice_channels WHERE guild_id = ?').get(guildId) as
      | Row
      | undefined;
    return row ? text(row, 'channel_id') : null;
  }

  /** Notes that the bot said in a server's channel that it came back, now. */
  told(guildId: string): void {
    this.store.db.prepare('UPDATE voice_channels SET told_at = ? WHERE guild_id = ?').run(this.now(), guildId);
  }

  /** When the bot last said in a server's channel that it came back (ms since 1970), or null for never. */
  toldAt(guildId: string): number | null {
    const row = this.store.db.prepare('SELECT told_at FROM voice_channels WHERE guild_id = ?').get(guildId) as
      | { told_at: number | bigint | null }
      | undefined;
    return row?.told_at == null ? null : Number(row.told_at);
  }

  /** Every channel kept, in the order they were first kept. */
  all(): { readonly guildId: string; readonly channelId: string }[] {
    const rows = this.store.db.prepare('SELECT guild_id, channel_id FROM voice_channels ORDER BY rowid').all() as Row[];
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
  get(trackId: number): LyricsRow | null {
    const row = this.store.db.prepare('SELECT * FROM lyrics WHERE track_id = ?').get(trackId) as Row | undefined;
    return row ? lyricsFrom(row) : null;
  }

  /** Keeps what a lookup found (or that it found nothing), replacing what was kept, and returns it as kept. */
  save(lyrics: Omit<LyricsRow, 'fetchedAt'>): LyricsRow {
    const row = this.store.db
      .prepare(
        `INSERT INTO lyrics (track_id, kind, synced, plain, source_id, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (track_id) DO UPDATE SET kind = excluded.kind, synced = excluded.synced, plain = excluded.plain,
           source_id = excluded.source_id, fetched_at = excluded.fetched_at
         RETURNING *`,
      )
      .get(
        lyrics.trackId,
        lyrics.kind,
        capped(lyrics.synced),
        capped(lyrics.plain),
        lyrics.sourceId,
        this.now(),
      ) as Row;
    return lyricsFrom(row);
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
  get(trackId: number): TrackMusic | null {
    const row = this.store.db.prepare('SELECT artist, title, album FROM track_music WHERE track_id = ?').get(trackId) as
      | Row
      | undefined;
    return row ? { artist: text(row, 'artist'), title: text(row, 'title'), album: textOrNull(row, 'album') } : null;
  }

  /** Keeps what a site said a track is; a later lookup that says it again replaces it. */
  set(trackId: number, music: TrackMusic): void {
    const cut = (value: string) => value.trim().slice(0, MUSIC_NAME_MAX);
    this.store.db
      .prepare(
        `INSERT INTO track_music (track_id, artist, title, album, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (track_id) DO UPDATE SET artist = excluded.artist, title = excluded.title, album = excluded.album,
           updated_at = excluded.updated_at`,
      )
      .run(trackId, cut(music.artist), cut(music.title), music.album === null ? null : cut(music.album), this.now());
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
  create(link: {
    hash: string;
    guildId: string;
    createdBy: string | null;
    lastsMs: number;
    maxGuests: number;
  }): ListenLinkRow {
    const now = this.now();
    const row = this.store.db
      .prepare(
        `INSERT INTO listen_links (hash, guild_id, created_by, created_at, expires_at, max_guests)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(link.hash, link.guildId, link.createdBy, now, now + link.lastsMs, link.maxGuests) as Row;
    const made = this.get(int(row, 'id'));
    if (!made) throw new StoreError('the listening link just written cannot be read back');
    return made;
  }

  /** The link with this ID while it has not expired, or null. */
  get(id: number): ListenLinkRow | null {
    const now = this.now();
    const row = this.store.db.prepare(`${LINK_SELECT} WHERE l.id = ? AND l.expires_at > ?`).get(now, id, now) as
      | Row
      | undefined;
    return row ? linkFrom(row) : null;
  }

  /** The link whose code has this hash while it has not expired, or null. */
  byHash(hash: string): ListenLinkRow | null {
    const now = this.now();
    const row = this.store.db.prepare(`${LINK_SELECT} WHERE l.hash = ? AND l.expires_at > ?`).get(now, hash, now) as
      | Row
      | undefined;
    return row ? linkFrom(row) : null;
  }

  /** A server's links that have not expired, newest first: everyone's, or one person's (`createdBy`). */
  list(guildId: string, createdBy?: string): ListenLinkRow[] {
    const now = this.now();
    const rows =
      createdBy === undefined
        ? this.store.db
            .prepare(`${LINK_SELECT} WHERE l.guild_id = ? AND l.expires_at > ? ORDER BY l.id DESC`)
            .all(now, guildId, now)
        : this.store.db
            .prepare(`${LINK_SELECT} WHERE l.guild_id = ? AND l.expires_at > ? AND l.created_by = ? ORDER BY l.id DESC`)
            .all(now, guildId, now, createdBy);
    return rows.map((row) => linkFrom(row as Row));
  }

  /** How many links of a server have not expired. */
  count(guildId: string): number {
    const row = this.store.db
      .prepare('SELECT COUNT(*) AS n FROM listen_links WHERE guild_id = ? AND expires_at > ?')
      .get(guildId, this.now()) as Row;
    return int(row, 'n');
  }

  /** Deletes a link and, with it, the sessions of its guests; false when there was none. */
  remove(id: number): boolean {
    return Number(this.store.db.prepare('DELETE FROM listen_links WHERE id = ?').run(id).changes) > 0;
  }

  /** Deletes the links that have expired (their guests' sessions go with them) and returns how many went. */
  prune(): number {
    return Number(this.store.db.prepare('DELETE FROM listen_links WHERE expires_at <= ?').run(this.now()).changes);
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

  create(session: { idHash: string; linkId: number; csrf: string; expiresAt: number }): void {
    const now = this.now();
    this.store.db
      .prepare(
        `INSERT INTO guest_sessions (id_hash, link_id, csrf, created_at, seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(session.idHash, session.linkId, session.csrf, now, now, session.expiresAt);
  }

  /**
   * The guest with this hash, with the server of its link, or null when there is none: never was, logged out, its
   * link revoked (deleted with it) or expired (an expired one is removed).
   */
  get(idHash: string): GuestSessionRow | null {
    const row = this.store.db
      .prepare(
        `SELECT g.*, l.guild_id FROM guest_sessions g JOIN listen_links l ON l.id = g.link_id WHERE g.id_hash = ?`,
      )
      .get(idHash) as Row | undefined;
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
      this.remove(idHash);
      return null;
    }
    return session;
  }

  /** Notes that the guest was seen now (at most once a minute, by its caller). */
  touch(idHash: string): void {
    this.store.db.prepare('UPDATE guest_sessions SET seen_at = ? WHERE id_hash = ?').run(this.now(), idHash);
  }

  /** Ends a guest's session (the guest left); false when there was none. */
  remove(idHash: string): boolean {
    return Number(this.store.db.prepare('DELETE FROM guest_sessions WHERE id_hash = ?').run(idHash).changes) > 0;
  }

  /** How many guests of a link are in (their sessions not expired). */
  count(linkId: number): number {
    const row = this.store.db
      .prepare('SELECT COUNT(*) AS n FROM guest_sessions WHERE link_id = ? AND expires_at > ?')
      .get(linkId, this.now()) as Row;
    return int(row, 'n');
  }

  /** Deletes the expired sessions of guests and returns how many went. */
  prune(): number {
    return Number(this.store.db.prepare('DELETE FROM guest_sessions WHERE expires_at <= ?').run(this.now()).changes);
  }
}
