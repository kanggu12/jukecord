/**
 * The host's settings table (migration 10) on every database the tests run on: a database another jukecord of this
 * version left at schema 9 (its member links and all) is brought to 10 at the next start, keeping what it held, and
 * the settings' rows are written, revised and read there as on a new one.
 */
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { MIGRATIONS, VERSION_TABLE } from '../../src/store/schema.ts';
import { RevisionConflict, Store } from '../../src/store/store.ts';
import { eachDatabase } from '../support/databases.ts';

eachDatabase('the host’s settings table', (db) => {
  it('brings a database at schema 9 to 10, its member links kept and the settings table made', async () => {
    const latest = MIGRATIONS.at(-1)?.version ?? 0;
    assert.equal(latest, 10);
    // A database as schema 9 leaves it: every table up to the member links, with a link in it, and no settings table.
    const store = await db.open();
    await store.memberLinks.set('member-key-made-up', '100000000000000001');
    await store.sql.exec('DROP TABLE host_settings');
    if (db.kind === 'sqlite') await store.sql.exec('PRAGMA user_version = 9');
    else await store.sql.run(`UPDATE ${VERSION_TABLE} SET version = ?`, [9]);
    // The next start brings it up to date.
    const again = await Store.open(await db.executor());
    try {
      assert.equal(await again.schemaVersion(), 10);
      assert.equal(await again.memberLinks.get('member-key-made-up'), '100000000000000001');
      assert.deepEqual(await again.hostSettings.all(), []);
      // Written, revised and read there: one revision at a time, a stale one refused whole.
      await again.hostSettings.write([{ name: 'JUKECORD_QUEUE_MAX', value: '50' }]);
      await again.hostSettings.write([{ name: 'JUKECORD_QUEUE_MAX', value: '60' }], { JUKECORD_QUEUE_MAX: 1 });
      await assert.rejects(
        again.hostSettings.write([{ name: 'JUKECORD_QUEUE_MAX', value: '70' }], { JUKECORD_QUEUE_MAX: 1 }),
        RevisionConflict,
      );
      const rows = await again.hostSettings.all();
      assert.deepEqual(
        rows.map((row) => [row.name, row.value, row.revision]),
        [['JUKECORD_QUEUE_MAX', '60', 2]],
      );
    } finally {
      await again.close();
    }
  });
});
