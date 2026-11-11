import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Bus, type QueueChanged } from '../../src/core/bus.ts';
import { QueueService } from '../../src/core/queue.ts';
import { addTracks, memoryStore } from '../support/store.ts';

const GUILD = '100000000000000001';

function setup(count: number) {
  const store = memoryStore();
  const bus = new Bus();
  const events: QueueChanged[] = [];
  bus.on('queue', (event) => events.push(event));
  const queue = new QueueService(store.queue, bus);
  const tracks = addTracks(store, count);
  return { store, bus, events, queue, tracks };
}

describe('QueueService', () => {
  it('announces each change once with a growing version', () => {
    const { queue, events, tracks } = setup(3);
    const ids = tracks.map((track) => track.id);
    queue.add(GUILD, ids, 'end', 'u1');
    queue.add(GUILD, [], 'end', 'u1');
    const first = queue.list(GUILD)[0];
    assert.ok(first);
    queue.remove(GUILD, first.id);
    // Removing something already gone is not a change.
    queue.remove(GUILD, first.id);
    assert.deepEqual(
      events.map((event) => event.version),
      [1, 2],
    );
    assert.equal(queue.version(GUILD), 2);
  });

  it('adds next or at a position', () => {
    const { queue, tracks } = setup(3);
    const [a, b, c] = tracks;
    assert.ok(a && b && c);
    queue.add(GUILD, [a.id], 'end', null);
    queue.add(GUILD, [b.id], 'next', null);
    queue.add(GUILD, [c.id], 1, null);
    assert.deepEqual(
      queue.list(GUILD).map((item) => item.track.title),
      ['Track 2', 'Track 3', 'Track 1'],
    );
  });

  it('shuffles with Fisher-Yates using the random source it is given', () => {
    const { queue, tracks } = setup(4);
    queue.add(
      GUILD,
      tracks.map((track) => track.id),
      'end',
      null,
    );
    // A source that always returns 0 swaps each place with the first: [1,2,3,4] becomes [2,3,4,1].
    queue.shuffle(GUILD, () => 0);
    assert.deepEqual(
      queue.list(GUILD).map((item) => item.track.title),
      ['Track 2', 'Track 3', 'Track 4', 'Track 1'],
    );
  });

  it('removes later duplicates and keeps the first copy where it was', () => {
    const { queue, tracks } = setup(2);
    const [a, b] = tracks;
    assert.ok(a && b);
    queue.add(GUILD, [a.id, b.id, a.id, a.id, b.id], 'end', null);
    assert.equal(queue.dedupe(GUILD), 3);
    assert.deepEqual(
      queue.list(GUILD).map((item) => item.track.title),
      ['Track 1', 'Track 2'],
    );
    assert.equal(queue.dedupe(GUILD), 0);
  });

  it('shifts the next item out for the player and clears', () => {
    const { queue, tracks } = setup(2);
    queue.add(
      GUILD,
      tracks.map((track) => track.id),
      'end',
      null,
    );
    assert.equal(queue.shift(GUILD)?.track.title, 'Track 1');
    assert.equal(queue.size(GUILD), 1);
    assert.equal(queue.clear(GUILD), 1);
    assert.equal(queue.shift(GUILD), null);
  });
});
