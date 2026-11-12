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
  {
    version: 3,
    sql: `
      -- Discord people jukecord has met (through a command or a panel login), so the panel can show who added a
      -- track by name. Only what Discord shows everyone: the display name and the avatar's hash.
      CREATE TABLE users (
        id         TEXT    PRIMARY KEY,
        name       TEXT    NOT NULL,
        avatar     TEXT,
        updated_at INTEGER NOT NULL
      );

      -- Panel logins. The cookie holds a random secret; only its SHA-256 is stored, so a copy of the database does not
      -- log anyone in. "kind" is host (a login link from the machine running jukecord) or user (Discord login).
      CREATE TABLE sessions (
        id_hash    TEXT    PRIMARY KEY,
        kind       TEXT    NOT NULL,
        user_id    TEXT,
        csrf       TEXT    NOT NULL,
        created_at INTEGER NOT NULL,
        seen_at    INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX sessions_by_expiry ON sessions(expires_at);

      -- API tokens for the CLI and scripts, stored as SHA-256 hashes like the sessions. "scope" is read, control or
      -- admin; "kind" and "user_id" say whose token it is (the host's, or a Discord user's).
      CREATE TABLE api_tokens (
        id         INTEGER PRIMARY KEY,
        hash       TEXT    NOT NULL UNIQUE,
        name       TEXT    NOT NULL,
        kind       TEXT    NOT NULL,
        user_id    TEXT,
        scope      TEXT    NOT NULL,
        created_at INTEGER NOT NULL,
        used_at    INTEGER
      );
    `,
  },
  {
    version: 4,
    sql: `
      -- Whether a server ever played a track, asked for every cover the panel shows (the history and Wrapped show
      -- covers of tracks no longer queued): without it the question walked up to 10,000 rows of the server's history.
      CREATE INDEX history_by_guild_track ON history(guild_id, track_id);
    `,
  },
  {
    version: 5,
    sql: `
      -- The voice channel the bot is in, per server, so that coming back after a restart (an update, a crash) it can
      -- go back there when people are in it. Kept while the bot is in the channel; a leave by a person, by the bot
      -- itself (nobody there) or by Discord removes it, and jukecord stopping does not.
      -- told_at: when the bot last said in the channel that it came back (once an hour at most: a crash loop comes
      -- back each time, and the channel's chat is people's); null before the first time.
      CREATE TABLE voice_channels (
        guild_id   TEXT    PRIMARY KEY,
        channel_id TEXT    NOT NULL,
        updated_at INTEGER NOT NULL,
        told_at    INTEGER
      );

      -- The text channel where jukecord tells a server about trouble (app/alerts.ts); null for nowhere.
      ALTER TABLE guild_settings ADD COLUMN alerts_channel_id TEXT;
    `,
  },
  {
    version: 6,
    sql: `
      -- Lyrics found for a track, or that none were found (asked again after a while), from LRCLIB: kept, so a track
      -- is asked about once. "kind" is synced (timed lines, with the plain text beside them), plain (no timings),
      -- instrumental or none; "source_id" is LRCLIB's own number for the record.
      CREATE TABLE lyrics (
        track_id   INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
        kind       TEXT    NOT NULL,
        synced     TEXT,
        plain      TEXT,
        source_id  INTEGER,
        fetched_at INTEGER NOT NULL
      );

      -- What the site says a recording is, when it says (YouTube Music's song, artist and album): what its lyrics are
      -- looked up by. A track without a row has its title and channel read instead.
      CREATE TABLE track_music (
        track_id   INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
        artist     TEXT    NOT NULL,
        title      TEXT    NOT NULL,
        album      TEXT,
        updated_at INTEGER NOT NULL
      );

      -- Listening links: a code that lets guests without a Discord account listen along to one server until the link
      -- expires. Only the code's SHA-256 is stored, as for every secret; "max_guests" is how many browsers it takes.
      CREATE TABLE listen_links (
        id         INTEGER PRIMARY KEY,
        hash       TEXT    NOT NULL UNIQUE,
        guild_id   TEXT    NOT NULL,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        max_guests INTEGER NOT NULL
      );
      CREATE INDEX listen_links_by_guild ON listen_links(guild_id, expires_at);

      -- The browsers that came in with a listening link. A table of their own, never the sessions table: a session
      -- there without a user is the host's. They end with their link, when it expires and, deleted with it, at once
      -- when it is revoked.
      CREATE TABLE guest_sessions (
        id_hash    TEXT    PRIMARY KEY,
        link_id    INTEGER NOT NULL REFERENCES listen_links(id) ON DELETE CASCADE,
        csrf       TEXT    NOT NULL,
        created_at INTEGER NOT NULL,
        seen_at    INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX guest_sessions_by_link ON guest_sessions(link_id);

      -- What a panel login may do: all its login may (admin, as every login before this version could), or for a
      -- friend the host let in with a login link, only look (read) or also change the music (control).
      ALTER TABLE sessions ADD COLUMN scope TEXT NOT NULL DEFAULT 'admin';
    `,
  },
];
