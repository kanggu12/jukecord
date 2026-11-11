import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Access, LOCAL_GUILD } from '../../src/app/access.ts';
import { ActionError } from '../../src/app/actions.ts';
import { memoryStore } from '../support/store.ts';
import { ALICE, BOB, DJ_ROLE, FakeDirectory, GUILD, OTHER_GUILD } from '../support/web.ts';

function setup(browserOnly = false) {
  const store = memoryStore();
  const directory = new FakeDirectory();
  let now = 0;
  const access = new Access({
    settings: store.settings,
    directory: () => (browserOnly ? null : directory),
    now: () => now,
  });
  return { store, directory, access, advance: (ms: number) => (now += ms) };
}

const code = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return 'none';
  } catch (error) {
    return error instanceof ActionError ? error.code : String(error);
  }
};

describe('Access', () => {
  it('lets the host do everything in every server the bot is in, and nothing in others', async () => {
    const { access } = setup();
    const guilds = await access.guilds({ kind: 'host' });
    assert.deepEqual(
      guilds.map((guild) => [guild.id, guild.mayControl, guild.mayManage]),
      [
        [GUILD, true, true],
        [OTHER_GUILD, true, true],
      ],
    );
    assert.equal((await access.context({ kind: 'host' }, GUILD)).mayManage, true);
    assert.equal(await code(() => access.context({ kind: 'host' }, '199999999999999999')), 'not-found');
  });

  it('gives a member control unless a DJ role is set, and the settings only with Manage Server', async () => {
    const { store, directory, access } = setup();
    directory.join(GUILD, ALICE);
    directory.join(GUILD, BOB, { roles: [DJ_ROLE] });
    assert.deepEqual(await access.context({ kind: 'user', userId: ALICE }, GUILD), {
      guildId: GUILD,
      userId: ALICE,
      mayControl: true,
      mayManage: false,
    });
    store.settings.setDjRole(GUILD, DJ_ROLE);
    assert.equal((await access.context({ kind: 'user', userId: ALICE }, GUILD)).mayControl, false);
    assert.equal((await access.context({ kind: 'user', userId: BOB }, GUILD)).mayControl, true);
    // Only the servers the person is in are listed.
    assert.deepEqual(
      (await access.guilds({ kind: 'user', userId: ALICE })).map((guild) => guild.id),
      [GUILD],
    );
    assert.equal(await code(() => access.context({ kind: 'user', userId: ALICE }, OTHER_GUILD)), 'forbidden');
  });

  it('lets Manage Server change the music even with a DJ role set', async () => {
    const { store, directory, access } = setup();
    store.settings.setDjRole(GUILD, DJ_ROLE);
    directory.join(GUILD, ALICE, { manage: true });
    const context = await access.context({ kind: 'user', userId: ALICE }, GUILD);
    assert.equal(context.mayControl, true);
    assert.equal(context.mayManage, true);
  });

  it('asks Discord once a minute per person and server, and once for questions asked together', async () => {
    const { directory, access, advance } = setup();
    directory.join(GUILD, ALICE);
    await Promise.all([1, 2, 3].map(() => access.context({ kind: 'user', userId: ALICE }, GUILD)));
    assert.equal(directory.asked, 1);
    advance(59_000);
    await access.context({ kind: 'user', userId: ALICE }, GUILD);
    assert.equal(directory.asked, 1);
    // A role taken away shows within a minute.
    directory.members.delete(`${GUILD}:${ALICE}`);
    advance(2_000);
    assert.equal(await code(() => access.context({ kind: 'user', userId: ALICE }, GUILD)), 'forbidden');
    assert.equal(directory.asked, 2);
  });

  it('says Discord is not answering instead of locking people out', async () => {
    const { directory, access } = setup();
    directory.down = true;
    assert.equal(await code(() => access.context({ kind: 'user', userId: ALICE }, GUILD)), 'unavailable');
  });

  it('has one local server in browser-only mode, for the host only', async () => {
    const { access } = setup(true);
    assert.deepEqual(
      (await access.guilds({ kind: 'host' })).map((guild) => guild.id),
      [LOCAL_GUILD.id],
    );
    assert.deepEqual(await access.guilds({ kind: 'user', userId: ALICE }), []);
    assert.equal((await access.context({ kind: 'host' }, 'local')).mayControl, true);
    assert.equal(await code(() => access.context({ kind: 'host' }, GUILD)), 'not-found');
    assert.equal(await code(() => access.context({ kind: 'user', userId: ALICE }, 'local')), 'forbidden');
  });
});
