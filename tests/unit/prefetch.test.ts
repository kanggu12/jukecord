import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Bus } from '../../src/core/bus.ts';
import { Players } from '../../src/core/players.ts';
import { QueueService } from '../../src/core/queue.ts';
import { createLogger } from '../../src/log.ts';
import { MediaCache } from '../../src/media/cache.ts';
import { Prefetcher } from '../../src/media/prefetch.ts';
import { FakeClock, FakeMedia } from '../support/fakes.ts';
import { addTracks, memoryStore } from '../support/store.ts';

const GUILD = '100000000000000001';
const log = createLogger({ level: 'error', sinks: [] });
let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-prefetch-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function setup(count: number) {
  const clock = new FakeClock();
  const store = memoryStore(() => clock.now());
  const bus = new Bus();
  const queue = new QueueService(store.queue, bus);
  // The player gets its own fake so the test only sees the prefetcher's calls on `media`.
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
  const cache = new MediaCache({ dir, maxBytes: 1024 ** 3, log });
  cache.init();
  const media = new FakeMedia();
  const prefetcher = new Prefetcher({ bus, players, queue, media, cache, clock, log, count });
  prefetcher.start();
  return { clock, store, queue, media, cache, prefetcher, tracks: addTracks(store, 5) };
}

describe('Prefetcher', () => {
  it('fetches the next tracks one at a time after a burst of changes settles', async () => {
    const { clock, queue, media, tracks } = setup(2);
    for (const track of tracks) queue.add(GUILD, [track.id], 'end', null);
    // Nothing happens during the burst.
    assert.equal(media.calls.length, 0);
    await clock.advance(300);
    assert.deepEqual(
      media.calls.map((call) => call.track.title),
      ['Track 1'],
    );
    media.finish(1000);
    await clock.advance(0);
    assert.deepEqual(
      media.calls.map((call) => call.track.title),
      ['Track 1', 'Track 2'],
    );
  });

  it('pins what it plans to keep and drops a fetch the queue no longer wants', async () => {
    const { clock, queue, media, cache, tracks } = setup(1);
    const [first, second] = tracks;
    assert.ok(first && second);
    const [item] = queue.add(GUILD, [first.id], 'end', null);
    await clock.advance(300);
    const fetching = media.last();
    assert.equal(fetching.track.id, first.id);
    // Replaced by another track: the old fetch is cancelled, the new one starts, and the pin moves.
    assert.ok(item);
    queue.remove(GUILD, item.id);
    queue.add(GUILD, [second.id], 'end', null);
    await clock.advance(300);
    assert.equal(fetching.signal.aborted, true);
    assert.equal(media.last().track.id, second.id);
    // Pinned keys survive an eviction pass even with a tiny limit; the test reads the pin through evict().
    assert.equal(cache.has(MediaCache.keyOf(second.source)), false);
  });
});
