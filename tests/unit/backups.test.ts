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
    const store = Store.open(path.join(dir, 'jukecord.db'));
    try {
      // Some tracks, so the copy has something to write.
      store.db.exec('CREATE TABLE filler (b BLOB)');
      store.transaction(() => {
        const insert = store.db.prepare('INSERT INTO filler VALUES (?)');
        for (let i = 0; i < 2000; i += 1) insert.run(Buffer.alloc(4096, i % 251));
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
      const copy = Store.open(made.backup.file);
      assert.equal((copy.db.prepare('SELECT count(*) AS n FROM filler').get() as { n: number }).n, 2000);
      copy.close();
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
