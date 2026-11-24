/**
 * `jukecord db status` and `jukecord db copy`, run as the command runs them (src/cli/main.ts), on SQLite files and on
 * each server of JUKECORD_TEST_DATABASES: what they say, their exit codes, the configured database as the default, an
 * old backup copied without being changed, and no password in anything they print.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';
import { run } from '../../src/cli/main.ts';
import { MIGRATIONS } from '../../src/store/schema.ts';
import { Store } from '../../src/store/store.ts';
import { eachDatabase } from '../support/databases.ts';
import { everyRow, fill } from '../support/fill.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-db-cli-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

// The command with these words, in a data folder of its own, with what it printed.
async function db(
  words: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(['db', ...words], { JUKECORD_DATA_DIR: path.join(dir, 'data'), ...env }, (text, error) =>
    (error ? err : out).push(text),
  );
  return { code, out: out.join('\n'), err: err.join('\n') };
}

// A SQLite file at the latest schema with a row in every table.
async function filled(name: string): Promise<string> {
  const file = path.join(dir, name);
  const store = await Store.open(file);
  await fill(store);
  await store.close();
  return file;
}

describe('jukecord db', () => {
  it('says the kind, the version, the schema, the size and the rows of a database, also as JSON', async () => {
    const file = await filled('status.db');
    const said = await db(['status', `sqlite:${file}`]);
    assert.equal(said.code, 0, said.err);
    assert.match(said.out, /^Database: SQLite \(.*status\.db\)\nServer: SQLite \d+\.\d+/);
    assert.match(said.out, /Schema: 8, this jukecord's/);
    assert.match(said.out, /Rows: \d+ \(4 tracks, 4 plays, 5 queued, 3 playlists\)/);
    const json = JSON.parse((await db(['status', '--json', `sqlite:${file}`])).out);
    assert.deepEqual([json.backend, json.schema, json.latestSchema, json.rows.likes], ['sqlite', 8, 8, 2]);
  });

  it('looks at the configured database when it names none, the data folder’s jukecord.db by default', async () => {
    const configured = await filled('configured.db');
    const said = await db(['status'], { JUKECORD_DATABASE_URL: `sqlite:${configured}` });
    assert.equal(said.code, 0, said.err);
    assert.match(said.out, /configured\.db/);
    // The default file is not made by looking for it.
    const none = await db(['status']);
    assert.deepEqual([none.code, /there is no database at .*jukecord\.db/.test(none.err)], [1, true]);
    assert.equal(fs.existsSync(path.join(dir, 'data', 'jukecord.db')), false);
  });

  it('copies into another database, refuses one with data unless told to replace it, and never into itself', async () => {
    const from = await filled('from.db');
    const to = path.join(dir, 'to.db');
    const copied = await db(['copy', `sqlite:${from}`, `sqlite:${to}`]);
    assert.equal(copied.code, 0, copied.err);
    assert.match(copied.out, /^Copied \d+ rows in [\d.]+ s\n {2}from SQLite .*\n {2}to {3}SQLite /);
    const again = await db(['copy', `sqlite:${from}`, `sqlite:${to}`]);
    assert.deepEqual([again.code, /already holds jukecord's data .* give --replace/.test(again.err)], [1, true]);
    assert.equal((await db(['copy', `sqlite:${from}`, `sqlite:${to}`, '--replace'])).code, 0);
    const itself = await db(['copy', `sqlite:${from}`, `sqlite:${from}`]);
    assert.deepEqual([itself.code, itself.err], [1, 'jukecord db: the source and the target are the same database']);
    // Into the configured database when no target is named.
    const configured = path.join(dir, 'into-configured.db');
    assert.equal((await db(['copy', `sqlite:${from}`], { JUKECORD_DATABASE_URL: `sqlite:${configured}` })).code, 0);
    const a = await Store.open(from);
    const b = await Store.open(configured);
    try {
      assert.deepEqual(await everyRow(b), await everyRow(a));
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('copies an older jukecord’s backup brought up to date, without changing the backup', async () => {
    // A backup as 0.2.1 wrote it (schema 3), with a track and a play.
    const old = path.join(dir, 'old.db');
    const sqlite = new DatabaseSync(old);
    for (const migration of MIGRATIONS.filter((entry) => entry.version <= 3)) sqlite.exec(migration.sql);
    sqlite.exec(`PRAGMA user_version = 3;
      INSERT INTO tracks (source, url, title, created_at, updated_at) VALUES ('s', 'u', 'Old track', 1, 1);
      INSERT INTO history (guild_id, track_id, added_by, played_at, played_ms) VALUES ('g', 1, NULL, 2, 3);`);
    sqlite.close();
    const target = path.join(dir, 'from-old.db');
    const copied = await db(['copy', `sqlite:${old}`, `sqlite:${target}`]);
    assert.equal(copied.code, 0, copied.err);
    const check = new DatabaseSync(old, { readOnly: true });
    assert.equal((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 3);
    check.close();
    const store = await Store.open(target);
    assert.equal((await store.tracks.get(1))?.title, 'Old track');
    await store.close();
    // The brought-up-to-date copy it read from is gone.
    assert.deepEqual(
      fs.readdirSync(path.join(dir, 'data')).filter((name) => name.startsWith('.jukecord-copy-')),
      [],
    );
  });

  it('copies from a backup and looks at it without changing it: its bytes, its mode, its journal', async (t) => {
    // A backup as jukecord writes one (VACUUM INTO: a rollback journal, no log beside it), kept read-only.
    const live = await filled('source-live.db');
    const store = await Store.open(live);
    const backup = path.join(dir, 'source-backup.db');
    await store.backup(backup);
    await store.close();
    fs.chmodSync(backup, 0o444);
    const state = () => ({
      bytes: crypto.createHash('sha256').update(fs.readFileSync(backup)).digest('hex'),
      mode: fs.statSync(backup).mode & 0o777,
      // Bytes 18 and 19 of the header: 1 and 1 for a rollback journal, 2 and 2 for a write-ahead log.
      journal: [...fs.readFileSync(backup).subarray(18, 20)],
      beside: fs.readdirSync(dir).filter((name) => name.startsWith('source-backup.db')),
    });
    const before = state();
    assert.deepEqual([before.mode, before.journal, before.beside], [0o444, [1, 1], ['source-backup.db']]);
    const copied = await db(['copy', `sqlite:${backup}`, `sqlite:${path.join(dir, 'source-copy.db')}`]);
    assert.equal(copied.code, 0, copied.err);
    assert.equal((await db(['status', `sqlite:${backup}`])).code, 0);
    assert.deepEqual(state(), before);
    // A backup nobody may write at all, not even root (immutable): copied all the same. Where the system lets this
    // user make a file immutable (root on a file system that has the flag).
    try {
      execFileSync('chattr', ['+i', backup], { stdio: 'ignore' });
    } catch {
      t.diagnostic('chattr +i is not allowed here; the immutable backup is not tried');
      return;
    }
    try {
      const immutable = await db(['copy', `sqlite:${backup}`, `sqlite:${path.join(dir, 'source-copy-2.db')}`]);
      assert.equal(immutable.code, 0, immutable.err);
      assert.deepEqual(state(), before);
    } finally {
      execFileSync('chattr', ['-i', backup], { stdio: 'ignore' });
    }
  });

  it('says a failure on one line with what it is about, and leaves no target file it made', async () => {
    // A damaged source: a queued track that no track row has (written with the foreign keys off).
    const broken = await filled('broken.db');
    const raw = new DatabaseSync(broken);
    raw.exec('PRAGMA foreign_keys = OFF');
    raw.exec(
      "INSERT INTO queue_items (guild_id, position, track_id, added_by, added_at) VALUES ('g', 99, 99999, NULL, 1)",
    );
    raw.close();
    const target = path.join(dir, 'broken-copy.db');
    const copied = await db(['copy', `sqlite:${broken}`, `sqlite:${target}`]);
    assert.equal(copied.code, 1);
    assert.match(copied.err, /^jukecord db: copying into SQLite \(.*broken-copy\.db\): .*FOREIGN KEY/);
    assert.equal(copied.err.split('\n').length, 1);
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.startsWith('broken-copy.db')),
      [],
    );
    // A file that is no database at all, looked at and copied from: its name and SQLite's reason, nothing made.
    const junk = path.join(dir, 'junk.db');
    fs.writeFileSync(junk, 'not a database at all, but long enough to be read as a header by SQLite\n'.repeat(4));
    const looked = await db(['status', `sqlite:${junk}`]);
    assert.deepEqual([looked.code, looked.err], [1, `jukecord db: SQLite (${junk}): file is not a database`]);
    const fromJunk = await db(['copy', `sqlite:${junk}`, `sqlite:${path.join(dir, 'from-junk.db')}`]);
    assert.equal(fromJunk.code, 1);
    assert.match(fromJunk.err, /^jukecord db: the source, SQLite \(.*junk\.db\): file is not a database$/);
    assert.equal(fs.existsSync(path.join(dir, 'from-junk.db')), false);
  });

  it('makes every SQLite file it writes this user’s alone, whatever the umask of the shell it runs in', async () => {
    const was = process.umask(0o022);
    try {
      const from = await filled('modes-from.db');
      const to = path.join(dir, 'modes-to.db');
      const copied = await db(['copy', `sqlite:${from}`, `sqlite:${to}`]);
      assert.equal(copied.code, 0, copied.err);
      // The copy, and the log files beside it while it is open (SQLite gives them the database's mode).
      for (const name of fs.readdirSync(dir).filter((entry) => entry.startsWith('modes-to.db'))) {
        assert.equal((fs.statSync(path.join(dir, name)).mode & 0o777).toString(8), '600', name);
      }
      // Backups, the main thread's and the worker's.
      const store = await Store.open(from);
      try {
        await store.backup(path.join(dir, 'modes-backup.db'));
        await store.backupAside(path.join(dir, 'modes-backup-aside.db'));
      } finally {
        await store.close();
      }
      for (const name of ['modes-backup.db', 'modes-backup-aside.db']) {
        assert.equal((fs.statSync(path.join(dir, name)).mode & 0o777).toString(8), '600', name);
      }
    } finally {
      process.umask(was);
    }
  });

  it('says a typing mistake with 2, a database it cannot reach with 3, never with a password', async () => {
    const said = await Promise.all([
      db([]),
      db(['frob']),
      db(['copy']),
      db(['status', '--replace']),
      db(['status', 'postgres://music:hunter2@db']),
      db(['status', '--frob']),
      // Passwords not percent-encoded, with / (base64), ? and # in them: no address, and still no password said.
      db(['status', 'postgres://music:hunt/er2@db/j']),
      db(['status', 'mysql://music:hu?nt#er2@db/j']),
    ]);
    assert.deepEqual(
      said.map((answer) => answer.code),
      [2, 2, 2, 2, 2, 2, 2, 2],
    );
    assert.match(said[4]?.err ?? '', /"postgres:\/\/music:…@db" names no database/);
    assert.match(said[6]?.err ?? '', /"postgres:\/\/music:…@db\/j"/);
    for (const answer of said.slice(6)) assert.doesNotMatch(answer.err, /hunt|er2|hu\?nt/);
    // A certificate file that is not there: a database not reachable, said at once (waiting would not mend it).
    const unreachable = await db([
      'status',
      'mysql://music:hunter2@127.0.0.1:1/j?ssl-mode=VERIFY_CA&ssl-ca=/nowhere.pem',
    ]);
    assert.deepEqual([unreachable.code, /sslrootcert\) file \/nowhere\.pem/.test(unreachable.err)], [3, true]);
    for (const answer of [...said, unreachable]) assert.doesNotMatch(`${answer.out}${answer.err}`, /hunter2/);
    // Under --json a failure is JSON too, with its code.
    assert.deepEqual(JSON.parse((await db(['frob', '--json'])).err), {
      error: { code: 'usage', message: 'there is no db command "frob" (db status, db copy)' },
    });
  });
});

eachDatabase('jukecord db on a database', (database) => {
  it('copies a SQLite file in and out again, and says its status', async () => {
    // Files of this database's own (two servers of a kind each have a suite).
    const tag = database.name.replace(/[^a-z0-9]+/gi, '-');
    const from = await filled(`out-${tag}.db`);
    const url = await database.url();
    const into = await db(['copy', `sqlite:${from}`, url]);
    assert.equal(into.code, 0, into.err);
    const status = await db(['status', url]);
    assert.equal(status.code, 0, status.err);
    assert.match(status.out, /Schema: 8, this jukecord's/);
    assert.doesNotMatch(status.out, /:jukecord@/);
    const back = path.join(dir, `back-${tag}.db`);
    assert.equal((await db(['copy', url, `sqlite:${back}`])).code, 0);
    const a = await Store.open(from);
    const b = await Store.open(back);
    try {
      assert.deepEqual(await everyRow(b), await everyRow(a));
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('writes a backup of the database this user’s alone, whatever the umask', async () => {
    const tag = database.name.replace(/[^a-z0-9]+/gi, '-');
    const was = process.umask(0o022);
    try {
      const store = await database.open();
      const target = path.join(dir, `backup-mode-${tag}.db`);
      await store.backupAside(target);
      assert.equal((fs.statSync(target).mode & 0o777).toString(8), '600');
    } finally {
      process.umask(was);
    }
  });
});
