import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { MIGRATIONS } from '../../src/store/schema.ts';
import { Store, StoreError } from '../../src/store/store.ts';
import { addTracks, memoryStore } from '../support/store.ts';

const GUILD = '100000000000000001';
const OTHER = '100000000000000002';

describe('Store', () => {
  it('creates the schema at the latest version and keeps it on reopening', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-db-'));
    try {
      const file = path.join(dir, 'sub', 'jukecord.db');
      const store = Store.open(file);
      assert.equal(store.schemaVersion(), MIGRATIONS.at(-1)?.version);
      addTracks(store, 1);
      store.close();
      // Reopening runs no migration again and keeps the data.
      const again = Store.open(file);
      assert.equal(again.tracks.get(1)?.title, 'Track 1');
      again.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a database written by a newer jukecord', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-db-'));
    try {
      const file = path.join(dir, 'jukecord.db');
      const db = new DatabaseSync(file);
      db.exec('PRAGMA user_version = 999');
      db.close();
      assert.throws(() => Store.open(file), /newer than this jukecord knows/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rolls back a failed transaction, and only the inner level of a nested one', () => {
    const store = memoryStore();
    const [track] = addTracks(store, 1);
    assert.ok(track);
    assert.throws(() =>
      store.transaction(() => {
        store.queue.insert(GUILD, [track.id], 0, null);
        throw new Error('boom');
      }),
    );
    assert.equal(store.queue.count(GUILD), 0);
    store.transaction(() => {
      store.queue.insert(GUILD, [track.id], 0, null);
      assert.throws(() =>
        store.transaction(() => {
          store.queue.insert(GUILD, [track.id], 0, null);
          throw new Error('inner');
        }),
      );
    });
    // The outer insert stays; the inner one is gone.
    assert.equal(store.queue.count(GUILD), 1);
  });

  it('writes an online backup that opens with the same data', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-db-'));
    try {
      const store = Store.open(path.join(dir, 'jukecord.db'));
      addTracks(store, 3);
      const target = path.join(dir, 'backup', 'copy.db');
      store.backup(target);
      assert.throws(() => store.backup(target), StoreError);
      const copy = Store.open(target);
      assert.equal(copy.tracks.get(3)?.title, 'Track 3');
      copy.close();
      store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('TrackRepository', () => {
  it('keeps one row per source and keeps known fields that a later lookup lacks', () => {
    const store = memoryStore();
    const first = store.tracks.upsert({
      source: 'https://example.com/a',
      url: 'https://example.com/a',
      title: 'Old title',
      uploader: 'Someone',
      durationMs: 1000,
      thumbnail: 'https://example.com/a.jpg',
    });
    const second = store.tracks.upsert({
      source: 'https://example.com/a',
      url: 'https://example.com/a',
      title: 'New title',
      uploader: null,
      durationMs: null,
      thumbnail: null,
    });
    assert.equal(second.id, first.id);
    assert.equal(second.title, 'New title');
    assert.equal(second.uploader, 'Someone');
    assert.equal(second.thumbnail, 'https://example.com/a.jpg');
    store.tracks.setLoudness(first.id, -14.2);
    assert.equal(store.tracks.bySource('https://example.com/a')?.loudness, -14.2);
  });
});

describe('QueueRepository', () => {
  it('inserts at the end, next, or a position, keeping positions dense', () => {
    const store = memoryStore();
    const [a, b, c, d] = addTracks(store, 4);
    assert.ok(a && b && c && d);
    store.queue.insert(GUILD, [a.id, b.id], Number.MAX_SAFE_INTEGER, 'u1');
    store.queue.insert(GUILD, [c.id], 0, 'u2');
    store.queue.insert(GUILD, [d.id], 2, null);
    const list = store.queue.list(GUILD);
    assert.deepEqual(
      list.map((item) => item.track.title),
      ['Track 3', 'Track 1', 'Track 4', 'Track 2'],
    );
    assert.deepEqual(
      list.map((item) => item.position),
      [0, 1, 2, 3],
    );
    // Another server's queue is separate.
    assert.equal(store.queue.count(OTHER), 0);
  });

  it('removes, moves, reorders, shifts and clears', () => {
    const store = memoryStore();
    const tracks = addTracks(store, 4);
    const items = store.queue.insert(
      GUILD,
      tracks.map((track) => track.id),
      0,
      null,
    );
    const [i1, i2, i3, i4] = items;
    assert.ok(i1 && i2 && i3 && i4);
    assert.equal(store.queue.remove(GUILD, i2.id), true);
    assert.equal(store.queue.remove(GUILD, i2.id), false);
    // A removal from another server's queue does nothing.
    assert.equal(store.queue.remove(OTHER, i3.id), false);
    store.queue.move(GUILD, i4.id, 0);
    assert.deepEqual(
      store.queue.list(GUILD).map((item) => item.id),
      [i4.id, i1.id, i3.id],
    );
    assert.throws(() => store.queue.move(GUILD, i4.id, 5), StoreError);
    store.queue.reorder(GUILD, [i3.id, i1.id, i4.id]);
    assert.deepEqual(
      store.queue.list(GUILD).map((item) => item.id),
      [i3.id, i1.id, i4.id],
    );
    // An order that drops or invents an item means the caller is out of date.
    assert.throws(() => store.queue.reorder(GUILD, [i3.id, i1.id]), StoreError);
    assert.equal(store.queue.shift(GUILD)?.id, i3.id);
    assert.deepEqual(
      store.queue.list(GUILD).map((item) => item.position),
      [0, 1],
    );
    assert.equal(store.queue.clear(GUILD), 2);
    assert.equal(store.queue.shift(GUILD), null);
  });
});

describe('HistoryRepository', () => {
  it('lists newest first and pages back', () => {
    const store = memoryStore();
    const [a, b, c] = addTracks(store, 3);
    assert.ok(a && b && c);
    store.history.add({ guildId: GUILD, trackId: a.id, addedBy: null, playedAt: 1000, playedMs: 5000 });
    store.history.add({ guildId: GUILD, trackId: b.id, addedBy: 'u1', playedAt: 2000, playedMs: 6000 });
    const newest = store.history.add({ guildId: GUILD, trackId: c.id, addedBy: null, playedAt: 3000, playedMs: 7000 });
    const page = store.history.list(GUILD, 2);
    assert.deepEqual(
      page.map((entry) => entry.track.title),
      ['Track 3', 'Track 2'],
    );
    const older = store.history.list(GUILD, 2, page.at(-1)?.id);
    assert.deepEqual(
      older.map((entry) => entry.track.title),
      ['Track 1'],
    );
    assert.equal(newest.playedMs, 7000);
  });
});

describe('PlaylistRepository', () => {
  it('saves, replaces, finds, renames and deletes', () => {
    const store = memoryStore();
    const [a, b, c] = addTracks(store, 3);
    assert.ok(a && b && c);
    const saved = store.playlists.save(GUILD, '  Evening  ', [a.id, b.id], 'u1');
    assert.equal(saved.name, 'Evening');
    assert.equal(saved.size, 2);
    // Saving under the same name replaces the tracks.
    const replaced = store.playlists.save(GUILD, 'Evening', [c.id], 'u1');
    assert.equal(replaced.id, saved.id);
    assert.deepEqual(
      store.playlists.tracks(saved.id).map((track) => track.title),
      ['Track 3'],
    );
    store.playlists.save(GUILD, 'Morning', [a.id], null);
    assert.throws(() => store.playlists.rename(saved.id, 'Morning'), /exists/);
    assert.equal(store.playlists.rename(saved.id, 'Night').name, 'Night');
    assert.equal(store.playlists.find(GUILD, 'Night')?.id, saved.id);
    assert.equal(store.playlists.remove(saved.id), true);
    assert.equal(store.playlists.find(GUILD, 'Night'), null);
    assert.throws(() => store.playlists.save(GUILD, '   ', [a.id], null), StoreError);
  });
});

describe('PlayerStateRepository and SettingsRepository', () => {
  it('saves and loads the current track of each server', () => {
    const store = memoryStore();
    const [a] = addTracks(store, 1);
    assert.ok(a);
    store.playerState.save({
      guildId: GUILD,
      trackId: a.id,
      addedBy: 'u1',
      status: 'playing',
      positionMs: 1234.6,
      repeat: 'off',
    });
    assert.deepEqual(store.playerState.load(GUILD), {
      guildId: GUILD,
      trackId: a.id,
      addedBy: 'u1',
      status: 'playing',
      positionMs: 1235,
      repeat: 'off',
      updatedAt: Date.UTC(2026, 10, 11),
    });
    assert.equal(store.playerState.all().length, 1);
    assert.equal(store.playerState.load(OTHER), null);
  });

  it('defaults to no DJ role and remembers one when set', () => {
    const store = memoryStore();
    assert.deepEqual(store.settings.get(GUILD), { djRoleId: null });
    store.settings.setDjRole(GUILD, '200000000000000001');
    assert.deepEqual(store.settings.get(GUILD), { djRoleId: '200000000000000001' });
    store.settings.setDjRole(GUILD, null);
    assert.deepEqual(store.settings.get(GUILD), { djRoleId: null });
  });
});
