/**
 * The questions the cover route asks of the database: whether a server's history or one of its playlists has a track,
 * each answered from an index (the history's is a migration of its own; the test names it, not its number, which
 * may change when branches are merged).
 */
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

describe("a server's tracks in its history and playlists", () => {
  it('says whether a server played or saved a track, each server for itself', () => {
    const store = memoryStore();
    const [played, saved, neither] = addTracks(store, 3);
    assert.ok(played && saved && neither);
    store.history.add({ guildId: GUILD, trackId: played.id, addedBy: null, playedAt: 1, playedMs: 5000 });
    store.playlists.save(GUILD, 'Later', [saved.id], null);
    assert.equal(store.history.has(GUILD, played.id), true);
    assert.equal(store.history.has(GUILD, saved.id), false);
    assert.equal(store.history.has('other', played.id), false);
    assert.equal(store.playlists.has(GUILD, saved.id), true);
    assert.equal(store.playlists.has(GUILD, neither.id), false);
    assert.equal(store.playlists.has('other', saved.id), false);
  });

  it("asks the history through its index on the server and the track, not by walking the server's plays", () => {
    const store = memoryStore();
    const plan = store.db
      .prepare('EXPLAIN QUERY PLAN SELECT 1 AS found FROM history WHERE guild_id = ? AND track_id = ? LIMIT 1')
      .all(GUILD, 1)
      .map((row) => String((row as { detail: string }).detail))
      .join(' ');
    assert.match(plan, /USING COVERING INDEX history_by_guild_track/);
  });

  it('adds the index to a database made before it, keeping its history', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-index-'));
    try {
      const file = path.join(dir, 'jukecord.db');
      // A database as the migrations before the index left it, with a play in it (by its place in the list, not its
      // number: later migrations come after it).
      const at = MIGRATIONS.findIndex((migration) => migration.sql.includes('history_by_guild_track'));
      const before = MIGRATIONS.slice(0, at);
      const old = new DatabaseSync(file);
      for (const migration of before) old.exec(migration.sql);
      old.exec(`PRAGMA user_version = ${before.at(-1)?.version ?? 0}`);
      old
        .prepare("INSERT INTO tracks (source, url, title, created_at, updated_at) VALUES ('s', 'u', 'Old track', 1, 1)")
        .run();
      old.prepare('INSERT INTO history (guild_id, track_id, played_at, played_ms) VALUES (?, 1, 1, 5000)').run(GUILD);
      old.close();
      const store = Store.open(file);
      const index = store.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'history_by_guild_track'")
        .get();
      assert.ok(index);
      assert.equal(store.history.has(GUILD, 1), true);
      store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
