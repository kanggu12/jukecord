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
