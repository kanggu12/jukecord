import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { listBackups, makeBackup, pruneBackups } from '../../src/app/backups.ts';
import { Store } from '../../src/store/store.ts';

describe('backups in the data folder', () => {
  it('keeps the newest ones and leaves other files alone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-backups-'));
    try {
      // Nine backups a day apart (names sort by time), and a file that is not a backup.
      const names = Array.from({ length: 9 }, (_, day) => `jukecord-2026-11-0${day + 1}T03-00-00-000Z.db`);
      for (const name of [...names, 'notes.txt']) fs.writeFileSync(path.join(dir, name), 'x');
      pruneBackups(dir, 7);
      assert.deepEqual(fs.readdirSync(dir).sort(), [...names.slice(2), 'notes.txt'].sort());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts only its own: a copy put beside them by hand is not the newest, not one of those kept, and stays', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-backups-'));
    try {
      // Three of jukecord's own, a day apart, and files a person put there under names of their own, made now (an
      // unfinished copy of theirs too, from two hours ago).
      const own = [1, 2, 3].map((day) => `jukecord-2026-11-0${day}T03-00-00-000Z.db`);
      const byHand = [
        'jukecord-before-the-move.db',
        'jukecord-old.db',
        'jukecord-2026-11-04.db',
        'jukecord-2026-11-05T03-00-00-000Z.db.bak',
        'jukecord-mine.db.partial',
      ];
      for (const name of [...own, ...byHand]) fs.writeFileSync(path.join(dir, name), 'x');
      const now = Date.now();
      const twoHours = new Date(now - 2 * 3_600_000);
      fs.utimesSync(path.join(dir, 'jukecord-mine.db.partial'), twoHours, twoHours);
      // Its own, newest first, with the time each was made (not the file's, which is now for all of them).
      assert.deepEqual(
        listBackups(dir).map((backup) => [path.basename(backup.file), backup.at]),
        [3, 2, 1].map((day) => [`jukecord-2026-11-0${day}T03-00-00-000Z.db`, Date.UTC(2026, 10, day, 3)]),
      );
      // Two kept: the oldest of its own goes; the others' files stay, and took no place of the two.
      pruneBackups(dir, 2, now);
      assert.deepEqual(fs.readdirSync(dir).sort(), [...own.slice(1), ...byHand].sort());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('takes no unfinished copy for a backup, and clears one away once it is an hour old', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-backups-'));
    try {
      // jukecord stopped while two backups were written: one an hour and more ago, one now.
      const old = path.join(dir, 'jukecord-2026-11-10T03-00-00-000Z.db.partial');
      const fresh = path.join(dir, 'jukecord-2026-11-11T03-00-00-000Z.db.partial');
      for (const file of [old, fresh]) fs.writeFileSync(file, 'half');
      const now = Date.now();
      fs.utimesSync(old, new Date(now - 2 * 3_600_000), new Date(now - 2 * 3_600_000));
      assert.deepEqual(listBackups(dir), []);
      pruneBackups(dir, 7, now);
      assert.deepEqual(fs.readdirSync(dir), [path.basename(fresh)]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is made beside the main thread, which goes on answering while the copy is written', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-backups-'));
    const store = await Store.open(path.join(dir, 'jukecord.db'));
    try {
      // Some tracks, so the copy has something to write.
      await store.sql.exec('CREATE TABLE filler (b BLOB)');
      await store.transaction(async () => {
        for (let i = 0; i < 2000; i += 1)
          await store.sql.run('INSERT INTO filler VALUES (?)', [Buffer.alloc(4096, i % 251)]);
      });
      // A turn of the event loop asked for as the backup starts: made in the main thread, the copy held the loop for
      // its whole length (seconds for a large database: the voices' audio stood still, and past thirty the watchdog
      // ended jukecord), and the turn came only after it.
      let turned = false;
      setImmediate(() => {
        turned = true;
      });
      const made = await Promise.resolve(makeBackup(store, path.join(dir, 'backups'), 7)).then((backup) => ({
        backup,
        turned,
      }));
      assert.equal(made.turned, true);
      // A whole copy, which opens and holds the tracks.
      assert.equal(listBackups(path.join(dir, 'backups')).length, 1);
      const copy = await Store.open(made.backup.file);
      assert.equal((await copy.sql.get('SELECT count(*) AS n FROM filler'))?.n, 2000);
      await copy.close();
    } finally {
      await store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
