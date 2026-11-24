/**
 * The database schema as a list of migrations, applied in order and recorded in the database: SQLite's user_version,
 * or the one row of the table jukecord_schema on PostgreSQL and MySQL/MariaDB.
 *
 * SQLite runs migrations 1 to 8 as they were released. PostgreSQL and MySQL start at a baseline that makes schema 8 in
 * one go (SERVER_BASELINE below), and every migration after 8 is written for the three together: `sql` for SQLite and
 * `postgres` and `mysql` beside it (a test fails a migration past the baseline without both).
 *
 * A migration is never edited once released: a data directory that already ran it would not run it again. Changes
 * go in a new entry at the end. Tests open a fresh database and every older one jukecord can meet. MySQL commits each
 * statement that changes a table by itself (there is no transaction around them), so a MySQL migration is written to
 * do no harm when it is run again after a stop halfway: IF NOT EXISTS where MySQL has it, one statement where not.
 */

/** One step of the schema; `version` is what the database's schema version becomes after it. */
export interface Migration {
  readonly version: number;
  /** SQLite's statements. */
  readonly sql: string;
  /** PostgreSQL's statements: needed for every version after the servers' baseline. */
  readonly postgres?: string;
  /** MySQL's and MariaDB's statements: needed for every version after the servers' baseline. */
  readonly mysql?: string;
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
  {
    version: 7,
    sql: `
      -- How a server's people share the music, each with the default of a server that never chose: whether Skip from
      -- someone without the DJ role is a vote (on), whether tracks added take turns by person (off), how many tracks
      -- one person may have queued (0: no limit), whether the bot stays in voice when everyone has left (off), and the
      -- voice channel's volume in percent (100) and sound preset (off).
      ALTER TABLE guild_settings ADD COLUMN vote_skip    INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE guild_settings ADD COLUMN take_turns   INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE guild_settings ADD COLUMN person_limit INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE guild_settings ADD COLUMN stay         INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE guild_settings ADD COLUMN volume       INTEGER NOT NULL DEFAULT 100;
      ALTER TABLE guild_settings ADD COLUMN sound        TEXT    NOT NULL DEFAULT 'off';
    `,
  },
  {
    version: 8,
    sql: `
      -- The tracks each login liked. "owner" is the Discord user ID, or "host" for the host's login (no Discord ID is
      -- a word). A track is liked once per login; the newest first by the index, for the list.
      CREATE TABLE likes (
        owner      TEXT    NOT NULL,
        track_id   INTEGER NOT NULL REFERENCES tracks(id),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (owner, track_id)
      );
      CREATE INDEX likes_by_owner ON likes(owner, created_at DESC);
      -- How many logins liked a track, which autoplay weighs, without reading every like.
      CREATE INDEX likes_by_track ON likes(track_id);

      -- What a server's player does when its queue runs out (off, history, related), kept across restarts with the
      -- rest of its state, as the repeat mode is.
      ALTER TABLE player_state ADD COLUMN autoplay TEXT NOT NULL DEFAULT 'off';
    `,
  },
  {
    version: 9,
    // The host's settings saved from the panel, the API or the CLI, kept with the data so every service of a split
    // jukecord reads the same (src/settings): a row per setting by its environment name. A value of NULL is a setting
    // put back to its default; the row stays, with its revision, so a change made from a page that read an older
    // revision is told apart from one made on the latest. Secrets and the settings needed before the database opens
    // live in settings.json in the data folder instead, never here.
    sql: `
      CREATE TABLE host_settings (
        name       TEXT    PRIMARY KEY,
        value      TEXT,
        revision   INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
    postgres: `
      CREATE TABLE host_settings (
        name       TEXT COLLATE "C" PRIMARY KEY,
        value      TEXT COLLATE "C",
        revision   BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
    `,
    // MySQL commits a CREATE TABLE by itself: IF NOT EXISTS lets a migration stopped after it run again.
    mysql: `
      CREATE TABLE IF NOT EXISTS host_settings (
        name       VARCHAR(255) NOT NULL,
        value      TEXT,
        revision   BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
    `,
  },
];

/** The version the servers' baseline makes at once: schema 8, the last released before PostgreSQL and MySQL. */
export const SERVER_BASELINE_VERSION = 8;

// PostgreSQL's text columns compare and sort byte by byte (the "C" collation), as SQLite's do, whatever the
// database's own collation is: a name, an ID or a source orders the same on both.
const PG_TEXT = 'TEXT COLLATE "C"';

/**
 * PostgreSQL's baseline: schema 8 of SQLite's migrations in one step. Every whole number is a BIGINT (SQLite's
 * INTEGER holds 64 bits; the timestamps are milliseconds), ids are identity columns that take a value given (a copy)
 * or make one, and a track's source is unique by its SHA-256 (a btree entry takes at most 2704 bytes; an address can
 * be longer). The rows of voice_channels keep the order they were first kept in with `seq`, as SQLite's rowid.
 */
export const POSTGRES_BASELINE = `
  CREATE TABLE tracks (
    id          BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    source      ${PG_TEXT} NOT NULL,
    source_hash BYTEA NOT NULL GENERATED ALWAYS AS (sha256(decode(replace(source, chr(92), chr(92) || chr(92)), 'escape'))) STORED,
    url         ${PG_TEXT} NOT NULL,
    title       ${PG_TEXT} NOT NULL,
    uploader    ${PG_TEXT},
    duration_ms BIGINT,
    thumbnail   ${PG_TEXT},
    loudness    DOUBLE PRECISION,
    created_at  BIGINT NOT NULL,
    updated_at  BIGINT NOT NULL,
    CONSTRAINT tracks_source_hash UNIQUE (source_hash)
  );

  CREATE TABLE queue_items (
    id       BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    guild_id ${PG_TEXT} NOT NULL,
    position BIGINT NOT NULL,
    track_id BIGINT NOT NULL REFERENCES tracks(id),
    added_by ${PG_TEXT},
    added_at BIGINT NOT NULL
  );
  CREATE INDEX queue_items_by_guild ON queue_items(guild_id, position);

  CREATE TABLE player_state (
    guild_id    ${PG_TEXT} PRIMARY KEY,
    track_id    BIGINT REFERENCES tracks(id),
    added_by    ${PG_TEXT},
    status      ${PG_TEXT} NOT NULL,
    position_ms BIGINT NOT NULL DEFAULT 0,
    updated_at  BIGINT NOT NULL,
    "repeat"    ${PG_TEXT} NOT NULL DEFAULT 'off',
    autoplay    ${PG_TEXT} NOT NULL DEFAULT 'off'
  );

  CREATE TABLE history (
    id        BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    guild_id  ${PG_TEXT} NOT NULL,
    track_id  BIGINT NOT NULL REFERENCES tracks(id),
    added_by  ${PG_TEXT},
    played_at BIGINT NOT NULL,
    played_ms BIGINT NOT NULL
  );
  CREATE INDEX history_by_guild ON history(guild_id, played_at DESC);
  CREATE INDEX history_by_guild_id ON history(guild_id, id);
  CREATE INDEX history_by_guild_track ON history(guild_id, track_id);

  CREATE TABLE playlists (
    id         BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    guild_id   ${PG_TEXT} NOT NULL,
    name       ${PG_TEXT} NOT NULL,
    created_by ${PG_TEXT},
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    UNIQUE (guild_id, name)
  );
  CREATE TABLE playlist_items (
    playlist_id BIGINT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    position    BIGINT NOT NULL,
    track_id    BIGINT NOT NULL REFERENCES tracks(id),
    PRIMARY KEY (playlist_id, position)
  );

  CREATE TABLE guild_settings (
    guild_id          ${PG_TEXT} PRIMARY KEY,
    dj_role_id        ${PG_TEXT},
    updated_at        BIGINT NOT NULL,
    alerts_channel_id ${PG_TEXT},
    vote_skip         BIGINT NOT NULL DEFAULT 1,
    take_turns        BIGINT NOT NULL DEFAULT 0,
    person_limit      BIGINT NOT NULL DEFAULT 0,
    stay              BIGINT NOT NULL DEFAULT 0,
    volume            BIGINT NOT NULL DEFAULT 100,
    sound             ${PG_TEXT} NOT NULL DEFAULT 'off'
  );

  CREATE TABLE discord_commands (
    guild_id   ${PG_TEXT} PRIMARY KEY,
    hash       ${PG_TEXT} NOT NULL,
    updated_at BIGINT NOT NULL
  );

  CREATE TABLE users (
    id         ${PG_TEXT} PRIMARY KEY,
    name       ${PG_TEXT} NOT NULL,
    avatar     ${PG_TEXT},
    updated_at BIGINT NOT NULL
  );

  CREATE TABLE sessions (
    id_hash    ${PG_TEXT} PRIMARY KEY,
    kind       ${PG_TEXT} NOT NULL,
    user_id    ${PG_TEXT},
    csrf       ${PG_TEXT} NOT NULL,
    created_at BIGINT NOT NULL,
    seen_at    BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    scope      ${PG_TEXT} NOT NULL DEFAULT 'admin'
  );
  CREATE INDEX sessions_by_expiry ON sessions(expires_at);

  CREATE TABLE api_tokens (
    id         BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    hash       ${PG_TEXT} NOT NULL UNIQUE,
    name       ${PG_TEXT} NOT NULL,
    kind       ${PG_TEXT} NOT NULL,
    user_id    ${PG_TEXT},
    scope      ${PG_TEXT} NOT NULL,
    created_at BIGINT NOT NULL,
    used_at    BIGINT
  );

  CREATE TABLE voice_channels (
    guild_id   ${PG_TEXT} PRIMARY KEY,
    channel_id ${PG_TEXT} NOT NULL,
    updated_at BIGINT NOT NULL,
    told_at    BIGINT,
    seq        BIGINT GENERATED ALWAYS AS IDENTITY
  );

  CREATE TABLE lyrics (
    track_id   BIGINT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    kind       ${PG_TEXT} NOT NULL,
    synced     ${PG_TEXT},
    plain      ${PG_TEXT},
    source_id  BIGINT,
    fetched_at BIGINT NOT NULL
  );

  CREATE TABLE track_music (
    track_id   BIGINT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    artist     ${PG_TEXT} NOT NULL,
    title      ${PG_TEXT} NOT NULL,
    album      ${PG_TEXT},
    updated_at BIGINT NOT NULL
  );

  CREATE TABLE listen_links (
    id         BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    hash       ${PG_TEXT} NOT NULL UNIQUE,
    guild_id   ${PG_TEXT} NOT NULL,
    created_by ${PG_TEXT},
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    max_guests BIGINT NOT NULL
  );
  CREATE INDEX listen_links_by_guild ON listen_links(guild_id, expires_at);

  CREATE TABLE guest_sessions (
    id_hash    ${PG_TEXT} PRIMARY KEY,
    link_id    BIGINT NOT NULL REFERENCES listen_links(id) ON DELETE CASCADE,
    csrf       ${PG_TEXT} NOT NULL,
    created_at BIGINT NOT NULL,
    seen_at    BIGINT NOT NULL,
    expires_at BIGINT NOT NULL
  );
  CREATE INDEX guest_sessions_by_link ON guest_sessions(link_id);

  CREATE TABLE likes (
    owner      ${PG_TEXT} NOT NULL,
    track_id   BIGINT NOT NULL REFERENCES tracks(id),
    created_at BIGINT NOT NULL,
    PRIMARY KEY (owner, track_id)
  );
  CREATE INDEX likes_by_owner ON likes(owner, created_at DESC);
  CREATE INDEX likes_by_track ON likes(track_id);
`;

// MySQL's and MariaDB's tables: InnoDB, every text in utf8mb4 (any character, emoji included) with the utf8mb4_bin
// collation, so text compares and sorts by its characters' numbers as SQLite's does (case and accents matter).
const MYSQL_TABLE = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin';

// A word jukecord writes (an ID, a hash, a kind) that keys and indexes may hold: 255 characters, 1020 bytes in
// utf8mb4, well within InnoDB's 3072 bytes for a key of two of them. Text people write (titles, names, addresses) is
// TEXT, which a key cannot hold whole; the lyrics are MEDIUMTEXT (64,000 characters of four bytes each).
const MY_WORD = 'VARCHAR(255)';

/**
 * MySQL's and MariaDB's baseline: schema 8 in one step, as PostgreSQL's. Each table is made only when it is not there
 * (IF NOT EXISTS): MySQL commits each CREATE TABLE by itself, so a baseline stopped halfway is finished the next time
 * (jukecord_schema is made first, empty, and says the baseline is done only once every table is). The indexes are
 * part of each CREATE TABLE for the same reason (MySQL has no CREATE INDEX IF NOT EXISTS).
 */
export const MYSQL_BASELINE = `
  CREATE TABLE IF NOT EXISTS tracks (
    id          BIGINT NOT NULL AUTO_INCREMENT,
    source      TEXT NOT NULL,
    source_hash BINARY(32) GENERATED ALWAYS AS (UNHEX(SHA2(source, 256))) STORED,
    url         TEXT NOT NULL,
    title       TEXT NOT NULL,
    uploader    TEXT,
    duration_ms BIGINT,
    thumbnail   TEXT,
    loudness    DOUBLE,
    created_at  BIGINT NOT NULL,
    updated_at  BIGINT NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY tracks_source_hash (source_hash)
  ) ${MYSQL_TABLE};

  CREATE TABLE IF NOT EXISTS queue_items (
    id       BIGINT NOT NULL AUTO_INCREMENT,
    guild_id ${MY_WORD} NOT NULL,
    position BIGINT NOT NULL,
    track_id BIGINT NOT NULL,
    added_by ${MY_WORD},
    added_at BIGINT NOT NULL,
    PRIMARY KEY (id),
    KEY queue_items_by_guild (guild_id, position),
    CONSTRAINT queue_items_track FOREIGN KEY (track_id) REFERENCES tracks(id)
  ) ${MYSQL_TABLE};

  CREATE TABLE IF NOT EXISTS player_state (
    guild_id    ${MY_WORD} NOT NULL,
    track_id    BIGINT,
    added_by    ${MY_WORD},
    status      ${MY_WORD} NOT NULL,
    position_ms BIGINT NOT NULL DEFAULT 0,
    updated_at  BIGINT NOT NULL,
    "repeat"    ${MY_WORD} NOT NULL DEFAULT 'off',
    autoplay    ${MY_WORD} NOT NULL DEFAULT 'off',
    PRIMARY KEY (guild_id),
    CONSTRAINT player_state_track FOREIGN KEY (track_id) REFERENCES tracks(id)
  ) ${MYSQL_TABLE};

  CREATE TABLE IF NOT EXISTS history (
    id        BIGINT NOT NULL AUTO_INCREMENT,
    guild_id  ${MY_WORD} NOT NULL,
    track_id  BIGINT NOT NULL,
    added_by  ${MY_WORD},
    played_at BIGINT NOT NULL,
    played_ms BIGINT NOT NULL,
    PRIMARY KEY (id),
    KEY history_by_guild (guild_id, played_at DESC),
    KEY history_by_guild_id (guild_id, id),
    KEY history_by_guild_track (guild_id, track_id),
    CONSTRAINT history_track FOREIGN KEY (track_id) REFERENCES tracks(id)
  ) ${MYSQL_TABLE};

  CREATE TABLE IF NOT EXISTS playlists (
    id         BIGINT NOT NULL AUTO_INCREMENT,
    guild_id   ${MY_WORD} NOT NULL,
    name       ${MY_WORD} NOT NULL,
    created_by ${MY_WORD},
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY playlists_by_name (guild_id, name)
  ) ${MYSQL_TABLE};

  CREATE TABLE IF NOT EXISTS playlist_items (
    playlist_id BIGINT NOT NULL,
    position    BIGINT NOT NULL,
    track_id    BIGINT NOT NULL,
    PRIMARY KEY (playlist_id, position),
    CONSTRAINT playlist_items_playlist FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
    CONSTRAINT playlist_items_track FOREIGN KEY (track_id) REFERENCES tracks(id)
  ) ${MYSQL_TABLE};

  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id          ${MY_WORD} NOT NULL,
    dj_role_id        ${MY_WORD},
    updated_at        BIGINT NOT NULL,
    alerts_channel_id ${MY_WORD},
    vote_skip         BIGINT NOT NULL DEFAULT 1,
    take_turns        BIGINT NOT NULL DEFAULT 0,
    person_limit      BIGINT NOT NULL DEFAULT 0,
    stay              BIGINT NOT NULL DEFAULT 0,
    volume            BIGINT NOT NULL DEFAULT 100,
    sound             ${MY_WORD} NOT NULL DEFAULT 'off',
    PRIMARY KEY (guild_id)
  ) ${MYSQL_TABLE};

  CREATE TABLE IF NOT EXISTS discord_commands (
    guild_id   ${MY_WORD} NOT NULL,
    hash       ${MY_WORD} NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (guild_id)
  ) ${MYSQL_TABLE};

  CREATE TABLE IF NOT EXISTS users (
    id         ${MY_WORD} NOT NULL,
    name       TEXT NOT NULL,
    avatar     ${MY_WORD},
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (id)
  ) ${MYSQL_TABLE};

  CREATE TABLE IF NOT EXISTS sessions (
    id_hash    ${MY_WORD} NOT NULL,
    kind       ${MY_WORD} NOT NULL,
    user_id    ${MY_WORD},
    csrf       ${MY_WORD} NOT NULL,
    created_at BIGINT NOT NULL,
    seen_at    BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    scope      ${MY_WORD} NOT NULL DEFAULT 'admin',
    PRIMARY KEY (id_hash),
    KEY sessions_by_expiry (expires_at)
  ) ${MYSQL_TABLE};

  CREATE TABLE IF NOT EXISTS api_tokens (
    id         BIGINT NOT NULL AUTO_INCREMENT,
    hash       ${MY_WORD} NOT NULL,
    name       TEXT NOT NULL,
    kind       ${MY_WORD} NOT NULL,
    user_id    ${MY_WORD},
    scope      ${MY_WORD} NOT NULL,
    created_at BIGINT NOT NULL,
    used_at    BIGINT,
    PRIMARY KEY (id),
    UNIQUE KEY api_tokens_by_hash (hash)
  ) ${MYSQL_TABLE};

  CREATE TABLE IF NOT EXISTS voice_channels (
    guild_id   ${MY_WORD} NOT NULL,
    channel_id ${MY_WORD} NOT NULL,
    updated_at BIGINT NOT NULL,
    told_at    BIGINT,
    seq        BIGINT NOT NULL AUTO_INCREMENT,
    PRIMARY KEY (guild_id),
    UNIQUE KEY voice_channels_by_seq (seq)
  ) ${MYSQL_TABLE};

  CREATE TABLE IF NOT EXISTS lyrics (
    track_id   BIGINT NOT NULL,
    kind       ${MY_WORD} NOT NULL,
    synced     MEDIUMTEXT,
    plain      MEDIUMTEXT,
    source_id  BIGINT,
    fetched_at BIGINT NOT NULL,
    PRIMARY KEY (track_id),
    CONSTRAINT lyrics_track FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
  ) ${MYSQL_TABLE};

  CREATE TABLE IF NOT EXISTS track_music (
    track_id   BIGINT NOT NULL,
    artist     TEXT NOT NULL,
    title      TEXT NOT NULL,
    album      TEXT,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (track_id),
    CONSTRAINT track_music_track FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
  ) ${MYSQL_TABLE};

  CREATE TABLE IF NOT EXISTS listen_links (
    id         BIGINT NOT NULL AUTO_INCREMENT,
    hash       ${MY_WORD} NOT NULL,
    guild_id   ${MY_WORD} NOT NULL,
    created_by ${MY_WORD},
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    max_guests BIGINT NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY listen_links_by_hash (hash),
    KEY listen_links_by_guild (guild_id, expires_at)
  ) ${MYSQL_TABLE};

  CREATE TABLE IF NOT EXISTS guest_sessions (
    id_hash    ${MY_WORD} NOT NULL,
    link_id    BIGINT NOT NULL,
    csrf       ${MY_WORD} NOT NULL,
    created_at BIGINT NOT NULL,
    seen_at    BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    PRIMARY KEY (id_hash),
    KEY guest_sessions_by_link (link_id),
    CONSTRAINT guest_sessions_link FOREIGN KEY (link_id) REFERENCES listen_links(id) ON DELETE CASCADE
  ) ${MYSQL_TABLE};

  CREATE TABLE IF NOT EXISTS likes (
    owner      ${MY_WORD} NOT NULL,
    track_id   BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (owner, track_id),
    KEY likes_by_owner (owner, created_at DESC),
    KEY likes_by_track (track_id),
    CONSTRAINT likes_track FOREIGN KEY (track_id) REFERENCES tracks(id)
  ) ${MYSQL_TABLE};
`;

/** The one-row table that holds a server database's schema version (SQLite's is its user_version). */
export const VERSION_TABLE = 'jukecord_schema';

/** The version table, as each server makes it (before the baseline, so a baseline stopped halfway is seen as one). */
export const VERSION_TABLE_SQL: Readonly<Record<'postgres' | 'mysql', string>> = {
  postgres: `CREATE TABLE ${VERSION_TABLE} (version BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
  mysql: `CREATE TABLE IF NOT EXISTS ${VERSION_TABLE} (version BIGINT NOT NULL, updated_at BIGINT NOT NULL) ${MYSQL_TABLE}`,
};

/** A table of the schema as a copy reads and writes it (jukecord db copy, the backups of a server database). */
export interface Table {
  readonly name: string;
  /** Its columns, the same on every database (the servers' source_hash and seq are made by the database itself). */
  readonly columns: readonly string[];
  /** The columns that tell its rows apart (its primary key), which it is read in pages by. */
  readonly key: readonly string[];
  /** Whether its id is made by the database: on PostgreSQL the next one is set past the ids copied in. */
  readonly identity?: boolean;
  /**
   * Whether its rows keep the order they were first kept in, which it has no column for (SQLite's rowid, the servers'
   * seq): copied in that order, so the copy keeps it.
   */
  readonly ordered?: boolean;
}

/**
 * Every table of the schema at the latest version, in the order of their foreign keys (a table comes after the tables
 * it refers to): a copy writes them in this order and empties them in the opposite one.
 */
export const TABLES: readonly Table[] = [
  {
    name: 'tracks',
    columns: [
      'id',
      'source',
      'url',
      'title',
      'uploader',
      'duration_ms',
      'thumbnail',
      'loudness',
      'created_at',
      'updated_at',
    ],
    key: ['id'],
    identity: true,
  },
  {
    name: 'playlists',
    columns: ['id', 'guild_id', 'name', 'created_by', 'created_at', 'updated_at'],
    key: ['id'],
    identity: true,
  },
  {
    name: 'listen_links',
    columns: ['id', 'hash', 'guild_id', 'created_by', 'created_at', 'expires_at', 'max_guests'],
    key: ['id'],
    identity: true,
  },
  {
    name: 'queue_items',
    columns: ['id', 'guild_id', 'position', 'track_id', 'added_by', 'added_at'],
    key: ['id'],
    identity: true,
  },
  {
    name: 'player_state',
    columns: ['guild_id', 'track_id', 'added_by', 'status', 'position_ms', 'updated_at', 'repeat', 'autoplay'],
    key: ['guild_id'],
  },
  {
    name: 'history',
    columns: ['id', 'guild_id', 'track_id', 'added_by', 'played_at', 'played_ms'],
    key: ['id'],
    identity: true,
  },
  { name: 'playlist_items', columns: ['playlist_id', 'position', 'track_id'], key: ['playlist_id', 'position'] },
  {
    name: 'guild_settings',
    columns: [
      'guild_id',
      'dj_role_id',
      'updated_at',
      'alerts_channel_id',
      'vote_skip',
      'take_turns',
      'person_limit',
      'stay',
      'volume',
      'sound',
    ],
    key: ['guild_id'],
  },
  { name: 'discord_commands', columns: ['guild_id', 'hash', 'updated_at'], key: ['guild_id'] },
  { name: 'users', columns: ['id', 'name', 'avatar', 'updated_at'], key: ['id'] },
  {
    name: 'sessions',
    columns: ['id_hash', 'kind', 'user_id', 'csrf', 'created_at', 'seen_at', 'expires_at', 'scope'],
    key: ['id_hash'],
  },
  {
    name: 'api_tokens',
    columns: ['id', 'hash', 'name', 'kind', 'user_id', 'scope', 'created_at', 'used_at'],
    key: ['id'],
    identity: true,
  },
  {
    name: 'voice_channels',
    columns: ['guild_id', 'channel_id', 'updated_at', 'told_at'],
    key: ['guild_id'],
    ordered: true,
  },
  {
    name: 'lyrics',
    columns: ['track_id', 'kind', 'synced', 'plain', 'source_id', 'fetched_at'],
    key: ['track_id'],
  },
  { name: 'track_music', columns: ['track_id', 'artist', 'title', 'album', 'updated_at'], key: ['track_id'] },
  {
    name: 'guest_sessions',
    columns: ['id_hash', 'link_id', 'csrf', 'created_at', 'seen_at', 'expires_at'],
    key: ['id_hash'],
  },
  { name: 'likes', columns: ['owner', 'track_id', 'created_at'], key: ['owner', 'track_id'] },
  // The host's saved settings: copied with the data, so a move to another database keeps them.
  { name: 'host_settings', columns: ['name', 'value', 'revision', 'updated_at'], key: ['name'] },
];
