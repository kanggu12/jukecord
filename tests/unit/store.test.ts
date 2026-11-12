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

  it('keeps positions 0..n-1 after a removal and a shift from the middle of a long queue, and says what it holds', () => {
    const store = memoryStore();
    const tracks = addTracks(store, 6);
    const items = store.queue.insert(
      GUILD,
      tracks.map((track) => track.id),
      0,
      null,
    );
    // The same tracks in another server: a removal or a shift here must not move them.
    store.queue.insert(
      OTHER,
      tracks.map((track) => track.id),
      0,
      null,
    );
    assert.equal(store.queue.remove(GUILD, items[2]?.id ?? 0), true);
    assert.equal(store.queue.shift(GUILD)?.id, items[0]?.id);
    const left = store.queue.list(GUILD);
    assert.deepEqual(
      left.map((item) => [item.id, item.position]),
      [items[1], items[3], items[4], items[5]].map((item, index) => [item?.id, index]),
    );
    assert.deepEqual(
      store.queue.list(OTHER).map((item) => item.position),
      [0, 1, 2, 3, 4, 5],
    );
    // has() answers from the index, for the track played or removed and for one still waiting.
    assert.equal(store.queue.has(GUILD, tracks[0]?.id ?? 0), false);
    assert.equal(store.queue.has(GUILD, tracks[3]?.id ?? 0), true);
    assert.equal(store.queue.has(OTHER, tracks[0]?.id ?? 0), true);
  });

  it('removes many items in one go, closing every gap once, and counts only those that were there', () => {
    const store = memoryStore();
    const tracks = addTracks(store, 5);
    const items = store.queue.insert(
      GUILD,
      tracks.map((track) => track.id),
      0,
      null,
    );
    const [i1, i2, i3, i4, i5] = items;
    assert.ok(i1 && i2 && i3 && i4 && i5);
    // An ID that is not in the queue (played meanwhile) is no error; it is just not counted.
    assert.equal(store.queue.removeMany(GUILD, [i2.id, i4.id, 999_999]), 2);
    assert.deepEqual(
      store.queue.list(GUILD).map((item) => [item.id, item.position]),
      [
        [i1.id, 0],
        [i3.id, 1],
        [i5.id, 2],
      ],
    );
    // Another server's items are not touched, and an empty list writes nothing.
    assert.equal(store.queue.removeMany(OTHER, [i1.id]), 0);
    assert.equal(store.queue.removeMany(GUILD, []), 0);
    assert.equal(store.queue.count(GUILD), 3);
  });
});

describe('HistoryRepository', () => {
  it('pages by the order entries were written in, even when the clock went back between two plays', () => {
    const store = memoryStore();
    const [a, b, c] = addTracks(store, 3);
    assert.ok(a && b && c);
    // The second entry says it started earlier than the first (the clock was set back): by ID it is still newer, so
    // every entry is on exactly one page.
    store.history.add({ guildId: GUILD, trackId: a.id, addedBy: null, playedAt: 5000, playedMs: 5000 });
    store.history.add({ guildId: GUILD, trackId: b.id, addedBy: null, playedAt: 1000, playedMs: 5000 });
    store.history.add({ guildId: GUILD, trackId: c.id, addedBy: null, playedAt: 9000, playedMs: 5000 });
    const first = store.history.list(GUILD, 2);
    const second = store.history.list(GUILD, 2, first.at(-1)?.id);
    assert.deepEqual(
      [...first, ...second].map((entry) => entry.track.title),
      ['Track 3', 'Track 2', 'Track 1'],
    );
  });

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
    assert.deepEqual(store.settings.get(GUILD), { djRoleId: null, alertsChannelId: null });
    store.settings.setDjRole(GUILD, '200000000000000001');
    assert.deepEqual(store.settings.get(GUILD), { djRoleId: '200000000000000001', alertsChannelId: null });
    store.settings.setDjRole(GUILD, null);
    assert.deepEqual(store.settings.get(GUILD), { djRoleId: null, alertsChannelId: null });
  });
});

describe('Store.open and file modes', () => {
  it("makes a database copied in with a looser mode this user's alone", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-mode-'));
    try {
      const file = path.join(dir, 'jukecord.db');
      Store.open(file).close();
      fs.chmodSync(file, 0o644);
      const store = Store.open(file);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Store.transaction when the commit fails', () => {
  it('reports the commit error, rolls back, and leaves the next transaction working', () => {
    const store = memoryStore();
    const db = (store as unknown as { db: { exec(sql: string): void; isTransaction: boolean } }).db;
    // A COMMIT that fails once, as a full disk does in WAL mode.
    const exec = db.exec.bind(db);
    let failNext = true;
    db.exec = (sql: string) => {
      if (sql === 'COMMIT' && failNext) {
        failNext = false;
        throw new Error('database or disk is full');
      }
      exec(sql);
    };
    assert.throws(
      () =>
        store.transaction(() =>
          store.tracks.upsert({
            source: 'https://example.com/a',
            url: 'https://example.com/a',
            title: 'A',
            uploader: null,
            durationMs: 1000,
            thumbnail: null,
          }),
        ),
      /disk is full/,
    );
    assert.equal(db.isTransaction, false);
    // The next transaction (and a nested one inside it) works as before.
    const track = store.transaction(() =>
      store.transaction(() =>
        store.tracks.upsert({
          source: 'https://example.com/b',
          url: 'https://example.com/b',
          title: 'B',
          uploader: null,
          durationMs: 1000,
          thumbnail: null,
        }),
      ),
    );
    assert.equal(track.title, 'B');
    assert.equal(store.tracks.bySource('https://example.com/a'), null);
  });
});
