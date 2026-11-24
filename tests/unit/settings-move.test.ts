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
import { after, it } from 'node:test';
import { DatabaseMove, type MoveState } from '../../src/settings/move.ts';
import { defaultSqliteFile } from '../../src/store/address.ts';
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
});
