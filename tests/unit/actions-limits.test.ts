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
import { memoryStore } from '../support/store.ts';

const GUILD = '100000000000000001';
const DJ: ActionContext = { guildId: GUILD, userId: '300000000000000001', mayControl: true };

// Tracks of the given lengths, found for any input.
function setup(lengths: (number | null)[], limits: { queueMax: number; trackMaxMs: number }) {
  const clock = new FakeClock();
  const store = memoryStore(() => clock.now());
  const bus = new Bus();
  const queue = new QueueService(store.queue, bus);
  const log = createLogger({ level: 'error', sinks: [] });
  const players = new Players({
    queue,
    media: new FakeMedia(),
    history: store.history,
    state: store.playerState,
    bus,
    clock,
    log,
    fetchTimeoutMs: 60_000,
  });
  const tracks: Track[] = lengths.map((durationMs, index) =>
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
  return { queue, actions: new Actions({ store, queue, players, resolver, log, ...limits }) };
}

describe('Actions limits', () => {
  it('leaves out tracks over the length limit and says how many', async () => {
    const { actions } = setup([60_000, 4 * 3_600_000, null], { queueMax: 100, trackMaxMs: 3 * 3_600_000 });
    const result = await actions.add(DJ, 'a list');
    assert.equal(result.items.length, 2);
    assert.equal(result.skippedTooLong, 1);
    assert.equal(result.skippedFull, 0);
  });

  it('fills the queue up to its limit and refuses once it is full', async () => {
    const { actions, queue } = setup([60_000, 60_000, 60_000], { queueMax: 2, trackMaxMs: 3_600_000 });
    // Two of three fit; the first then becomes current and leaves the queue, which makes room for one more.
    const first = await actions.add(DJ, 'a list');
    assert.equal(first.items.length, 2);
    assert.equal(first.skippedFull, 1);
    const second = await actions.add(DJ, 'more');
    assert.equal(second.items.length, 1);
    assert.equal(second.skippedFull, 2);
    assert.equal(queue.size(GUILD), 2);
    await assert.rejects(
      actions.add(DJ, 'again'),
      (error: unknown) => error instanceof ActionError && error.code === 'conflict',
    );
  });

  it('refuses a single track that is too long', async () => {
    const { actions } = setup([5 * 3_600_000], { queueMax: 100, trackMaxMs: 3_600_000 });
    await assert.rejects(actions.add(DJ, 'a long mix'), /60 minute limit/);
  });

  it('sets repeat modes and refuses unknown ones', async () => {
    const { actions } = setup([60_000], { queueMax: 100, trackMaxMs: 3_600_000 });
    assert.equal(actions.repeat(DJ, 'queue').repeat, 'queue');
    assert.throws(
      () => actions.repeat(DJ, 'forever'),
      (error: unknown) => error instanceof ActionError && error.code === 'invalid',
    );
  });
});
