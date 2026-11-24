import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Bus, type QueueChanged } from '../../src/core/bus.ts';
import { GuildLanes } from '../../src/core/lanes.ts';
import { QueueService } from '../../src/core/queue.ts';
import { addTracks, memoryStore } from '../support/store.ts';

const GUILD = '100000000000000001';

async function setup(count: number) {
  const store = await memoryStore();
  const bus = new Bus();
  const events: QueueChanged[] = [];
  bus.on('queue', (event) => events.push(event));
  const lanes = new GuildLanes();
  const queue = new QueueService(store.queue, bus, lanes);
  const tracks = await addTracks(store, count);
  return { store, bus, events, queue, tracks };
}

describe('QueueService', () => {
  it('announces each change once with a growing version', async () => {
    const { queue, events, tracks } = await setup(3);
    const ids = tracks.map((track) => track.id);
    await queue.add(GUILD, ids, 'end', 'u1');
    await queue.add(GUILD, [], 'end', 'u1');
    const first = (await queue.list(GUILD))[0];
    assert.ok(first);
    await queue.remove(GUILD, first.id);
    // Removing something already gone is not a change.
    await queue.remove(GUILD, first.id);
    assert.deepEqual(
      events.map((event) => event.version),
      [1, 2],
    );
    assert.equal(queue.version(GUILD), 2);
  });

  it('adds next or at a position', async () => {
    const { queue, tracks } = await setup(3);
    const [a, b, c] = tracks;
    assert.ok(a && b && c);
    await queue.add(GUILD, [a.id], 'end', null);
    await queue.add(GUILD, [b.id], 'next', null);
    await queue.add(GUILD, [c.id], 1, null);
    assert.deepEqual(
      (await queue.list(GUILD)).map((item) => item.track.title),
      ['Track 2', 'Track 3', 'Track 1'],
    );
  });

  it('shuffles with Fisher-Yates using the random source it is given', async () => {
    const { queue, tracks } = await setup(4);
    await queue.add(
      GUILD,
      tracks.map((track) => track.id),
      'end',
      null,
    );
    // A source that always returns 0 swaps each place with the first: [1,2,3,4] becomes [2,3,4,1].
    await queue.shuffle(GUILD, () => 0);
    assert.deepEqual(
      (await queue.list(GUILD)).map((item) => item.track.title),
      ['Track 2', 'Track 3', 'Track 4', 'Track 1'],
    );
  });

  it('removes later duplicates and keeps the first copy where it was', async () => {
    const { queue, tracks } = await setup(2);
    const [a, b] = tracks;
    assert.ok(a && b);
    await queue.add(GUILD, [a.id, b.id, a.id, a.id, b.id], 'end', null);
    assert.equal(await queue.dedupe(GUILD), 3);
    assert.deepEqual(
      (await queue.list(GUILD)).map((item) => item.track.title),
      ['Track 1', 'Track 2'],
    );
    assert.equal(await queue.dedupe(GUILD), 0);
  });

  it('removes 900 duplicates of a thousand-track queue at once, with one event, in a few milliseconds', async () => {
    const { queue, events, tracks } = await setup(100);
    const ids = tracks.map((track) => track.id);
    // The same hundred tracks ten times over.
    for (let round = 0; round < 10; round += 1) await queue.add(GUILD, ids, 'end', null);
    const before = events.length;
    const started = performance.now();
    assert.equal(await queue.dedupe(GUILD), 900);
    const took = performance.now() - started;
    assert.equal(events.length, before + 1, 'one change, announced once');
    assert.deepEqual(
      (await queue.list(GUILD)).map((item) => item.position),
      ids.map((_, index) => index),
    );
    // Removing them one by one, each with its own renumbering, took most of a second; the bound leaves room for a slow
    // machine while still failing that.
    assert.ok(took < 250, `dedupe took ${Math.round(took)} ms`);
  });

  it('shifts the next item out for the player and clears', async () => {
    const { queue, tracks } = await setup(2);
    await queue.add(
      GUILD,
      tracks.map((track) => track.id),
      'end',
      null,
    );
    assert.equal((await queue.shift(GUILD))?.track.title, 'Track 1');
    assert.equal(await queue.size(GUILD), 1);
    assert.equal(await queue.clear(GUILD), 1);
    assert.equal(await queue.shift(GUILD), null);
  });
});
