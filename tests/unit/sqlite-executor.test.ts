import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { StoreError } from '../../src/store/sql.ts';
import { SqliteExecutor } from '../../src/store/sqlite.ts';
import { flush } from '../support/fakes.ts';

// A throwaway database with one table of words.
async function words(): Promise<SqliteExecutor> {
  const sql = SqliteExecutor.open(':memory:');
  await sql.exec('CREATE TABLE words (id INTEGER PRIMARY KEY, word TEXT NOT NULL UNIQUE)');
  return sql;
}

// The words in the table, in the order written.
async function listed(sql: SqliteExecutor): Promise<string[]> {
  return (await sql.all('SELECT word FROM words ORDER BY id')).map((row) => String(row.word));
}

// A promise and the function that settles it, for holding a transaction open halfway.
function gate(): { wait: Promise<void>; open: () => void } {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

describe('SqliteExecutor', () => {
  it('runs statements and says what they changed and which row an insert made', async () => {
    const sql = await words();
    const first = await sql.run('INSERT INTO words (word) VALUES (?)', ['one']);
    assert.deepEqual(first, { changes: 1, lastId: 1 });
    await sql.run('INSERT INTO words (word) VALUES (?)', ['two']);
    assert.deepEqual(
      { ...(await sql.get('SELECT id, word FROM words WHERE word = ?', ['two'])) },
      { id: 2, word: 'two' },
    );
    assert.equal(await sql.get('SELECT id FROM words WHERE word = ?', ['none']), undefined);
    assert.deepEqual(await listed(sql), ['one', 'two']);
    const removed = await sql.run('DELETE FROM words');
    assert.equal(removed.changes, 2);
    // A statement that fails rejects; it never throws at the call.
    const failing = sql.run('INSERT INTO nowhere VALUES (1)');
    await assert.rejects(failing, /no such table/);
    await sql.close();
    assert.equal(sql.isOpen, false);
    await assert.rejects(sql.all('SELECT 1'), /not open/);
  });

  it('opens a file in WAL mode, with foreign keys on and the file for this user alone', {
    skip: process.platform === 'win32',
  }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-sqlite-'));
    try {
      const file = path.join(dir, 'nested', 'jukecord.db');
      const sql = SqliteExecutor.open(file);
      assert.equal((await sql.get('PRAGMA journal_mode'))?.journal_mode, 'wal');
      // NORMAL is 1.
      assert.equal((await sql.get('PRAGMA synchronous'))?.synchronous, 1);
      assert.equal((await sql.get('PRAGMA foreign_keys'))?.foreign_keys, 1);
      await sql.exec('CREATE TABLE t (a INTEGER)');
      await sql.close();
      fs.chmodSync(file, 0o644);
      const again = SqliteExecutor.open(file);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      await again.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a statement from outside an open transaction waiting until the transaction ends', async () => {
    const sql = await words();
    const halfway = gate();
    const goOn = gate();
    const writing = sql.transaction(async () => {
      await sql.run('INSERT INTO words (word) VALUES (?)', ['inside']);
      halfway.open();
      // Open across an await, as a repository method's transaction is.
      await goOn.wait;
      await sql.run('INSERT INTO words (word) VALUES (?)', ['inside again']);
    });
    await halfway.wait;
    // From outside the transaction (this test's own code, not the transaction's): it waits.
    let answered = false;
    const reading = listed(sql).then((found) => {
      answered = true;
      return found;
    });
    const writingOutside = sql.run('INSERT INTO words (word) VALUES (?)', ['outside']);
    await flush();
    assert.equal(answered, false);
    goOn.open();
    await writing;
    // It ran after the commit: it sees all of the transaction and nothing came between its two writes.
    assert.deepEqual(await reading, ['inside', 'inside again']);
    await writingOutside;
    assert.deepEqual(await listed(sql), ['inside', 'inside again', 'outside']);
  });

  it('runs two transactions one after the other, never one inside the other', async () => {
    const sql = await words();
    const order: string[] = [];
    const goOn = gate();
    const first = sql.transaction(async () => {
      order.push('first begins');
      await sql.run('INSERT INTO words (word) VALUES (?)', ['a']);
      await goOn.wait;
      await sql.run('INSERT INTO words (word) VALUES (?)', ['b']);
      order.push('first ends');
    });
    const second = sql.transaction(async () => {
      order.push('second begins');
      await sql.run('INSERT INTO words (word) VALUES (?)', ['c']);
      order.push('second ends');
    });
    await flush();
    goOn.open();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['first begins', 'first ends', 'second begins', 'second ends']);
    assert.deepEqual(await listed(sql), ['a', 'b', 'c']);
  });

  it('makes a nested transaction a savepoint that rolls back alone', async () => {
    const sql = await words();
    await sql.transaction(async () => {
      await sql.run('INSERT INTO words (word) VALUES (?)', ['kept']);
      await assert.rejects(
        sql.transaction(async () => {
          await sql.run('INSERT INTO words (word) VALUES (?)', ['undone']);
          throw new Error('inner failure');
        }),
        /inner failure/,
      );
      // A savepoint inside a savepoint: the inner one's rows are kept with it.
      await sql.transaction(async () => {
        await sql.run('INSERT INTO words (word) VALUES (?)', ['nested']);
        await sql.transaction(() => sql.run('INSERT INTO words (word) VALUES (?)', ['deeper']));
      });
    });
    assert.deepEqual(await listed(sql), ['kept', 'nested', 'deeper']);
  });

  it('rolls a failed transaction back whole, and the next one works', async () => {
    const sql = await words();
    await assert.rejects(
      sql.transaction(async () => {
        await sql.run('INSERT INTO words (word) VALUES (?)', ['lost']);
        await sql.transaction(() => sql.run('INSERT INTO words (word) VALUES (?)', ['lost too']));
        // A constraint the second statement breaks, as a duplicate name does.
        await sql.run('INSERT INTO words (word) VALUES (?)', ['lost']);
      }),
      /UNIQUE/,
    );
    assert.deepEqual(await listed(sql), []);
    const value = await sql.transaction(async () => {
      await sql.run('INSERT INTO words (word) VALUES (?)', ['after']);
      return 'done';
    });
    assert.equal(value, 'done');
    assert.deepEqual(await listed(sql), ['after']);
  });

  it('reports a failed commit, rolls back, and leaves the next transaction working', async () => {
    const sql = await words();
    const db = (sql as unknown as { db: { exec(text: string): void; isTransaction: boolean } }).db;
    // A COMMIT that fails once, as a full disk does in WAL mode.
    const exec = db.exec.bind(db);
    let failNext = true;
    db.exec = (text: string) => {
      if (text === 'COMMIT' && failNext) {
        failNext = false;
        throw new Error('database or disk is full');
      }
      exec(text);
    };
    await assert.rejects(
      sql.transaction(() => sql.run('INSERT INTO words (word) VALUES (?)', ['a'])),
      /disk is full/,
    );
    assert.equal(db.isTransaction, false);
    // The next transaction (and a nested one inside it) works as before.
    await sql.transaction(() => sql.transaction(() => sql.run('INSERT INTO words (word) VALUES (?)', ['b'])));
    assert.deepEqual(await listed(sql), ['b']);
  });

  it('does not count work a transaction started, but did not wait for, as inside it once it has ended', async () => {
    const sql = await words();
    const later = gate();
    let straggler: Promise<unknown> = Promise.resolve();
    await sql.transaction(async () => {
      await sql.run('INSERT INTO words (word) VALUES (?)', ['in']);
      // Started inside, run after the end: a statement of its own, not one inside the ended transaction.
      straggler = later.wait.then(() => sql.run('INSERT INTO words (word) VALUES (?)', ['after']));
    });
    // Another transaction holds the connection when the straggler runs: it waits for that one, like any outsider.
    let seen: unknown[] = ['not asked'];
    const holding = sql.transaction(async () => {
      later.open();
      await flush();
      // Asked inside this transaction: the straggler's row is not here, it waits for the end.
      seen = await sql.all('SELECT word FROM words WHERE word = ?', ['after']);
      await sql.run('INSERT INTO words (word) VALUES (?)', ['held']);
    });
    await holding;
    await straggler;
    assert.deepEqual(seen, []);
    assert.deepEqual(await listed(sql), ['in', 'held', 'after']);
  });

  it('closes once no transaction holds the connection', async () => {
    const sql = await words();
    const goOn = gate();
    const writing = sql.transaction(async () => {
      await goOn.wait;
      await sql.run('INSERT INTO words (word) VALUES (?)', ['written']);
    });
    const closing = sql.close();
    await flush();
    assert.equal(sql.isOpen, true);
    goOn.open();
    await writing;
    await closing;
    assert.equal(sql.isOpen, false);
  });

  it('copies the database with VACUUM INTO, here and in a worker thread', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-sqlite-'));
    try {
      const sql = SqliteExecutor.open(path.join(dir, 'jukecord.db'));
      await sql.exec('CREATE TABLE words (id INTEGER PRIMARY KEY, word TEXT NOT NULL UNIQUE)');
      await sql.run('INSERT INTO words (word) VALUES (?)', ['copied']);
      for (const [name, copy] of [
        ['here.db', (target: string) => sql.vacuumInto(target)],
        ['aside.db', (target: string) => sql.vacuumIntoAside(target)],
      ] as const) {
        const target = path.join(dir, name);
        await copy(target);
        const db = new DatabaseSync(target, { readOnly: true });
        assert.deepEqual({ ...db.prepare('SELECT word FROM words').get() }, { word: 'copied' });
        db.close();
      }
      // The worker's own failure comes back with its reason (the target exists: VACUUM INTO does not overwrite).
      await assert.rejects(sql.vacuumIntoAside(path.join(dir, 'here.db')), StoreError);
      await sql.close();
      // An in-memory database has no file for a worker to open.
      await assert.rejects(SqliteExecutor.open(':memory:').vacuumIntoAside(path.join(dir, 'x.db')), /in-memory/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
