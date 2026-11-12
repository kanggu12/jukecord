import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Bus } from '../../src/core/bus.ts';
import { Players } from '../../src/core/players.ts';
import { QueueService } from '../../src/core/queue.ts';
import type { Track } from '../../src/core/types.ts';
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
  return { clock, store, queue, players, media, cache, prefetcher, tracks: addTracks(store, 5) };
}

// Puts a track in the cache as a finished fetch would (a few bytes stand in for the audio).
function cached(cache: MediaCache, track: Track): void {
  const key = MediaCache.keyOf(track.source);
  const tmp = cache.tmpPath(key);
  fs.writeFileSync(tmp, Buffer.alloc(100, 1));
  cache.commit(key, tmp, { source: track.source, durationMs: 1000, loudness: null });
}

// The keys the cache holds pinned (read from inside: eviction is what uses them).
function pins(cache: MediaCache): string[] {
  return [...(cache as unknown as { pins: Map<string, number> }).pins.keys()];
}

describe('Prefetcher', () => {
  it('fetches the next tracks one at a time after a burst of changes settles', async () => {
    const { clock, queue, players, media, tracks } = setup(2);
    for (const track of tracks) queue.add(GUILD, [track.id], 'end', null);
    // The player starts the first (with its own fetch, which the test leaves loading).
    players.get(GUILD).play();
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
    // Ahead of time: they take their turn after any track somebody waits for, across every server.
    assert.deepEqual(
      media.calls.map((call) => call.priority),
      ['ahead', 'ahead'],
    );
  });

  it('keeps fetching the next track through a pause, a seek or a track added at the end', async () => {
    const { clock, queue, players, media, tracks } = setup(1);
    const [first, second, third] = tracks;
    assert.ok(first && second && third);
    queue.add(GUILD, [first.id, second.id], 'end', null);
    players.get(GUILD).play();
    await clock.advance(300);
    const fetching = media.last();
    assert.equal(fetching.track.id, first.id);
    // A change that leaves the plan's first track where it was: another track at the end.
    queue.add(GUILD, [third.id], 'end', null);
    await clock.advance(300);
    assert.equal(fetching.signal.aborted, false, 'the running download was thrown away');
    assert.equal(media.calls.length, 1, 'the same track was asked for twice');
  });

  it('pins what it plans to keep and drops a fetch the queue no longer wants', async () => {
    const { clock, queue, players, media, cache, tracks } = setup(1);
    const [first, second, third] = tracks;
    assert.ok(first && second && third);
    queue.add(GUILD, [first.id], 'end', null);
    const [item] = queue.add(GUILD, [second.id], 'end', null);
    players.get(GUILD).play();
    // The track playing is cached already: the next one is the one to fetch.
    cached(cache, first);
    await clock.advance(300);
    const fetching = media.last();
    assert.equal(fetching.track.id, second.id);
    assert.deepEqual(pins(cache).sort(), [first, second].map((track) => MediaCache.keyOf(track.source)).sort());
    // Replaced by another track: the old fetch is cancelled, the new one starts, and the pin moves.
    assert.ok(item);
    queue.remove(GUILD, item.id);
    queue.add(GUILD, [third.id], 'end', null);
    await clock.advance(300);
    assert.equal(fetching.signal.aborted, true);
    assert.equal(media.last().track.id, third.id);
    assert.deepEqual(pins(cache).sort(), [first, third].map((track) => MediaCache.keyOf(track.source)).sort());
  });

  it('fetches nothing for a stopped player and lets go of its pins (a server that removed the bot)', async () => {
    const { clock, queue, players, media, cache, tracks } = setup(2);
    queue.add(
      GUILD,
      tracks.map((track) => track.id),
      'end',
      null,
    );
    // A queue with nothing playing (after a restart that found the server idle, say) is not fetched ahead.
    await clock.advance(300);
    assert.equal(media.calls.length, 0);
    const player = players.get(GUILD);
    player.play();
    await clock.advance(300);
    const fetching = media.last();
    assert.equal(pins(cache).length, 3);
    // What the bot does when a server removes it: the player stops and the queue stays.
    player.stop();
    await clock.advance(300);
    assert.equal(fetching.signal.aborted, true);
    assert.deepEqual(pins(cache), []);
    // Nothing more is asked for, however long it stays stopped.
    const asked = media.calls.length;
    await clock.advance(60_000);
    assert.equal(media.calls.length, asked);
  });

  it('plans while a track loads, though its progress reports keep coming', async () => {
    const { clock, queue, players, media, cache, tracks } = setup(1);
    const [first, second] = tracks;
    assert.ok(first && second);
    queue.add(GUILD, [first.id, second.id], 'end', null);
    cached(cache, first);
    players.get(GUILD).play();
    // The player's own fetch reports progress every 100 ms (sent on at most four times a second): the plan does not
    // wait for the reports to stop, which would be when the track has loaded.
    const loading = players.get(GUILD);
    const report = (loading as unknown as { options: { media: FakeMedia } }).options.media.last().onProgress;
    for (let step = 1; step <= 5; step += 1) {
      report?.(step / 10);
      await clock.advance(100);
    }
    assert.equal(media.last().track.id, second.id);
  });
});
