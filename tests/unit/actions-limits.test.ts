import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type ActionContext, ActionError, Actions } from '../../src/app/actions.ts';
import { Bus } from '../../src/core/bus.ts';
import { GuildLanes } from '../../src/core/lanes.ts';
import { Players } from '../../src/core/players.ts';
import { QueueService } from '../../src/core/queue.ts';
import type { Track } from '../../src/core/types.ts';
import { createLogger } from '../../src/log.ts';
import type { Resolver } from '../../src/media/resolver.ts';
import { FakeClock, FakeMedia } from '../support/fakes.ts';
import { inOrder, memoryStore } from '../support/store.ts';

const GUILD = '100000000000000001';
const DJ: ActionContext = { guildId: GUILD, userId: '300000000000000001', mayControl: true, mayManage: false };

// Tracks of the given lengths, found for any input.
async function setup(lengths: (number | null)[], limits: { queueMax: number; trackMaxMs: number }) {
  const clock = new FakeClock();
  const store = await memoryStore(() => clock.now());
  const bus = new Bus();
  const lanes = new GuildLanes();
  const queue = new QueueService(store.queue, bus, lanes);
  const log = createLogger({ level: 'error', sinks: [] });
  const players = new Players({
    lanes,
    queue,
    media: new FakeMedia(),
    history: store.history,
    state: store.playerState,
    bus,
    clock,
    log,
    fetchTimeoutMs: 60_000,
  });
  const tracks: Track[] = await inOrder(lengths, (durationMs, index) =>
    store.tracks.upsert({
      source: `https://example.com/${index}`,
      url: `https://example.com/${index}`,
      title: `T${index}`,
      uploader: null,
      durationMs,
      thumbnail: null,
    }),
  );
  const resolver = { resolve: async () => tracks } as unknown as Resolver;
  return { queue, actions: new Actions({ lanes, store, queue, players, resolver, log, ...limits }) };
}

describe('Actions limits', () => {
  it('leaves out tracks over the length limit and says how many', async () => {
    const { actions } = await setup([60_000, 4 * 3_600_000, null], { queueMax: 100, trackMaxMs: 3 * 3_600_000 });
    const result = await actions.add(DJ, 'a list');
    assert.equal(result.items.length, 2);
    assert.equal(result.skippedTooLong, 1);
    assert.equal(result.skippedFull, 0);
  });

  it('fills the queue up to its limit and refuses once it is full', async () => {
    const { actions, queue } = await setup([60_000, 60_000, 60_000], { queueMax: 2, trackMaxMs: 3_600_000 });
    // Two of three fit; the first then becomes current and leaves the queue, which makes room for one more.
    const first = await actions.add(DJ, 'a list');
    assert.equal(first.items.length, 2);
    assert.equal(first.skippedFull, 1);
    const second = await actions.add(DJ, 'more');
    assert.equal(second.items.length, 1);
    assert.equal(second.skippedFull, 2);
    assert.equal(await queue.size(GUILD), 2);
    await assert.rejects(
      actions.add(DJ, 'again'),
      (error: unknown) => error instanceof ActionError && error.code === 'conflict',
    );
  });

  it('refuses a single track that is too long', async () => {
    const { actions } = await setup([5 * 3_600_000], { queueMax: 100, trackMaxMs: 3_600_000 });
    await assert.rejects(actions.add(DJ, 'a long mix'), /60 minute limit/);
  });

  it('sets repeat modes and refuses unknown ones', async () => {
    const { actions } = await setup([60_000], { queueMax: 100, trackMaxMs: 3_600_000 });
    assert.equal((await actions.repeat(DJ, 'queue')).repeat, 'queue');
    await assert.rejects(
      () => actions.repeat(DJ, 'forever'),
      (error: unknown) => error instanceof ActionError && error.code === 'invalid',
    );
  });
});
