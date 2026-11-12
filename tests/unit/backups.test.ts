import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pruneBackups } from '../../src/app/backups.ts';

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
});
