import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { MIGRATIONS, VERSION_TABLE } from '../../src/store/schema.ts';
import { Store, StoreError } from '../../src/store/store.ts';
import { eachDatabase } from '../support/databases.ts';
import { addTracks, memoryStore } from '../support/store.ts';

const GUILD = '100000000000000001';
const OTHER = '100000000000000002';

eachDatabase('Store', (db) => {
  it('creates the schema at the latest version and keeps it on reopening', async () => {
    const store = await db.open();
    assert.equal(await store.schemaVersion(), MIGRATIONS.at(-1)?.version);
    await addTracks(store, 1);
    await store.close();
    // Reopening runs no migration again and keeps the data.
    const again = await db.open();
    assert.equal(await again.schemaVersion(), MIGRATIONS.at(-1)?.version);
    assert.equal((await again.tracks.get(1))?.title, 'Track 1');
  });

  it('refuses a database written by a newer jukecord', async () => {
    const store = await db.open();
    // The version a newer jukecord would have left: SQLite's user_version, a server's version table.
    if (db.kind === 'sqlite') await store.sql.exec('PRAGMA user_version = 999');
    else await store.sql.run(`UPDATE ${VERSION_TABLE} SET version = 999`);
    await store.close();
    await assert.rejects(() => db.open(), /newer than this jukecord knows/);
  });

  it('rolls back a failed transaction, and only the inner level of a nested one', async () => {
    const store = await db.open();
    const [track] = await addTracks(store, 1);
    assert.ok(track);
    await assert.rejects(() =>
      store.transaction(async () => {
        await store.queue.insert(GUILD, [track.id], 0, null);
        throw new Error('boom');
      }),
    );
    assert.equal(await store.queue.count(GUILD), 0);
    await store.transaction(async () => {
      await store.queue.insert(GUILD, [track.id], 0, null);
      await assert.rejects(() =>
        store.transaction(async () => {
          await store.queue.insert(GUILD, [track.id], 0, null);
          throw new Error('inner');
        }),
      );
    });
    // The outer insert stays; the inner one is gone.
    assert.equal(await store.queue.count(GUILD), 1);
  });
});

