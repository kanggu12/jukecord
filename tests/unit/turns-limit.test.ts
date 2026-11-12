/**
 * Taking turns and the limit of tracks per person, through the actions: where added tracks land, what is left out and
 * why, and who may change either.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type ActionContext, ActionError, Actions } from '../../src/app/actions.ts';
import { Bus } from '../../src/core/bus.ts';
import { Players } from '../../src/core/players.ts';
import { QueueService } from '../../src/core/queue.ts';
import type { Track } from '../../src/core/types.ts';
import { createLogger } from '../../src/log.ts';
import type { Resolver } from '../../src/media/resolver.ts';
import { FakeClock, FakeMedia } from '../support/fakes.ts';
import { addTracks, memoryStore } from '../support/store.ts';

const GUILD = '100000000000000001';
const person = (userId: string): ActionContext => ({ guildId: GUILD, userId, mayControl: true, mayManage: false });
const [ANN, BEN, CAT] = [person('300000000000000001'), person('300000000000000002'), person('300000000000000003')];
const MANAGER: ActionContext = { guildId: GUILD, userId: '300000000000000009', mayControl: true, mayManage: true };
const HOST: ActionContext = { guildId: GUILD, userId: null, mayControl: true, mayManage: true };

// Actions over a real queue, with inputs that find one track each ("t1" ...) or five ("five"), and nothing playing.
function setup() {
  const clock = new FakeClock();
  const store = memoryStore(() => clock.now());
  const bus = new Bus();
  const queue = new QueueService(store.queue, bus);
  const media = new FakeMedia();
  const log = createLogger({ level: 'error', sinks: [] });
  const players = new Players({
    queue,
    media,
    history: store.history,
    state: store.playerState,
    bus,
    clock,
    log,
    fetchTimeoutMs: 60_000,
  });
  const tracks = addTracks(store, 20);
  const resolver = {
    resolve: async (input: string): Promise<Track[]> =>
      input === 'five' ? tracks.slice(10, 15) : [tracks[Number(input.slice(1)) - 1] as Track],
  } as unknown as Resolver;
  const actions = new Actions({ store, queue, players, resolver, log });
  // Who added each queued track, in order, by the first letter of their name (the host as "h").
  const names = new Map([
    [ANN.userId, 'a'],
    [BEN.userId, 'b'],
    [CAT.userId, 'c'],
  ]);
  const owners = () =>
    queue
      .list(GUILD)
      .map((item) => (item.addedBy === null ? 'h' : (names.get(item.addedBy) ?? '?')))
      .join('');
  return { store, queue, players, actions, owners };
}

// The code and message of an action's refusal.
async function refusal(fn: () => unknown): Promise<string> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ActionError) return `${error.code}: ${error.message}`;
    throw error;
  }
  return 'none';
}

describe('taking turns, through the actions', () => {
  it("puts each person's tracks in turn once it is on, the track playing as its person's turn", async () => {
    const { actions, owners } = setup();
    actions.takeTurns(MANAGER, true);
    // Ann's first plays at once; her next ones wait.
    await actions.add(ANN, 't1');
    await actions.add(ANN, 't2');
    await actions.add(ANN, 't3');
    assert.equal(owners(), 'aa');
    // Ben's first goes before Ann's next (Ann's turn is under way), Cat's after Ben's.
    const ben = await actions.add(BEN, 't4');
    assert.equal(owners(), 'baa');
    // The answer says where the track went.
    assert.equal(ben.items[0]?.position, 0);
    await actions.add(CAT, 't5');
    assert.equal(owners(), 'bcaa');
    // A playlist of Ben's goes in his turns, one per round.
    await actions.playlistSave(BEN, 'mine');
    await actions.playlistLoad(BEN, 'mine');
    assert.equal(owners().slice(0, 5), 'bcaba');
    // Play next keeps its meaning.
    await actions.add(CAT, 't6', 'next');
    assert.equal(owners()[0], 'c');
  });

  it('puts the queue in turns once, with the setting off, and says how many tracks moved', async () => {
    const { actions, owners } = setup();
    // The host's track plays; Ann adds three, Ben two, Cat one, all at the end.
    await actions.add(HOST, 't1');
    for (const input of ['t2', 't3', 't4']) await actions.add(ANN, input);
    for (const input of ['t5', 't6']) await actions.add(BEN, input);
    await actions.add(CAT, 't7');
    assert.equal(owners(), 'aaabbc');
    // Four of the six stand somewhere else now: a b c a b a (the first and the fifth kept their places).
    assert.equal(actions.turnsNow(ANN), 4);
    assert.equal(owners(), 'abcaba');
    // Already in turns: nothing moves.
    assert.equal(actions.turnsNow(ANN), 0);
    // Changing the music needs the DJ role, as everything else does.
    const listener = { ...ANN, mayControl: false };
    assert.match(await refusal(() => actions.turnsNow(listener)), /^forbidden: only members with the DJ role/);
  });

  it('needs Manage Server to turn it on or off', async () => {
    const { actions } = setup();
    assert.equal(
      await refusal(() => actions.takeTurns(ANN, true)),
      'forbidden: only people who can manage the server can change this setting',
    );
    assert.equal(actions.takeTurns(MANAGER, true).takeTurns, true);
    assert.equal(actions.settings(ANN).takeTurns, true);
  });
});

describe('the limit of tracks per person', () => {
  it('adds what fits under the limit and says how many were left out; nothing fitting is refused', async () => {
    const { actions, owners } = setup();
    actions.personLimit(MANAGER, 3);
    // The first track plays at once (it is not waiting in the queue): three more fit.
    await actions.add(ANN, 't1');
    const added = await actions.add(ANN, 'five');
    assert.equal(added.items.length, 3);
    assert.equal(added.skippedLimit, 2);
    assert.equal(owners(), 'aaa');
    assert.equal(
      await refusal(() => actions.add(ANN, 't2')),
      'conflict: each person may have 3 tracks in the queue here',
    );
    // Others have their own room, and the host has no limit.
    assert.equal((await actions.add(BEN, 't3')).skippedLimit, 0);
    assert.equal((await actions.add(HOST, 'five')).skippedLimit, 0);
    // No limit again: everything fits.
    actions.personLimit(MANAGER, 0);
    assert.equal((await actions.add(ANN, 't2')).items.length, 1);
  });

  it('is a whole number from 0 to the size of the queue, set by people who manage the server', async () => {
    const { actions } = setup();
    assert.equal(
      await refusal(() => actions.personLimit(MANAGER, 1001)),
      'invalid: the limit is 0 (none) to 1000 tracks',
    );
    assert.equal(
      await refusal(() => actions.personLimit(MANAGER, 2.5)),
      'invalid: the limit is 0 (none) to 1000 tracks',
    );
    assert.match(await refusal(() => actions.personLimit(ANN, 2)), /^forbidden: only people who can manage/);
    assert.equal(actions.personLimit(HOST, 5).personLimit, 5);
  });
});
