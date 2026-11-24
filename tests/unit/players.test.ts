import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Bus } from '../../src/core/bus.ts';
import { GuildLanes } from '../../src/core/lanes.ts';
import { Players } from '../../src/core/players.ts';
import { QueueService } from '../../src/core/queue.ts';
import { createLogger } from '../../src/log.ts';
import { FakeClock, FakeMedia, flush } from '../support/fakes.ts';
import { addTracks, memoryStore } from '../support/store.ts';

const A = '100000000000000001';
const B = '100000000000000002';

async function setup() {
  const clock = new FakeClock();
  const store = await memoryStore(() => clock.now());
  const bus = new Bus();
  const media = new FakeMedia();
  const lanes = new GuildLanes();
  const players = new Players({
    lanes,
    queue: new QueueService(store.queue, bus, lanes),
    media,
    history: store.history,
    state: store.playerState,
    bus,
    clock,
    log: createLogger({ level: 'error', sinks: [] }),
    fetchTimeoutMs: 60_000,
  });
  return { clock, store, media, players };
}

describe('Players', () => {
  it('gives one player per server', async () => {
    const { players } = await setup();
    assert.equal(players.get(A), players.get(A));
    assert.notEqual(players.get(A), players.get(B));
    assert.equal(players.all().length, 2);
  });

  it('restores the servers that had a track current, paused where they were', async () => {
    const { store, media, players } = await setup();
    const [track] = await addTracks(store, 1);
    assert.ok(track);
    await store.playerState.save({
      guildId: A,
      trackId: track.id,
      addedBy: 'u1',
      status: 'playing',
      positionMs: 30_000,
      repeat: 'off',
    });
    await store.playerState.save({
      guildId: B,
      trackId: null,
      addedBy: null,
      status: 'idle',
      positionMs: 0,
      repeat: 'off',
    });
    assert.equal(await players.restoreAll(store.tracks, store.playerState), 1);
    media.finish(180_000);
    await flush();
    const snapshot = players.get(A).snapshot();
    assert.equal(snapshot.status, 'paused');
    assert.equal(snapshot.positionMs, 30_000);
    assert.equal(snapshot.addedBy, 'u1');
  });
});
