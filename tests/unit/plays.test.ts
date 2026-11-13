/**
 * When a play ends, as the panel tells it from the player's snapshots (panel/src/plays.ts): the sleep timer's "when this
 * track ends" stops listening then. The snapshots are the real player's, on a made-up clock, read in the order a panel
 * gets them; the timer watched for the track's number to change, which a track repeated (repeat one) never does.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Player as Snapshot } from '../../panel/src/api.ts';
import { playEnded } from '../../panel/src/plays.ts';
import { Bus } from '../../src/core/bus.ts';
import { Player } from '../../src/core/player.ts';
import { QueueService } from '../../src/core/queue.ts';
import { createLogger } from '../../src/log.ts';
import { FakeClock, FakeMedia, flush } from '../support/fakes.ts';
import { addTracks, memoryStore } from '../support/store.ts';
import { GUILD } from '../support/web.ts';

const SONG = 180_000;

// A player playing the first of `queued` (track numbers in the store's order, a number twice for a track queued twice),
// and the snapshots it sends from now on.
async function playing(queued: number[] = [0, 1, 2]) {
  const clock = new FakeClock();
  const store = memoryStore(() => clock.now());
  const bus = new Bus();
  const queue = new QueueService(store.queue, bus);
  const media = new FakeMedia();
  // The server's player; made again as jukecord makes it when it starts again (see the restart below).
  const make = () =>
    new Player({
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
  const player = make();
  const tracks = addTracks(store, 3);
  queue.add(
    GUILD,
    queued.map((index) => tracks[index]?.id ?? 0),
    'end',
    'u1',
  );
  player.play();
  media.finish(SONG);
  await flush();
  // What a panel is sent, as it gets it (the panel's own type: the same fields, read the same way).
  const sent: Snapshot[] = [];
  bus.on('player', (snapshot) => sent.push(snapshot as unknown as Snapshot));
  return { clock, media, player, sent, make, first: player.snapshot() as unknown as Snapshot };
}

// Reads the snapshots one by one as the sleep timer does, from the play `first` was of: the index of the snapshot by
// which the play has ended, or -1 when it has not.
function endedAt(first: Snapshot, sent: Snapshot[]): number {
  let last = first;
  for (const [index, next] of sent.entries()) {
    if (playEnded(last, next)) return index;
    last = next;
  }
  return -1;
}

describe('the end of a play, from the snapshots', () => {
  it('is seen when the track ends and the next one starts', async () => {
    const { clock, media, first, sent } = await playing();
    await clock.advance(SONG);
    media.finish(SONG);
    await flush();
    assert.notEqual(endedAt(first, sent), -1);
  });

  it('is seen when the track repeats (repeat one): the same track again from the top is a new play', async () => {
    const { clock, player, sent } = await playing();
    player.setRepeat('track');
    // The timer is set from here: the snapshot that said repeat one.
    const from = sent.at(-1) as Snapshot;
    sent.length = 0;
    // Most of the way through: nothing has ended yet.
    await clock.advance(SONG - 30_000);
    assert.equal(endedAt(from, sent), -1);
    // Past its end: it starts again, the same track, and the play the timer waited for has ended.
    await clock.advance(31_000);
    assert.equal(player.snapshot().track?.id, from.track?.id);
    assert.equal(player.snapshot().status, 'playing');
    assert.notEqual(endedAt(from, sent), -1, 'the repeat of the same track was not taken for the end of the play');
  });

  it('is seen when the track is played again from the queue right after itself', async () => {
    // The same track queued twice in a row: skipped to the second, it is the same track, a play of its own.
    const { clock, media, player, first, sent } = await playing([0, 0, 1]);
    await clock.advance(40_000);
    player.skip();
    media.finish(SONG);
    await flush();
    assert.equal(player.snapshot().track?.id, first.track?.id);
    assert.notEqual(endedAt(first, sent), -1);
  });

  it('is seen when the player stops, the track is removed, or the player stops after it', async () => {
    const stopped = await playing();
    stopped.player.stop();
    assert.notEqual(endedAt(stopped.first, stopped.sent), -1);
    const removed = await playing();
    removed.player.removeCurrent();
    assert.notEqual(endedAt(removed.first, removed.sent), -1);
    const after = await playing();
    after.player.setRepeat('track');
    after.player.setStopAfter(true);
    await after.clock.advance(SONG + 1000);
    assert.notEqual(endedAt(after.first, after.sent), -1);
  });

  it('is not taken from jukecord starting again: the track comes back where it was, made ready again', async () => {
    const { clock, player, make, first, sent } = await playing();
    await clock.advance(85_000);
    // A while later jukecord starts again, and its new player brings the track back where it was (as it does, paused).
    await clock.advance(20_000);
    const restarted = make();
    restarted.restore(player.snapshot().track, 'u1', 85_000);
    assert.equal(restarted.snapshot().status, 'loading');
    assert.equal(endedAt(first, sent.slice(-1)), -1);
  });

  it('is not taken from a seek, back to the start or forward, a pause or a resume', async () => {
    const { clock, player, sent } = await playing();
    player.setRepeat('track');
    const from = sent.at(-1) as Snapshot;
    sent.length = 0;
    await clock.advance(90_000);
    // Back to the start, as a person does with the bar.
    player.seek(0);
    await clock.advance(1000);
    // And forward, past the middle.
    player.seek(150_000);
    await clock.advance(1000);
    player.pause();
    await clock.advance(60_000);
    player.resume();
    await clock.advance(5000);
    assert.equal(endedAt(from, sent), -1);
  });
});
