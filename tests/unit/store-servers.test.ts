/**
 * What differs between the databases under the repositories, tested on each (SQLite and every server of
 * JUKECORD_TEST_DATABASES): a track's source longer than an index entry takes (unique by its hash on the servers),
 * every character kept and names told apart by case and accent (MySQL's utf8mb4 with utf8mb4_bin, PostgreSQL's "C"),
 * a check and the write after it kept one step when two transactions race (serializable, run again when refused), two
 * jukecords writing the same new track at once, and the tables having exactly the columns a copy reads.
 */
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { openStore } from '../../src/store/open.ts';
import { TABLES, VERSION_TABLE } from '../../src/store/schema.ts';
import { StoreError } from '../../src/store/store.ts';
import { eachDatabase } from '../support/databases.ts';
import { LONG_SOURCE } from '../support/fill.ts';
import { addTracks } from '../support/store.ts';

const GUILD = '100000000000000001';

// A track looked up from a site, with this source and title.
const track = (source: string, title = 'A track') => ({
  source,
  url: source,
  title,
  uploader: null,
  durationMs: 1000,
  thumbnail: null,
});

eachDatabase('what differs between the databases', (db) => {
  it('keeps a source longer than an index entry takes, one track by it, found by it', async () => {
    const store = await db.open();
    const first = await store.tracks.upsert(track(LONG_SOURCE, 'First'));
    const again = await store.tracks.upsert(track(LONG_SOURCE, 'Again'));
    assert.equal(again.id, first.id);
    assert.equal((await store.tracks.bySource(LONG_SOURCE))?.title, 'Again');
    // One character more at the end is another track (its hash differs), and one not stored is found as none.
    const other = await store.tracks.upsert(track(`${LONG_SOURCE}y`));
    assert.notEqual(other.id, first.id);
    assert.equal(await store.tracks.bySource(`${LONG_SOURCE}z`), null);
    assert.equal(LONG_SOURCE.length > 3000, true);
  });

  it('keeps every character, emoji among them, and tells names apart by case and accent', async () => {
    const store = await db.open();
    const title = 'Neon Rain 🌧️🎵 — 夜の歌, 비가 내려 𝄞';
    const [saved] = [await store.tracks.upsert(track('https://example.com/emoji', title))];
    assert.equal((await store.tracks.get(saved.id))?.title, title);
    await store.users.upsert({ id: '300000000000000001', name: 'Alice 🦊', avatar: null });
    assert.equal((await store.users.get('300000000000000001'))?.name, 'Alice 🦊');
    // Three names, three lists: MySQL's default collations would take "mix" for "Mix" and "Mïx" for both.
    for (const name of ['Mix', 'mix', 'Mïx']) await store.playlists.save(GUILD, name, [saved.id], null);
    assert.equal((await store.playlists.list(GUILD)).length, 3);
    assert.equal((await store.playlists.find(GUILD, 'mix'))?.name, 'mix');
    assert.equal((await store.playlists.find(GUILD, 'MIX'))?.name, undefined);
    // Two sources that differ only by case are two tracks.
    const upper = await store.tracks.upsert(track('https://example.com/Watch?v=A'));
    const lower = await store.tracks.upsert(track('https://example.com/watch?v=a'));
    assert.notEqual(upper.id, lower.id);
  });

  it('refuses a NUL character in any text it keeps, as an invalid request, the same on every database', async () => {
    const store = await db.open();
    // SQLite kept such a text cut short, PostgreSQL failed with an error of its own, MySQL kept it whole.
    const nul = 'a\u0000b';
    const refused = (what: string, work: () => Promise<unknown>) =>
      assert.rejects(work, (error: unknown) => {
        assert.ok(error instanceof StoreError, `${what}: ${String(error)}`);
        assert.match(error.message, /NUL/);
        return true;
      });
    await refused('a playlist’s name', () => store.playlists.save(GUILD, nul, [], null));
    await refused('a token’s name', () =>
      store.tokens.create({ hash: 'nul-token', name: nul, kind: 'host', userId: null, scope: 'read' }),
    );
    await refused('a track’s title', () => store.tracks.upsert(track('https://example.com/nul', nul)));
    const list = await store.playlists.save(GUILD, 'kept', [], null);
    await refused('a playlist’s new name', () => store.playlists.rename(list.id, nul));
    // Nothing of them was kept.
    assert.deepEqual(
      (await store.playlists.list(GUILD)).map((playlist) => playlist.name),
      ['kept'],
    );
    assert.equal(await store.tracks.bySource('https://example.com/nul'), null);
    assert.equal(await store.tokens.byHash('nul-token'), null);
  });

  it('keeps a check and the write after it one step: of two at once at a limit, one passes', async () => {
    const store = await db.open();
    const [one, two, three] = await addTracks(store, 3);
    assert.ok(one && two && three);
    await store.likes.add('host', one.id);
    // Both read the count before either writes, on their first try (on a server; SQLite's transactions take turns,
    // so there the second reads after the first has written). A try run again does not wait.
    let arrived = 0;
    let release: () => void = () => {};
    const bothRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    const like = (trackId: number) => {
      let first = true;
      return store.transaction(async () => {
        const count = await store.likes.count('host');
        if (first && db.kind !== 'sqlite') {
          first = false;
          arrived += 1;
          if (arrived === 2) release();
          await bothRead;
        }
        if (count >= 2) throw new Error('the likes are full');
        await store.likes.add('host', trackId);
      });
    };
    const results = await Promise.allSettled([like(two.id), like(three.id)]);
    assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
    const refused = results.find((result) => result.status === 'rejected');
    assert.match(String((refused as PromiseRejectedResult | undefined)?.reason), /the likes are full/);
    assert.equal(await store.likes.count('host'), 2);
  });

  // A server only: two SQLite connections to one file in one thread wait for each other's lock synchronously (the
  // second's BEGIN IMMEDIATE blocks the thread the first needs to finish), and jukecord runs one per process.
  it('makes one track when two jukecords add the same new one at once', {
    skip: db.kind === 'sqlite' ? 'two SQLite connections in one thread block each other' : false,
  }, async () => {
    // Two stores on the one database, as a core and an edge would have (each its own connections).
    const a = await db.open();
    const b = await db.open();
    const [x, y] = await Promise.all([
      a.tracks.upsert(track('https://example.com/both', 'From a')),
      b.tracks.upsert(track('https://example.com/both', 'From b')),
    ]);
    assert.equal(x.id, y.id);
    assert.equal(Number((await a.sql.get('SELECT COUNT(*) AS n FROM tracks'))?.n), 1);
  });

  it('keeps a server’s voice channel writes in the order they were asked for, though nobody waits between them', async () => {
    const store = await db.open();
    // The bot's voice events are written as they come (discord/rejoin.ts): fifty moves at once, then a read.
    const writes: Promise<void>[] = [];
    for (let move = 0; move < 50; move += 1) writes.push(store.voiceChannels.remember(GUILD, `channel-${move}`));
    writes.push(store.voiceChannels.told(GUILD));
    await Promise.all(writes);
    assert.equal(await store.voiceChannels.get(GUILD), 'channel-49');
    assert.notEqual(await store.voiceChannels.toldAt(GUILD), null);
  });

  it('reports each statement by its kind, each transaction whole, a failure as one, and its connections', async () => {
    const seen: string[] = [];
    let connections: (() => { busy: number; idle: number; waiting: number }) | null = null;
    const report = {
      query: (kind: string, seconds: number, failed: boolean) => {
        assert.ok(seconds >= 0 && seconds < 30, `${kind} took ${seconds} s`);
        seen.push(failed ? `${kind} failed` : kind);
      },
      connections: (read: () => { busy: number; idle: number; waiting: number }) => {
        connections = read;
      },
    };
    const store = await db.open({ report });
    // What opening it ran (the schema's version, the migrations) is no part of this.
    seen.length = 0;
    await store.tracks.get(1);
    // A transaction's own words (BEGIN, COMMIT) are in its report, not apart.
    await store.transaction(() => store.sql.run('UPDATE tracks SET title = title WHERE id = 0'));
    await store.sql.get('SELECT nothing FROM nowhere').catch(() => {});
    assert.deepEqual(seen, ['select', 'update', 'transaction', 'select failed']);
    const use = (connections as (() => { busy: number; idle: number; waiting: number }) | null)?.();
    assert.ok(use && use.busy === 0 && use.waiting === 0 && use.idle >= 0, JSON.stringify(use));
  });

  // A server only, as the test above it (two SQLite connections in one thread block each other).
  it('brings up two jukecords opening a new database at once, the schema made by one of them', {
    skip: db.kind === 'sqlite' ? 'two SQLite connections in one thread block each other' : false,
  }, async () => {
    const address = await db.another();
    // A core and an edge starting together on a database nobody ran on: one makes the schema under the lock, the other
    // waits for it and finds it made.
    const [a, b] = await Promise.all([openStore(address, { pool: 2 }), openStore(address, { pool: 2 })]);
    try {
      assert.deepEqual([await a.schemaVersion(), await b.schemaVersion()], [8, 8]);
      assert.equal(Number((await a.sql.get(`SELECT COUNT(*) AS n FROM ${VERSION_TABLE}`))?.n), 1);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('has exactly the columns a copy reads in every table (and only the servers’ own beside them)', async () => {
    const store = await db.open();
    for (const table of TABLES) {
      const columns =
        db.kind === 'sqlite'
          ? (await store.sql.all(`SELECT name FROM pragma_table_info('${table.name}')`)).map((row) => String(row.name))
          : (
              await store.sql.all(
                `SELECT column_name AS name FROM information_schema.columns
                   WHERE table_schema = ${db.kind === 'postgres' ? 'current_schema()' : 'DATABASE()'} AND table_name = ?`,
                [table.name],
              )
            ).map((row) => String(row.name ?? row.NAME ?? row.COLUMN_NAME));
      // The servers' source_hash (the tracks' unique key) and seq (voice channels' order) are theirs alone.
      const own = columns.filter((column) => column !== 'source_hash' && column !== 'seq');
      assert.deepEqual(own.sort(), [...table.columns].sort(), table.name);
    }
  });
});
