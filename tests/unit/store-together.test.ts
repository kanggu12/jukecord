/**
 * The tables of listening together: lyrics kept per track, what a site says a recording is, listening links and the
 * sessions of their guests, and the scope of a panel login; and the migration that makes them from an older database.
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
const OTHER = '100000000000000002';
const ALICE = '300000000000000001';

// A store whose clock the test moves.
function clocked() {
  let now = Date.UTC(2026, 10, 11);
  const store = memoryStore(() => now);
  return { store, advance: (ms: number) => (now += ms), now: () => now };
}

describe('the migration of listening together', () => {
  it('brings a database from before it up to date, its panel logins keeping every right they had', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-together-'));
    try {
      const file = path.join(dir, 'jukecord.db');
      // The migrations before this one (found by what it makes, not by its number, which a merge may change).
      const mine = MIGRATIONS.find((migration) => migration.sql.includes('CREATE TABLE listen_links'));
      assert.ok(mine);
      const old = new DatabaseSync(file);
      for (const migration of MIGRATIONS.filter((entry) => entry.version < mine.version)) {
        old.exec(migration.sql);
        old.exec(`PRAGMA user_version = ${migration.version}`);
      }
      // A login made before the scope existed.
      old
        .prepare(
          `INSERT INTO sessions (id_hash, kind, user_id, csrf, created_at, seen_at, expires_at)
           VALUES ('h', 'user', ?, 'c', 1, 1, ?)`,
        )
        .run(ALICE, Date.UTC(2030, 0, 1));
      old.close();
      const store = Store.open(file, { now: () => Date.UTC(2026, 10, 11) });
      assert.equal(store.schemaVersion(), MIGRATIONS.at(-1)?.version);
      assert.equal(store.sessions.get('h')?.scope, 'admin');
      store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('LyricsRepository', () => {
  it('keeps one row per track, replaced by a later lookup, and cuts very long words at a line', () => {
    const { store } = clocked();
    const [track] = addTracks(store, 1);
    assert.ok(track);
    assert.equal(store.lyrics.get(track.id), null);
    const none = store.lyrics.save({ trackId: track.id, kind: 'none', synced: null, plain: null, sourceId: null });
    assert.equal(none.kind, 'none');
    const long = `${'la la la\n'.repeat(10_000)}end`;
    const found = store.lyrics.save({ trackId: track.id, kind: 'plain', synced: null, plain: long, sourceId: 7 });
    assert.equal(found.kind, 'plain');
    assert.equal(found.sourceId, 7);
    // Cut to the limit at the end of a line: no half line.
    assert.ok((found.plain?.length ?? 0) <= 64_000);
    assert.ok(found.plain?.endsWith('la la la'));
    assert.equal(store.lyrics.get(track.id)?.plain, found.plain);
  });

  it('reads a kind it does not know as none found', () => {
    const { store } = clocked();
    const [track] = addTracks(store, 1);
    assert.ok(track);
    store.db.prepare("INSERT INTO lyrics (track_id, kind, fetched_at) VALUES (?, 'karaoke', 1)").run(track.id);
    assert.equal(store.lyrics.get(track.id)?.kind, 'none');
  });
});

describe('MusicRepository', () => {
  it("keeps what a site said a track is, the newest winning, names cut to a name's length", () => {
    const { store } = clocked();
    const [track] = addTracks(store, 1);
    assert.ok(track);
    assert.equal(store.music.get(track.id), null);
    store.music.set(track.id, { artist: 'Example Band', title: 'Paper Boats', album: null });
    store.music.set(track.id, { artist: ' Example Band ', title: 'x'.repeat(400), album: 'Rivers' });
    const music = store.music.get(track.id);
    assert.equal(music?.artist, 'Example Band');
    assert.equal(music?.title.length, 300);
    assert.equal(music?.album, 'Rivers');
  });
});

describe('ListenLinkRepository and GuestSessionRepository', () => {
  const make = (
    store: Store,
    guildId = GUILD,
    createdBy: string | null = ALICE,
    days = 7,
    hash = `h${Math.random()}`,
  ) =>
    store.listenLinks.create({
      hash,
      guildId,
      createdBy,
      lastsMs: days * 86_400_000,
      maxGuests: 2,
    });

  it("lists a server's links, newest first, everyone's or one person's, with how many guests are in", () => {
    const { store } = clocked();
    const first = make(store, GUILD, ALICE);
    const second = make(store, GUILD, null);
    make(store, OTHER, ALICE);
    assert.deepEqual(
      store.listenLinks.list(GUILD).map((link) => link.id),
      [second.id, first.id],
    );
    assert.deepEqual(
      store.listenLinks.list(GUILD, ALICE).map((link) => link.id),
      [first.id],
    );
    assert.equal(store.listenLinks.count(GUILD), 2);
    store.guests.create({ idHash: 'g1', linkId: first.id, csrf: 'c', expiresAt: first.expiresAt });
    assert.equal(store.listenLinks.get(first.id)?.guests, 1);
    assert.equal(store.guests.count(first.id), 1);
    assert.equal(store.guests.get('g1')?.guildId, GUILD);
  });

  it('forgets expired links and guests, and ends the guests of a link deleted', () => {
    const { store, advance } = clocked();
    const link = make(store, GUILD, ALICE, 1, 'code-hash');
    store.guests.create({ idHash: 'g1', linkId: link.id, csrf: 'c', expiresAt: link.expiresAt });
    store.guests.create({ idHash: 'g2', linkId: link.id, csrf: 'c', expiresAt: link.expiresAt });
    assert.equal(store.listenLinks.byHash('code-hash')?.id, link.id);
    // Deleting the link deletes its guests' sessions with it.
    assert.equal(store.listenLinks.remove(link.id), true);
    assert.equal(store.guests.get('g1'), null);
    assert.equal(store.guests.count(link.id), 0);
    // An expired link is gone to every lookup, and pruning deletes it.
    const later = make(store, GUILD, ALICE, 1, 'later-hash');
    store.guests.create({ idHash: 'g3', linkId: later.id, csrf: 'c', expiresAt: later.expiresAt });
    advance(86_400_000);
    assert.equal(store.listenLinks.byHash('later-hash'), null);
    assert.equal(store.listenLinks.get(later.id), null);
    assert.deepEqual(store.listenLinks.list(GUILD), []);
    assert.equal(store.guests.get('g3'), null);
    assert.equal(store.listenLinks.prune(), 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM guest_sessions').get()?.n, 0);
  });
});

describe('panel logins with a scope', () => {
  it("keeps a friend's scope, never wider than control, and reads an unknown kind as a user", () => {
    const { store } = clocked();
    const expiresAt = Date.UTC(2030, 0, 1);
    store.sessions.create({ idHash: 'f', kind: 'friend', userId: null, csrf: 'c', scope: 'read', expiresAt });
    assert.deepEqual([store.sessions.get('f')?.kind, store.sessions.get('f')?.scope], ['friend', 'read']);
    // A friend's row edited to admin by hand stays at control.
    store.db.prepare("UPDATE sessions SET scope = 'admin' WHERE id_hash = 'f'").run();
    assert.equal(store.sessions.get('f')?.scope, 'control');
    store.db
      .prepare(
        "INSERT INTO sessions (id_hash, kind, user_id, csrf, scope, created_at, seen_at, expires_at) VALUES ('x', 'root', NULL, 'c', 'admin', 1, 1, ?)",
      )
      .run(expiresAt);
    assert.equal(store.sessions.get('x')?.kind, 'user');
  });
});
