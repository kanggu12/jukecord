/**
 * The copy of a whole database into another (src/store/copy.ts): every row through SQLite and every server the tests
 * have (JUKECORD_TEST_DATABASES) and back, a target with data refused or replaced, the ids going on past the copied
 * ones, a copy that fails halfway leaving the target as it was, and the backups of every kind of database (a SQLite
 * file of the same rows).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { listBackups, makeBackup } from '../../src/app/backups.ts';
import { copyStore } from '../../src/store/copy.ts';
import { openStore } from '../../src/store/open.ts';
import { VERSION_TABLE } from '../../src/store/schema.ts';
import type { SqlExecutor } from '../../src/store/sql.ts';
import { Store } from '../../src/store/store.ts';
import { eachDatabase, TEST_DATABASES } from '../support/databases.ts';
import { everyRow, fill, LONG_SOURCE } from '../support/fill.ts';
import { addTracks } from '../support/store.ts';

// A store of its own on a new SQLite file of the test's (closed by the test).
async function sqliteStore(): Promise<Store> {
  const sqlite = TEST_DATABASES[0];
  assert.ok(sqlite && sqlite.kind === 'sqlite');
  return openStore(await sqlite.another());
}

describe('a copy through every database', () => {
  it('keeps every row: SQLite, then each server the tests have, then SQLite again', async () => {
    const first = await sqliteStore();
    const stores: Store[] = [first];
    try {
      await fill(first);
      const expected = await everyRow(first);
      let from = first;
      for (const db of TEST_DATABASES.slice(1)) {
        const to = await db.open();
        const report = await copyStore(from, to);
        assert.equal(
          report.rows,
          Object.values(expected).reduce((sum, rows) => sum + rows.length, 0),
        );
        assert.deepEqual(await everyRow(to), expected, `the rows in ${db.name}`);
        from = to;
      }
      const last = await sqliteStore();
      stores.push(last);
      await copyStore(from, last);
      assert.deepEqual(await everyRow(last), expected, 'the rows back in SQLite');
      // What the repositories read is the same too: the long source by its hash, the names by case and accent.
      assert.equal((await last.tracks.bySource(LONG_SOURCE))?.title, 'Mïx — 夜の歌 🎵');
      // Three lists, in the order of their characters' numbers: a capital M first, ï after i.
      assert.deepEqual((await last.playlists.list('100000000000000001')).map((playlist) => playlist.name).sort(), [
        'Mix',
        'Mïx 🎶',
        'mix',
      ]);
    } finally {
      for (const store of stores) await store.close();
    }
  });
});

eachDatabase('a copy into a database', (db) => {
  it('refuses a target that holds data, changing nothing, and replaces it when told to', async () => {
    const source = await sqliteStore();
    try {
      await fill(source);
      const target = await db.open();
      await addTracks(target, 2, 'old');
      await assert.rejects(() => copyStore(source, target), /already holds jukecord's data \(tracks\)/);
      assert.equal((await everyRow(target)).tracks?.length, 2);
      await copyStore(source, target, { replace: true });
      assert.deepEqual(await everyRow(target), await everyRow(source));
    } finally {
      await source.close();
    }
  });

  it('goes on with new ids past the copied ones', async () => {
    const source = await sqliteStore();
    try {
      await fill(source);
      const target = await db.open();
      await copyStore(source, target);
      // The highest id of each table that makes its own, and a new row of each after the copy.
      const highest = async (table: string) => Number((await target.sql.get(`SELECT MAX(id) AS id FROM ${table}`))?.id);
      const before = {
        tracks: await highest('tracks'),
        queue: await highest('queue_items'),
        history: await highest('history'),
        playlists: await highest('playlists'),
        tokens: await highest('api_tokens'),
        links: await highest('listen_links'),
      };
      const [track] = await addTracks(target, 1, 'new');
      const [item] = await target.queue.insert('100000000000000003', [track?.id ?? 0], 0, null);
      const play = await target.history.add({
        guildId: '100000000000000003',
        trackId: track?.id ?? 0,
        addedBy: null,
        playedAt: 1,
        playedMs: 1,
      });
      const list = await target.playlists.save('100000000000000003', 'After', [track?.id ?? 0], null);
      const token = await target.tokens.create({
        hash: 'e'.repeat(64),
        name: 'n',
        kind: 'host',
        userId: null,
        scope: 'read',
      });
      const link = await target.listenLinks.create({
        hash: 'f'.repeat(64),
        guildId: '100000000000000003',
        createdBy: null,
        lastsMs: 60_000,
        maxGuests: 1,
      });
      assert.ok((track?.id ?? 0) > before.tracks, 'a new track');
      assert.ok((item?.id ?? 0) > before.queue, 'a new queue item');
      assert.ok(play.id > before.history, 'a new play');
      assert.ok(list.id > before.playlists, 'a new playlist');
      assert.ok(token.id > before.tokens, 'a new token');
      assert.ok(link.id > before.links, 'a new listening link');
    } finally {
      await source.close();
    }
  });

  it('leaves the target as it was when the copy fails halfway', async () => {
    const real = await sqliteStore();
    try {
      await fill(real);
      // The same source, but its history cannot be read: the copy fails after the tables before it were written.
      const broken = await Store.open(failingOn(real.sql, 'FROM history'), { migrate: false });
      const target = await db.open();
      await addTracks(target, 1, 'kept');
      await assert.rejects(() => copyStore(broken, target, { replace: true }), /the disk went away/);
      // Not emptied, nothing of the copy kept.
      assert.deepEqual(
        (await everyRow(target)).tracks?.map((row) => (row as unknown[])[1]),
        ['https://example.com/watch?v=kept1'],
      );
      assert.equal((await everyRow(target)).playlists?.length, 0);
    } finally {
      await real.close();
    }
  });

  it('backs the database up as a SQLite file of the same rows, a file alone, among the backups', async () => {
    const store = await db.open();
    await fill(store);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-backups-'));
    try {
      const made = await makeBackup(store, dir, 7);
      assert.deepEqual(
        listBackups(dir).map((backup) => backup.file),
        [made.file],
      );
      // One file, no write-ahead log beside it (as VACUUM INTO leaves SQLite's), at the latest schema.
      assert.deepEqual(fs.readdirSync(dir), [path.basename(made.file)]);
      assert.equal(fs.readFileSync(made.file).subarray(0, 15).toString(), 'SQLite format 3');
      const copy = await Store.open(made.file);
      try {
        assert.deepEqual(await everyRow(copy), await everyRow(store));
      } finally {
        await copy.close();
      }
      // Its write-ahead log was folded in at the close: still one file.
      assert.deepEqual(fs.readdirSync(dir), [path.basename(made.file)]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a source only at this jukecord’s schema, saying what to do otherwise', async () => {
    const store = await db.open();
    await store.close();
    // The version another jukecord would have left, on a new executor each time (a store that refuses closes it).
    const at = async (version: number) => {
      const sql = await db.executor();
      if (db.kind === 'sqlite') await sql.exec(`PRAGMA user_version = ${version}`);
      else await sql.run(`UPDATE ${VERSION_TABLE} SET version = ?`, [version]);
      return sql;
    };
    await assert.rejects(
      async () => Store.open(await at(7), { migrate: false }),
      /older than this jukecord's \(8\); start this jukecord on it/,
    );
    await assert.rejects(async () => Store.open(await at(999), { migrate: false }), /newer than this jukecord knows/);
  });
});

// An executor that answers as `sql` does, except that every statement holding `text` fails (as a disk gone away).
function failingOn(sql: SqlExecutor, text: string): SqlExecutor {
  const check = (statement: string) => {
    if (statement.includes(text)) throw new Error('the disk went away');
  };
  return {
    dialect: sql.dialect,
    server: sql.server,
    get isOpen() {
      return sql.isOpen;
    },
    all: async (statement, params) => {
      check(statement);
      return sql.all(statement, params);
    },
    get: async (statement, params) => {
      check(statement);
      return sql.get(statement, params);
    },
    run: async (statement, params) => {
      check(statement);
      return sql.run(statement, params);
    },
    exec: async (statement) => {
      check(statement);
      return sql.exec(statement);
    },
    transaction: (fn, options) => sql.transaction(fn, options),
    // The real store closes the executor itself.
    close: async () => {},
  };
}
