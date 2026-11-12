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
    // Two full plays, each ending at the end of the track: a listen only counts once it has played a while.
    await clock.advance(SONG);
    player.outputEnded(output.lastSession(), output);
    await clock.advance(SONG);
    player.outputEnded(output.lastSession(), output);
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

describe('Player repeat and a track that keeps failing', () => {
  it('gives a track of a looping queue one more pass after a failure, and takes it out after a second', async () => {
    const { clock, queue, media, player } = setup(2);
    player.setRepeat('queue');
    player.play();
    // Pass after pass: Track 1 never comes (a site that refuses it for now), Track 2 plays to its end.
    const fetches: string[] = [];
    for (let pass = 0; pass < 4 && media.calls.length < 20; pass += 1) {
      for (let step = 0; step < 2; step += 1) {
        const call = media.last();
        fetches.push(call.track.title);
        if (call.track.title === 'Track 1') {
          call.reject(new Error('HTTP Error 503: Service Unavailable'));
          await flush();
        } else {
          media.finish(SONG);
          await flush();
          await clock.advance(SONG);
        }
        if (player.snapshot().status === 'idle') break;
      }
    }
    // Fetched twice (the first pass and the one more), then out of the loop: Track 2 goes on alone.
    assert.equal(fetches.filter((title) => title === 'Track 1').length, 2, fetches.join(', '));
    media.finish(SONG);
    await flush();
    assert.equal(player.snapshot().status, 'playing');
    assert.deepEqual(
      [player.snapshot().track?.title, ...queue.list(GUILD).map((item) => item.track.title)],
      ['Track 2'],
    );
  });

  it('keeps a track in the loop that failed once and then played', async () => {
    const { clock, queue, media, player } = setup(2);
    player.setRepeat('queue');
    player.play();
    // Track 1 fails once, Track 2 plays, Track 1 plays on its next pass, Track 2 plays, and Track 1 fails once more.
    media.last().reject(new Error('HTTP Error 503: Service Unavailable'));
    await flush();
    for (let step = 0; step < 3; step += 1) {
      media.finish(SONG);
      await flush();
      await clock.advance(SONG);
    }
    assert.equal(media.last().track.title, 'Track 1');
    media.last().reject(new Error('HTTP Error 503: Service Unavailable'));
    await flush();
    // It had played since its first failure, so this is a first failure again: it stays for one more pass.
    assert.deepEqual(
      [player.snapshot().track?.title, ...queue.list(GUILD).map((item) => item.track.title)],
      ['Track 2', 'Track 1'],
    );
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

describe('Player repeat with skips', () => {
  it('keeps a skipped track in the loop when the queue repeats', async () => {
    const { media, player, queue } = setup(2);
    player.play();
    media.finish(SONG);
    await flush();
    player.setRepeat('queue');
    player.skip();
    // Track 1 went back to the end, after Track 2 (now loading).
    assert.deepEqual(
      queue.list(GUILD).map((item) => item.track.title),
      ['Track 1'],
    );
    assert.equal(media.last().track.title, 'Track 2');
  });
});
