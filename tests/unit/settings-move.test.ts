/**
 * Moving to another database (src/settings/move.ts): from the data folder's SQLite file into each database the tests
 * have (PostgreSQL and MySQL/MariaDB when JUKECORD_TEST_DATABASES names them), every row copied with its progress
 * said, the database in use never changed, a target with data refused unless replaced, a copy stopped leaving the
 * target as it was, and the switch's last copy carrying what was written after the first.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, it } from 'node:test';
import { DatabaseMove, type MoveState } from '../../src/settings/move.ts';
import { defaultSqliteFile, parseDatabaseAddress } from '../../src/store/address.ts';
import { openExecutor } from '../../src/store/open.ts';
import { Store } from '../../src/store/store.ts';
import { eachDatabase } from '../support/databases.ts';
import { everyRow, fill } from '../support/fill.ts';
import { addTracks } from '../support/store.ts';

const folders: string[] = [];
after(() => {
  for (const folder of folders) fs.rmSync(folder, { recursive: true, force: true });
});

// A data folder with its SQLite database filled with every kind of row, the database jukecord uses.
async function source(): Promise<{ dataDir: string; store: Store }> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-move-'));
  folders.push(dataDir);
  const store = await Store.open(defaultSqliteFile(dataDir));
  await fill(store);
  return { dataDir, store };
}

// The move's state once its copy is over.
async function copied(move: DatabaseMove): Promise<MoveState> {
  for (let tries = 0; tries < 300; tries += 1) {
    const state = move.current;
    if (state && state.phase !== 'copying') return state;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('the copy did not end');
}

it('tests another program’s SQLite file without changing it, and never moves into it', async () => {
  const { dataDir, store } = await source();
  const move = new DatabaseMove({ dataDir, current: { kind: 'sqlite', file: defaultSqliteFile(dataDir) }, pool: 2 });
  // Another program's file, in SQLite's own rollback journal, with a table of its own.
  const other = path.join(dataDir, 'notes-app.db');
  const theirs = new DatabaseSync(other);
  theirs.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO notes (body) VALUES ('kept')");
  theirs.close();
  const bytes = fs.readFileSync(other);
  const files = fs.readdirSync(dataDir).sort();
  const tested = await move.test(`sqlite:${other}`);
  assert.deepEqual(
    [tested.ok, tested.schema, tested.problem],
    [false, 0, 'it holds tables that are not jukecord’s: notes'],
  );
  // As it was: the same bytes, its journal, no file made beside it.
  assert.deepEqual(fs.readFileSync(other), bytes);
  assert.deepEqual(fs.readdirSync(dataDir).sort(), files);
  const again = new DatabaseSync(other, { readOnly: true });
  assert.equal(again.prepare('PRAGMA journal_mode').get()?.journal_mode, 'delete');
  again.close();
  // Not moved into, replaced or not.
  await assert.rejects(move.start(`sqlite:${other}`, true), /it holds tables that are not jukecord’s: notes/);
  assert.deepEqual(fs.readFileSync(other), bytes);
  await store.close();
});

it('tells the database in use through a link to its file, and never moves into it', async () => {
  const { dataDir, store } = await source();
  const file = defaultSqliteFile(dataDir);
  const move = new DatabaseMove({ dataDir, current: { kind: 'sqlite', file }, pool: 2 });
  const link = path.join(dataDir, 'the-same.db');
  fs.symlinkSync(file, link);
  const before = await everyRow(store);
  const tested = await move.test(`sqlite:${link}`);
  assert.deepEqual([tested.ok, tested.inUse, tested.problem], [false, true, 'it is the database jukecord uses now']);
  // Replaced, it would have been emptied, and the database in use with it.
  await assert.rejects(move.start(`sqlite:${link}`, true), /it is the database jukecord uses now/);
  assert.deepEqual(await everyRow(store), before);
  await store.close();
});

eachDatabase('moving to another database', (db) => {
  it('copies every row with its progress, leaves the database in use as it was, and switches with the latest rows', async () => {
    const { dataDir, store } = await source();
    const before = await everyRow(store);
    const move = new DatabaseMove({ dataDir, current: { kind: 'sqlite', file: defaultSqliteFile(dataDir) }, pool: 2 });
    const url = await db.url();
    const tested = await move.test(url);
    assert.deepEqual([tested.ok, tested.problem], [true, null]);
    // Empty: no rows, or (a SQLite file not made yet) a new file the move makes.
    assert.ok(tested.rows === 0 || tested.newFile, `${tested.rows} rows`);
    await move.start(url, false);
    const state = await copied(move);
    assert.equal(state.phase, 'copied', state.error ?? '');
    const total = Object.values(before).reduce((sum, rows) => sum + rows.length, 0);
    assert.deepEqual([state.rows, state.total], [total, total]);
    const target = await db.open();
    assert.deepEqual(await everyRow(target), before);
    // Written after the first copy: the switch's last copy carries it too.
    await addTracks(store, 2, 'late');
    const latest = await everyRow(store);
    assert.equal(await move.finalCopy(), url);
    assert.deepEqual(await everyRow(target), latest);
    // The database in use holds what it held (and what was written to it), nothing taken away.
    assert.deepEqual(await everyRow(store), latest);
    await store.close();
  });

  it('refuses a target that holds jukecord’s data unless it is replaced, and stops a copy on asking', async () => {
    const { dataDir, store } = await source();
    const move = new DatabaseMove({ dataDir, current: { kind: 'sqlite', file: defaultSqliteFile(dataDir) }, pool: 2 });
    const url = await db.url();
    const target = await db.open();
    await addTracks(target, 3, 'there');
    const theirs = await everyRow(target);
    await assert.rejects(move.start(url, false), /holds jukecord’s data already/);
    // Replaced: its rows are this jukecord's afterwards.
    await move.start(url, true);
    assert.equal((await copied(move)).phase, 'copied');
    assert.deepEqual(await everyRow(target), await everyRow(store));
    // A move stopped is forgotten; its target is whatever its transaction left (nothing of a copy cut off).
    await move.cancel();
    assert.equal(move.current, null);
    assert.notDeepEqual(await everyRow(target), theirs);
    await store.close();
  });

  it('refuses a database that holds another program’s tables, replaced or not', async () => {
    const { dataDir, store } = await source();
    const move = new DatabaseMove({ dataDir, current: { kind: 'sqlite', file: defaultSqliteFile(dataDir) }, pool: 2 });
    const url = await db.anotherUrl();
    const sql = await openExecutor(parseDatabaseAddress(url, dataDir), { pool: 1 });
    await sql.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
    // The id given: only SQLite makes one for an INTEGER PRIMARY KEY.
    await sql.run('INSERT INTO notes (id, body) VALUES (?, ?)', [1, 'kept']);
    const tested = await move.test(url);
    assert.deepEqual(
      [tested.ok, tested.schema, tested.problem],
      [false, 0, 'it holds tables that are not jukecord’s: notes'],
    );
    await assert.rejects(move.start(url, true), /it holds tables that are not jukecord’s: notes/);
    assert.deepEqual(
      (await sql.all('SELECT body FROM notes')).map((row) => row.body),
      ['kept'],
    );
    await sql.close();
    await store.close();
  });

  it('tells the database in use by what its server says it is, under another host name', {
    skip: db.kind === 'sqlite' && 'a file has no host name (its links are the test above)',
  }, async () => {
    // The database in use is the test's own on this server, with rows in it.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-move-'));
    folders.push(dataDir);
    const store = await db.open();
    await fill(store);
    const before = await everyRow(store);
    const move = new DatabaseMove({ dataDir, current: await db.address(), pool: 2 });
    // The same server and database by another name for the host: 127.0.0.1 and localhost.
    const alias = new URL(await db.url());
    alias.hostname = alias.hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1';
    const tested = await move.test(alias.href);
    assert.deepEqual([tested.ok, tested.inUse, tested.problem], [false, true, 'it is the database jukecord uses now']);
    await assert.rejects(move.start(alias.href, true), /it is the database jukecord uses now/);
    assert.deepEqual(await everyRow(store), before);
    // Another database of the same server is another database.
    const other = await move.test(await db.anotherUrl());
    assert.deepEqual([other.ok, other.inUse], [true, false]);
  });
});
