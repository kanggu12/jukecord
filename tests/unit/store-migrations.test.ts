import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { MIGRATIONS } from '../../src/store/schema.ts';
import { COMMUNITY_DEFAULTS, Store } from '../../src/store/store.ts';
import { addTracks, memoryStore } from '../support/store.ts';

const GUILD = '100000000000000001';

describe('migrations', () => {
  it('brings a database made by version 1 of the schema up to date, keeping its data', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-migrate-'));
    try {
      const file = path.join(dir, 'jukecord.db');
      // A database exactly as the first schema left it, with a saved player state in it.
      const old = new DatabaseSync(file);
      old.exec(MIGRATIONS[0]?.sql ?? '');
      old.exec('PRAGMA user_version = 1');
      old
        .prepare("INSERT INTO tracks (source, url, title, created_at, updated_at) VALUES ('s', 'u', 'Old track', 1, 1)")
        .run();
      old
        .prepare(
          "INSERT INTO player_state (guild_id, track_id, status, position_ms, updated_at) VALUES (?, 1, 'paused', 5000, 1)",
        )
        .run(GUILD);
      old.close();
      const store = Store.open(file);
      assert.equal(store.schemaVersion(), MIGRATIONS.at(-1)?.version);
      // The new column has its default for rows written before it existed.
      assert.equal(store.playerState.load(GUILD)?.repeat, 'off');
      assert.equal(store.tracks.get(1)?.title, 'Old track');
      store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('an upgrade from the last release', () => {
  it('brings a database as 0.2.1 left it (schema 3), with rows in every table, to this schema, all of them read', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-migrate-'));
    try {
      const file = path.join(dir, 'jukecord.db');
      const ALICE = '300000000000000001';
      // The released schema (its migrations are never edited) and a row in each of its tables, as people's
      // databases have them: a queue, a track playing on repeat, history, a playlist, a DJ role, the commands'
      // fingerprint, a person met, a host login and a Discord login, and a token.
      const old = new DatabaseSync(file);
      for (const migration of MIGRATIONS.filter((entry) => entry.version <= 3)) old.exec(migration.sql);
      old.exec('PRAGMA user_version = 3');
      old.exec(`
        INSERT INTO tracks (source, url, title, created_at, updated_at) VALUES
          ('youtube:a', 'https://example.com/a', 'Track a', 1, 1), ('youtube:b', 'https://example.com/b', 'Track b', 1, 1);
        INSERT INTO queue_items (guild_id, position, track_id, added_by, added_at) VALUES ('${GUILD}', 0, 2, '${ALICE}', 2);
        INSERT INTO player_state (guild_id, track_id, added_by, status, position_ms, updated_at, repeat)
          VALUES ('${GUILD}', 1, NULL, 'playing', 5000, 3, 'queue');
        INSERT INTO history (guild_id, track_id, added_by, played_at, played_ms) VALUES ('${GUILD}', 2, '${ALICE}', 4, 1000);
        INSERT INTO playlists (guild_id, name, created_by, created_at, updated_at) VALUES ('${GUILD}', 'Mix', NULL, 5, 5);
        INSERT INTO playlist_items (playlist_id, position, track_id) VALUES (1, 0, 1), (1, 1, 2);
        INSERT INTO guild_settings (guild_id, dj_role_id, updated_at) VALUES ('${GUILD}', '500000000000000001', 6);
        INSERT INTO discord_commands (guild_id, hash, updated_at) VALUES ('${GUILD}', 'abc', 7);
        INSERT INTO users (id, name, avatar, updated_at) VALUES ('${ALICE}', 'Alice', NULL, 8);
        INSERT INTO sessions (id_hash, kind, user_id, csrf, created_at, seen_at, expires_at) VALUES
          ('host-hash', 'host', NULL, 'c1', 9, 9, 9999999999999), ('alice-hash', 'user', '${ALICE}', 'c2', 9, 9, 9999999999999);
        INSERT INTO api_tokens (hash, name, kind, user_id, scope, created_at) VALUES ('token-hash', 'laptop', 'host', NULL, 'control', 10);
      `);
      old.close();
      const store = Store.open(file);
      try {
        assert.equal(store.schemaVersion(), MIGRATIONS.at(-1)?.version);
        assert.deepEqual(
          store.queue.list(GUILD).map((item) => [item.track.title, item.addedBy]),
          [['Track b', ALICE]],
        );
        // The player comes back on its track and repeat, with autoplay (new) off.
        const player = store.playerState.load(GUILD);
        assert.deepEqual(
          [player?.trackId, player?.status, player?.positionMs, player?.repeat, player?.autoplay],
          [1, 'playing', 5000, 'queue', 'off'],
        );
        assert.deepEqual(
          store.history.list(GUILD).map((entry) => entry.track.title),
          ['Track b'],
        );
        const mix = store.playlists.find(GUILD, 'Mix');
        assert.deepEqual(
          store.playlists.tracks(mix?.id ?? 0).map((track) => track.title),
          ['Track a', 'Track b'],
        );
        // The DJ role stays; the settings added since are at the defaults of a server that never chose.
        assert.deepEqual(store.settings.get(GUILD), { djRoleId: '500000000000000001', alertsChannelId: null });
        assert.deepEqual(store.settings.community(GUILD), COMMUNITY_DEFAULTS);
        assert.equal(store.discord.commandsHash(GUILD), 'abc');
        assert.equal(store.users.get(ALICE)?.name, 'Alice');
        // Logins from before friends' scopes still log in with all their login may (admin), as they did.
        assert.deepEqual(
          [store.sessions.get('host-hash')?.kind, store.sessions.get('host-hash')?.scope],
          ['host', 'admin'],
        );
        assert.deepEqual(
          [store.sessions.get('alice-hash')?.userId, store.sessions.get('alice-hash')?.scope],
          [ALICE, 'admin'],
        );
        assert.equal(store.tokens.byHash('token-hash')?.scope, 'control');
        // The tables added since start empty, and take rows.
        assert.equal(store.likes.count('host'), 0);
        assert.deepEqual(store.listenLinks.list(GUILD), []);
        assert.deepEqual(store.voiceChannels.all(), []);
        assert.equal(store.lyrics.get(1), null);
        assert.equal(store.likes.add('host', 1), true);
        assert.equal(store.history.has(GUILD, 2), true);
        // The database passes SQLite's own check after the upgrade, its foreign keys included.
        assert.equal((store.db.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check, 'ok');
        assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
      } finally {
        store.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('history pruning', () => {
  it("keeps a server's newest entries and leaves other servers alone", () => {
    const store = memoryStore();
    const [track] = addTracks(store, 1);
    assert.ok(track);
    for (let i = 0; i < 30; i += 1)
      store.history.add({ guildId: GUILD, trackId: track.id, addedBy: null, playedAt: i, playedMs: 2000 });
    store.history.add({ guildId: 'other', trackId: track.id, addedBy: null, playedAt: 1, playedMs: 2000 });
    assert.equal(store.history.prune(GUILD, 10), 20);
    const left = store.history.list(GUILD, 100);
    assert.equal(left.length, 10);
    // The newest ten stay.
    assert.equal(left.at(-1)?.playedAt, 20);
    assert.equal(store.history.list('other', 100).length, 1);
  });
});

describe('DiscordRepository', () => {
  it('remembers the fingerprint of the commands registered in each server', () => {
    const store = memoryStore();
    assert.equal(store.discord.commandsHash(GUILD), null);
    store.discord.setCommandsHash(GUILD, 'abc');
    store.discord.setCommandsHash(GUILD, 'def');
    assert.equal(store.discord.commandsHash(GUILD), 'def');
  });
});

describe('the voice channel kept for a restart, and the alerts channel', () => {
  it('brings a database of the last release (schema 3) up to date, with no channel kept and no alerts channel', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-migrate-'));
    try {
      const file = path.join(dir, 'jukecord.db');
      // The schema as 0.2.1 left it, with a DJ role set: the settings row from before has no alerts channel.
      const old = new DatabaseSync(file);
      for (const migration of MIGRATIONS.filter((entry) => entry.version <= 3)) old.exec(migration.sql);
      old.exec('PRAGMA user_version = 3');
      old.prepare("INSERT INTO guild_settings (guild_id, dj_role_id, updated_at) VALUES (?, '5', 1)").run(GUILD);
      old.close();
      const store = Store.open(file);
      assert.deepEqual(store.settings.get(GUILD), { djRoleId: '5', alertsChannelId: null });
      assert.deepEqual(store.voiceChannels.all(), []);
      store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps one voice channel per server, replaced by the next and forgotten on request', () => {
    const store = memoryStore();
    store.voiceChannels.remember(GUILD, '400000000000000001');
    store.voiceChannels.remember(GUILD, '400000000000000002');
    store.voiceChannels.remember('100000000000000002', '400000000000000009');
    assert.deepEqual(store.voiceChannels.all(), [
      { guildId: GUILD, channelId: '400000000000000002' },
      { guildId: '100000000000000002', channelId: '400000000000000009' },
    ]);
    store.voiceChannels.forget(GUILD);
    assert.deepEqual(store.voiceChannels.all(), [{ guildId: '100000000000000002', channelId: '400000000000000009' }]);
    // The alerts channel is a setting beside the DJ role, each changed alone.
    store.settings.setDjRole(GUILD, '5');
    store.settings.setAlertsChannel(GUILD, '600000000000000001');
    assert.deepEqual(store.settings.get(GUILD), { djRoleId: '5', alertsChannelId: '600000000000000001' });
    store.settings.setDjRole(GUILD, null);
    assert.deepEqual(store.settings.get(GUILD), { djRoleId: null, alertsChannelId: '600000000000000001' });
  });
});

describe('the community settings', () => {
  it('comes to a database from before them with every server at the defaults, its DJ role kept', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-migrate-'));
    try {
      const file = path.join(dir, 'jukecord.db');
      // Every migration before the one that adds them, found by what it adds (its number changes when branches merge).
      const mine = MIGRATIONS.findIndex((migration) => migration.sql.includes('vote_skip'));
      assert.ok(mine > 0);
      const old = new DatabaseSync(file);
      for (const migration of MIGRATIONS.slice(0, mine)) old.exec(migration.sql);
      old.exec(`PRAGMA user_version = ${MIGRATIONS[mine - 1]?.version}`);
      old
        .prepare("INSERT INTO guild_settings (guild_id, dj_role_id, updated_at) VALUES (?, '500000000000000001', 1)")
        .run(GUILD);
      old.close();
      const store = Store.open(file);
      assert.equal(store.settings.get(GUILD).djRoleId, '500000000000000001');
      assert.deepEqual(store.settings.community(GUILD), COMMUNITY_DEFAULTS);
      store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('changes only what it is given, for one server, and keeps the DJ role', () => {
    const store = memoryStore();
    // A server never configured reads as the defaults, without a row.
    assert.deepEqual(store.settings.community(GUILD), COMMUNITY_DEFAULTS);
    store.settings.setCommunity(GUILD, { takeTurns: true, personLimit: 3 });
    store.settings.setDjRole(GUILD, '500000000000000001');
    store.settings.setCommunity(GUILD, { volume: 150, sound: 'bass', voteSkip: false, stay: true });
    assert.deepEqual(store.settings.community(GUILD), {
      voteSkip: false,
      takeTurns: true,
      personLimit: 3,
      stay: true,
      volume: 150,
      sound: 'bass',
    });
    assert.equal(store.settings.get(GUILD).djRoleId, '500000000000000001');
    // Nothing given changes nothing; another server keeps its defaults.
    store.settings.setCommunity(GUILD, {});
    assert.equal(store.settings.community(GUILD).volume, 150);
    assert.deepEqual(store.settings.community('other'), COMMUNITY_DEFAULTS);
  });

  it('reads a preset this version does not know as the plain sound', () => {
    const store = memoryStore();
    store.settings.setCommunity(GUILD, { volume: 80 });
    store.db.prepare("UPDATE guild_settings SET sound = 'nightcore' WHERE guild_id = ?").run(GUILD);
    assert.equal(store.settings.community(GUILD).sound, 'off');
  });
});