describe('Store on SQLite', () => {
  it('writes an online backup that opens with the same data', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-db-'));
    try {
      const store = await Store.open(path.join(dir, 'jukecord.db'));
      await addTracks(store, 3);
      const target = path.join(dir, 'backup', 'copy.db');
      await store.backup(target);
      await assert.rejects(() => store.backup(target), StoreError);
      const copy = await Store.open(target);
      assert.equal((await copy.tracks.get(3))?.title, 'Track 3');
      await copy.close();
      await store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

eachDatabase('TrackRepository', (db) => {
  it('keeps one row per source and keeps known fields that a later lookup lacks', async () => {
    const store = await db.open();
    const first = await store.tracks.upsert({
      source: 'https://example.com/a',
      url: 'https://example.com/a',
      title: 'Old title',
      uploader: 'Someone',
      durationMs: 1000,
      thumbnail: 'https://example.com/a.jpg',
    });
    const second = await store.tracks.upsert({
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
    await store.tracks.setLoudness(first.id, -14.2);
    assert.equal((await store.tracks.bySource('https://example.com/a'))?.loudness, -14.2);
  });
});

eachDatabase('QueueRepository', (db) => {
  it('inserts at the end, next, or a position, keeping positions dense', async () => {
    const store = await db.open();
    const [a, b, c, d] = await addTracks(store, 4);
    assert.ok(a && b && c && d);
    await store.queue.insert(GUILD, [a.id, b.id], Number.MAX_SAFE_INTEGER, 'u1');
    await store.queue.insert(GUILD, [c.id], 0, 'u2');
    await store.queue.insert(GUILD, [d.id], 2, null);
    const list = await store.queue.list(GUILD);
    assert.deepEqual(
      list.map((item) => item.track.title),
      ['Track 3', 'Track 1', 'Track 4', 'Track 2'],
    );
    assert.deepEqual(
      list.map((item) => item.position),
      [0, 1, 2, 3],
    );
    // Another server's queue is separate.
    assert.equal(await store.queue.count(OTHER), 0);
  });

  it('removes, moves, reorders, shifts and clears', async () => {
    const store = await db.open();
    const tracks = await addTracks(store, 4);
    const items = await store.queue.insert(
      GUILD,
      tracks.map((track) => track.id),
      0,
      null,
    );
    const [i1, i2, i3, i4] = items;
    assert.ok(i1 && i2 && i3 && i4);
    assert.equal(await store.queue.remove(GUILD, i2.id), true);
    assert.equal(await store.queue.remove(GUILD, i2.id), false);
    // A removal from another server's queue does nothing.
    assert.equal(await store.queue.remove(OTHER, i3.id), false);
    await store.queue.move(GUILD, i4.id, 0);
    assert.deepEqual(
      (await store.queue.list(GUILD)).map((item) => item.id),
      [i4.id, i1.id, i3.id],
    );
    await assert.rejects(() => store.queue.move(GUILD, i4.id, 5), StoreError);
    await store.queue.reorder(GUILD, [i3.id, i1.id, i4.id]);
    assert.deepEqual(
      (await store.queue.list(GUILD)).map((item) => item.id),
      [i3.id, i1.id, i4.id],
    );
    // An order that drops or invents an item means the caller is out of date.
    await assert.rejects(() => store.queue.reorder(GUILD, [i3.id, i1.id]), StoreError);
    assert.equal((await store.queue.shift(GUILD))?.id, i3.id);
    assert.deepEqual(
      (await store.queue.list(GUILD)).map((item) => item.position),
      [0, 1],
    );
    assert.equal(await store.queue.clear(GUILD), 2);
    assert.equal(await store.queue.shift(GUILD), null);
  });

  it('keeps positions 0..n-1 after a removal and a shift from the middle of a long queue, and says what it holds', async () => {
    const store = await db.open();
    const tracks = await addTracks(store, 6);
    const items = await store.queue.insert(
      GUILD,
      tracks.map((track) => track.id),
      0,
      null,
    );
    // The same tracks in another server: a removal or a shift here must not move them.
    await store.queue.insert(
      OTHER,
      tracks.map((track) => track.id),
      0,
      null,
    );
    assert.equal(await store.queue.remove(GUILD, items[2]?.id ?? 0), true);
    assert.equal((await store.queue.shift(GUILD))?.id, items[0]?.id);
    const left = await store.queue.list(GUILD);
    assert.deepEqual(
      left.map((item) => [item.id, item.position]),
      [items[1], items[3], items[4], items[5]].map((item, index) => [item?.id, index]),
    );
    assert.deepEqual(
      (await store.queue.list(OTHER)).map((item) => item.position),
      [0, 1, 2, 3, 4, 5],
    );
    // has() answers from the index, for the track played or removed and for one still waiting.
    assert.equal(await store.queue.has(GUILD, tracks[0]?.id ?? 0), false);
    assert.equal(await store.queue.has(GUILD, tracks[3]?.id ?? 0), true);
    assert.equal(await store.queue.has(OTHER, tracks[0]?.id ?? 0), true);
  });

  it('removes many items in one go, closing every gap once, and counts only those that were there', async () => {
    const store = await db.open();
    const tracks = await addTracks(store, 5);
    const items = await store.queue.insert(
      GUILD,
      tracks.map((track) => track.id),
      0,
      null,
    );
    const [i1, i2, i3, i4, i5] = items;
    assert.ok(i1 && i2 && i3 && i4 && i5);
    // An ID that is not in the queue (played meanwhile) is no error; it is just not counted.
    assert.equal(await store.queue.removeMany(GUILD, [i2.id, i4.id, 999_999]), 2);
    assert.deepEqual(
      (await store.queue.list(GUILD)).map((item) => [item.id, item.position]),
      [
        [i1.id, 0],
        [i3.id, 1],
        [i5.id, 2],
      ],
    );
    // Another server's items are not touched, and an empty list writes nothing.
    assert.equal(await store.queue.removeMany(OTHER, [i1.id]), 0);
    assert.equal(await store.queue.removeMany(GUILD, []), 0);
    assert.equal(await store.queue.count(GUILD), 3);
  });
});

eachDatabase('HistoryRepository', (db) => {
  it('pages by the order entries were written in, even when the clock went back between two plays', async () => {
    const store = await db.open();
    const [a, b, c] = await addTracks(store, 3);
    assert.ok(a && b && c);
    // The second entry says it started earlier than the first (the clock was set back): by ID it is still newer, so
    // every entry is on exactly one page.
    await store.history.add({ guildId: GUILD, trackId: a.id, addedBy: null, playedAt: 5000, playedMs: 5000 });
    await store.history.add({ guildId: GUILD, trackId: b.id, addedBy: null, playedAt: 1000, playedMs: 5000 });
    await store.history.add({ guildId: GUILD, trackId: c.id, addedBy: null, playedAt: 9000, playedMs: 5000 });
    const first = await store.history.list(GUILD, 2);
    const second = await store.history.list(GUILD, 2, first.at(-1)?.id);
    assert.deepEqual(
      [...first, ...second].map((entry) => entry.track.title),
      ['Track 3', 'Track 2', 'Track 1'],
    );
  });

  it('lists newest first and pages back', async () => {
    const store = await db.open();
    const [a, b, c] = await addTracks(store, 3);
    assert.ok(a && b && c);
    await store.history.add({ guildId: GUILD, trackId: a.id, addedBy: null, playedAt: 1000, playedMs: 5000 });
    await store.history.add({ guildId: GUILD, trackId: b.id, addedBy: 'u1', playedAt: 2000, playedMs: 6000 });
    const newest = await store.history.add({
      guildId: GUILD,
      trackId: c.id,
      addedBy: null,
      playedAt: 3000,
      playedMs: 7000,
    });
    const page = await store.history.list(GUILD, 2);
    assert.deepEqual(
      page.map((entry) => entry.track.title),
      ['Track 3', 'Track 2'],
    );
    const older = await store.history.list(GUILD, 2, page.at(-1)?.id);
    assert.deepEqual(
      older.map((entry) => entry.track.title),
      ['Track 1'],
    );
    assert.equal(newest.playedMs, 7000);
  });
});

eachDatabase('PlaylistRepository', (db) => {
  it('saves, replaces, finds, renames and deletes', async () => {
    const store = await db.open();
    const [a, b, c] = await addTracks(store, 3);
    assert.ok(a && b && c);
    const saved = await store.playlists.save(GUILD, '  Evening  ', [a.id, b.id], 'u1');
    assert.equal(saved.name, 'Evening');
    assert.equal(saved.size, 2);
    // Saving under the same name replaces the tracks.
    const replaced = await store.playlists.save(GUILD, 'Evening', [c.id], 'u1');
    assert.equal(replaced.id, saved.id);
    assert.deepEqual(
      (await store.playlists.tracks(saved.id)).map((track) => track.title),
      ['Track 3'],
    );
    await store.playlists.save(GUILD, 'Morning', [a.id], null);
    await assert.rejects(() => store.playlists.rename(saved.id, 'Morning'), /exists/);
    assert.equal((await store.playlists.rename(saved.id, 'Night')).name, 'Night');
    assert.equal((await store.playlists.find(GUILD, 'Night'))?.id, saved.id);
    assert.equal(await store.playlists.remove(saved.id), true);
    assert.equal(await store.playlists.find(GUILD, 'Night'), null);
    await assert.rejects(() => store.playlists.save(GUILD, '   ', [a.id], null), StoreError);
  });
});

eachDatabase('PlayerStateRepository and SettingsRepository', (db) => {
  it('saves and loads the current track of each server', async () => {
    const store = await db.open();
    const [a] = await addTracks(store, 1);
    assert.ok(a);
    await store.playerState.save({
      guildId: GUILD,
      trackId: a.id,
      addedBy: 'u1',
      status: 'playing',
      positionMs: 1234.6,
      repeat: 'off',
    });
    assert.deepEqual(await store.playerState.load(GUILD), {
      guildId: GUILD,
      trackId: a.id,
      addedBy: 'u1',
      status: 'playing',
      positionMs: 1235,
      repeat: 'off',
      updatedAt: Date.UTC(2026, 10, 11),
      autoplay: 'off',
    });
    assert.equal((await store.playerState.all()).length, 1);
    assert.equal(await store.playerState.load(OTHER), null);
  });

  it('defaults to no DJ role and remembers one when set', async () => {
    const store = await db.open();
    assert.deepEqual(await store.settings.get(GUILD), { djRoleId: null, alertsChannelId: null });
    await store.settings.setDjRole(GUILD, '200000000000000001');
    assert.deepEqual(await store.settings.get(GUILD), { djRoleId: '200000000000000001', alertsChannelId: null });
    await store.settings.setDjRole(GUILD, null);
    assert.deepEqual(await store.settings.get(GUILD), { djRoleId: null, alertsChannelId: null });
  });
});

describe('Store.open and file modes', () => {
  // Windows keeps no such bits: the user's own profile folder, where the data is, keeps other users out there.
  it("makes a database copied in with a looser mode this user's alone", {
    skip: process.platform === 'win32',
  }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-mode-'));
    try {
      const file = path.join(dir, 'jukecord.db');
      await (await Store.open(file)).close();
      fs.chmodSync(file, 0o644);
      const store = await Store.open(file);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      await store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Store.transaction when the commit fails', () => {
  it('reports the commit error, rolls back, and leaves the next transaction working', async () => {
    const store = await memoryStore();
    // The driver's connection, under the SQLite executor the store runs its statements through.
    const db = (store.sql as unknown as { db: { exec(sql: string): void; isTransaction: boolean } }).db;
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
    await assert.rejects(
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
    const track = await store.transaction(() =>
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
    assert.equal(await store.tracks.bySource('https://example.com/a'), null);
  });
});
