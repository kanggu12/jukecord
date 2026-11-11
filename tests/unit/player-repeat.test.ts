import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Bus } from '../../src/core/bus.ts';
import { Player, type PlayerSnapshot } from '../../src/core/player.ts';
import { QueueService } from '../../src/core/queue.ts';
import { createLogger } from '../../src/log.ts';
import { FakeClock, FakeMedia, FakeOutput, flush } from '../support/fakes.ts';
import { addTracks, memoryStore } from '../support/store.ts';

const GUILD = '100000000000000001';
const SONG = 60_000;

function setup(queued: number) {
  const clock = new FakeClock();
  const store = memoryStore(() => clock.now());
  const bus = new Bus();
  const queue = new QueueService(store.queue, bus);
  const media = new FakeMedia();
  const snapshots: PlayerSnapshot[] = [];
  bus.on('player', (snapshot) => snapshots.push(snapshot));
  const player = new Player({
    guildId: GUILD,
    queue,
    media,
    history: store.history,
    state: store.playerState,
    bus,
    clock,
    log: createLogger({ level: 'error', sinks: [] }),
    fetchTimeoutMs: 60_000,
  });
  const tracks = addTracks(store, queued);
  queue.add(
    GUILD,
    tracks.map((track) => track.id),
    'end',
    'u1',
  );
  return { clock, store, queue, media, player, snapshots };
}

describe('Player repeat', () => {
  it('plays the same track again without fetching it again, recording each listen', async () => {
    const { clock, store, media, player } = setup(2);
    const output = new FakeOutput();
    player.attach(output);
    player.play();
    media.finish(SONG);
    await flush();
    assert.equal(player.setRepeat('track'), true);
    assert.equal(player.setRepeat('track'), false);
    // Two full plays: a listen only counts once it has played a while.
    await clock.advance(30_000);
    player.outputEnded(output.lastSession());
    await clock.advance(30_000);
    player.outputEnded(output.lastSession());
    assert.equal(player.snapshot().track?.title, 'Track 1');
    assert.equal(player.snapshot().status, 'playing');
    // One fetch only, and the output restarted from the top twice.
    assert.equal(media.calls.length, 1);
    assert.equal(output.of('start').length, 3);
    assert.equal(store.history.list(GUILD).length, 2);
    // A skip moves on even in this mode.
    player.skip();
    assert.equal(media.last().track.title, 'Track 2');
    await clock.advance(0);
  });

  it('puts a finished track back at the end of the queue when the queue repeats', async () => {
    const { clock, queue, media, player, store } = setup(2);
    player.setRepeat('queue');
    player.play();
    media.finish(SONG);
    await flush();
    await clock.advance(SONG);
    assert.deepEqual(
      queue.list(GUILD).map((item) => item.track.title),
      ['Track 1'],
    );
    assert.equal(player.snapshot().track?.title, 'Track 2');
    // Saved with the state, so a restart keeps it.
    player.checkpoint();
    assert.equal(store.playerState.load(GUILD)?.repeat, 'queue');
  });
});

describe('Player loading progress', () => {
  it('shows how much is downloaded while loading, at most four times a second, and nothing once playing', async () => {
    const { clock, media, player, snapshots } = setup(1);
    player.play();
    const call = media.last();
    assert.ok(call.onProgress, 'the player passed no progress callback');
    const before = snapshots.length;
    call.onProgress(0.1);
    call.onProgress(0.2);
    call.onProgress(0.35);
    await clock.advance(250);
    // Three reports, one snapshot, with the latest value.
    assert.equal(snapshots.length, before + 1);
    assert.equal(snapshots.at(-1)?.progress, 0.35);
    media.finish(SONG);
    await flush();
    assert.equal(player.snapshot().progress, null);
  });
});
