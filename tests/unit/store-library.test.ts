/**
 * The database's parts for likes and autoplay: the migration that adds them (found by what it does, not by its
 * number, which changes when branches merge), the likes, the autoplay mode kept with the player, the end of a queue
 * that autoplay filled, and the statistics that leave autoplay out of the people.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { AUTOPLAY } from '../../src/core/types.ts';
import { MIGRATIONS } from '../../src/store/schema.ts';
import { Store } from '../../src/store/store.ts';
import { addTracks, memoryStore } from '../support/store.ts';

const GUILD = '100000000000000001';
const ALICE = '300000000000000001';
const BOB = '300000000000000002';

describe('the migration for likes and autoplay', () => {
  it('brings a database from the schema before it up to date, keeping its data', () => {
    const at = MIGRATIONS.findIndex((migration) => migration.sql.includes('CREATE TABLE likes'));
    assert.ok(at > 0, 'there is a migration that makes the likes table');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-library-'));
    try {
      const file = path.join(dir, 'jukecord.db');
      // A database exactly as the migrations before this one left it, with a player state and a play in it.
      const old = new DatabaseSync(file);
      for (const migration of MIGRATIONS.slice(0, at)) old.exec(migration.sql);
      old.exec(`PRAGMA user_version = ${MIGRATIONS[at - 1]?.version ?? 0}`);
      old
        .prepare("INSERT INTO tracks (source, url, title, created_at, updated_at) VALUES ('s', 'u', 'Old track', 1, 1)")
        .run();
      old
        .prepare(
          "INSERT INTO player_state (guild_id, track_id, status, position_ms, repeat, updated_at) VALUES (?, 1, 'paused', 5000, 'queue', 1)",
        )
        .run(GUILD);
      old
        .prepare('INSERT INTO history (guild_id, track_id, added_by, played_at, played_ms) VALUES (?, 1, ?, 1, 9000)')
        .run(GUILD, ALICE);
      old.close();
      const store = Store.open(file);
      assert.equal(store.schemaVersion(), MIGRATIONS.at(-1)?.version);
      // Rows from before keep what they had; the new column has its default.
      const saved = store.playerState.load(GUILD);
      assert.equal(saved?.repeat, 'queue');
      assert.equal(saved?.autoplay, 'off');
      assert.equal(store.history.played(GUILD, 1), true);
      // The new table works with the old tracks.
      assert.equal(store.likes.add(ALICE, 1), true);
      assert.deepEqual(
        store.likes.list(ALICE).map((entry) => entry.track.title),
        ['Old track'],
      );
      store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('LikeRepository', () => {
  it('likes once per login, lists newest first and takes a like back', () => {
    let now = 1000;
    const store = memoryStore(() => now);
    const [one, two, three] = addTracks(store, 3);
    assert.ok(one && two && three);
    assert.equal(store.likes.add(ALICE, one.id), true);
    now += 10;
    assert.equal(store.likes.add(ALICE, two.id), true);
    now += 10;
    // Liking again changes nothing, its time included.
    assert.equal(store.likes.add(ALICE, one.id), false);
    assert.equal(store.likes.add(BOB, three.id), true);
    assert.equal(store.likes.has(ALICE, one.id), true);
    assert.equal(store.likes.has(BOB, one.id), false);
    assert.equal(store.likes.count(ALICE), 2);
    assert.deepEqual(
      store.likes.list(ALICE).map((entry) => [entry.track.id, entry.likedAt]),
      [
        [two.id, 1010],
        [one.id, 1000],
      ],
    );
    assert.equal(store.likes.remove(ALICE, two.id), true);
    assert.equal(store.likes.remove(ALICE, two.id), false);
    assert.deepEqual(
      store.likes.list(ALICE).map((entry) => entry.track.id),
      [one.id],
    );
    // The host's login has its own list.
    assert.equal(store.likes.add('host', three.id), true);
    assert.equal(store.likes.count('host'), 1);
  });
});

describe('the player state', () => {
  it('keeps the autoplay mode, and reads one it does not know as off', () => {
    const store = memoryStore();
    store.playerState.save({
      guildId: GUILD,
      trackId: null,
      addedBy: null,
      status: 'idle',
      positionMs: 0,
      repeat: 'off',
      autoplay: 'related',
    });
    assert.equal(store.playerState.load(GUILD)?.autoplay, 'related');
    // Saved by code that does not know autoplay: off.
    store.playerState.save({
      guildId: GUILD,
      trackId: null,
      addedBy: null,
      status: 'idle',
      positionMs: 0,
      repeat: 'off',
    });
    assert.equal(store.playerState.load(GUILD)?.autoplay, 'off');
    store.db.prepare("UPDATE player_state SET autoplay = 'everything' WHERE guild_id = ?").run(GUILD);
    assert.equal(store.playerState.load(GUILD)?.autoplay, 'off');
  });
});

describe('the end of a queue autoplay filled', () => {
  it('is after the last track a person queued, at 0 when only autoplay queued, and none without autoplay', () => {
    const store = memoryStore();
    const tracks = addTracks(store, 4).map((track) => track.id);
    assert.equal(store.queue.autoplayTail(GUILD), null);
    store.queue.insert(GUILD, tracks.slice(0, 2), 0, ALICE);
    assert.equal(store.queue.autoplayTail(GUILD), null);
    store.queue.insert(GUILD, tracks.slice(2, 4), 2, AUTOPLAY);
    assert.equal(store.queue.autoplayTail(GUILD), 2);
    // The host's tracks (no Discord ID) count as a person's.
    store.queue.insert(GUILD, [tracks[0] ?? 0], 0, null);
    assert.equal(store.queue.autoplayTail(GUILD), 3);
    const other = '100000000000000002';
    store.queue.insert(other, [tracks[1] ?? 0], 0, AUTOPLAY);
    assert.equal(store.queue.autoplayTail(other), 0);
  });
});

describe('the history for autoplay and likes', () => {
  it('says what played in a server, its newest plays, and how often each track played and was liked', () => {
    const store = memoryStore();
    const [one, two, three] = addTracks(store, 3);
    assert.ok(one && two && three);
    const play = (trackId: number, at: number, by: string | null = ALICE) =>
      store.history.add({ guildId: GUILD, trackId, addedBy: by, playedAt: at, playedMs: 60_000 });
    play(one.id, 1);
    play(two.id, 2);
    play(one.id, 3);
    play(two.id, 4, AUTOPLAY);
    assert.equal(store.history.played(GUILD, one.id), true);
    assert.equal(store.history.played(GUILD, three.id), false);
    assert.equal(store.history.played('100000000000000002', one.id), false);
    assert.deepEqual(store.history.recentTrackIds(GUILD, 3), [two.id, one.id]);
    store.likes.add(ALICE, one.id);
    store.likes.add(BOB, one.id);
    const counts = new Map(store.history.playCounts(GUILD).map((entry) => [entry.trackId, entry]));
    assert.deepEqual(counts.get(one.id), { trackId: one.id, plays: 2, likes: 2, durationMs: 180_000 });
    assert.deepEqual(counts.get(two.id), { trackId: two.id, plays: 2, likes: 0, durationMs: 180_000 });
    assert.equal(counts.has(three.id), false);
  });

  it('leaves autoplay out of the people who added, and counts its plays', () => {
    const store = memoryStore();
    const [one] = addTracks(store, 1);
    assert.ok(one);
    // Autoplay played most, then Alice, then the host.
    for (const by of [ALICE, ALICE, AUTOPLAY, AUTOPLAY, AUTOPLAY, null]) {
      store.history.add({ guildId: GUILD, trackId: one.id, addedBy: by, playedAt: 10, playedMs: 1000 });
    }
    const stats = store.history.stats(GUILD, 0, 0);
    assert.equal(stats.plays, 6);
    // Alice and the host.
    assert.equal(stats.people, 2);
    assert.deepEqual(
      stats.topPeople.map((entry) => entry.userId),
      [ALICE, null],
    );
  });
});
