import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { MIGRATIONS } from '../../src/store/schema.ts';
import { Store } from '../../src/store/store.ts';
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
