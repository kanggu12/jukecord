/**
 * The database schema as a list of migrations, applied in order and recorded in SQLite's user_version.
 *
 * A migration is never edited once released: a data directory that already ran it would not run it again. Changes
 * go in a new entry at the end. Tests open a fresh database and every older one jukecord can meet.
 */

/** One step of the schema; `version` is what user_version becomes after it. */
export interface Migration {
  readonly version: number;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      -- Every track ever added. "source" is the normalised address and the cache key, so it is unique.
      CREATE TABLE tracks (
        id          INTEGER PRIMARY KEY,
        source      TEXT    NOT NULL UNIQUE,
        url         TEXT    NOT NULL,
        title       TEXT    NOT NULL,
        uploader    TEXT,
        duration_ms INTEGER,
        thumbnail   TEXT,
        loudness    REAL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      -- The upcoming tracks of each server. Positions are rewritten to 0..n-1 after every change; there is no unique
      -- index on them because reordering would collide halfway through an update.
      CREATE TABLE queue_items (
        id        INTEGER PRIMARY KEY,
        guild_id  TEXT    NOT NULL,
        position  INTEGER NOT NULL,
        track_id  INTEGER NOT NULL REFERENCES tracks(id),
        added_by  TEXT,
        added_at  INTEGER NOT NULL
      );
      CREATE INDEX queue_items_by_guild ON queue_items(guild_id, position);

      -- What each server was playing, so a restart comes back paused at the same place.
      CREATE TABLE player_state (
        guild_id    TEXT    PRIMARY KEY,
        track_id    INTEGER REFERENCES tracks(id),
        added_by    TEXT,
        status      TEXT    NOT NULL,
        position_ms INTEGER NOT NULL DEFAULT 0,
        updated_at  INTEGER NOT NULL
      );

      -- Every track that played, newest first by the index.
      CREATE TABLE history (
        id        INTEGER PRIMARY KEY,
        guild_id  TEXT    NOT NULL,
        track_id  INTEGER NOT NULL REFERENCES tracks(id),
        added_by  TEXT,
        played_at INTEGER NOT NULL,
        played_ms INTEGER NOT NULL
      );
      CREATE INDEX history_by_guild ON history(guild_id, played_at DESC);

      -- Saved lists, named per server.
      CREATE TABLE playlists (
        id         INTEGER PRIMARY KEY,
        guild_id   TEXT    NOT NULL,
        name       TEXT    NOT NULL,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (guild_id, name)
      );
      CREATE TABLE playlist_items (
        playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
        position    INTEGER NOT NULL,
        track_id    INTEGER NOT NULL REFERENCES tracks(id),
        PRIMARY KEY (playlist_id, position)
      );

      -- Per-server choices: for now the role that may change the queue (none means every member).
      CREATE TABLE guild_settings (
        guild_id   TEXT    PRIMARY KEY,
        dj_role_id TEXT,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    sql: `
      -- The repeat mode of each server's player (off, track, queue), kept across restarts with the rest of its state.
      ALTER TABLE player_state ADD COLUMN repeat TEXT NOT NULL DEFAULT 'off';

      -- A fingerprint of the slash commands last registered in each server. Discord allows 200 command
      -- registrations per server a day; registering only when the fingerprint changes keeps restarts free.
      CREATE TABLE discord_commands (
        guild_id   TEXT    PRIMARY KEY,
        hash       TEXT    NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- History pruning deletes the oldest rows of a server; this index makes finding them cheap.
      CREATE INDEX history_by_guild_id ON history(guild_id, id);
    `,
  },
];
