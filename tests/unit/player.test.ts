import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Bus } from '../../src/core/bus.ts';
import { fetchLimitMs, Player, type PlayerSnapshot } from '../../src/core/player.ts';
import { QueueService } from '../../src/core/queue.ts';
import { createLogger, MemorySink } from '../../src/log.ts';
import { FakeClock, FakeMedia, FakeOutput, flush } from '../support/fakes.ts';
import { addTracks, memoryStore } from '../support/store.ts';

const GUILD = '100000000000000001';
const SONG = 180_000;

// A player over an in-memory database with three queued tracks, a fake clock and a fake media preparer.
function setup(options: { fetchTimeoutMs?: number; queued?: number } = {}) {
  const clock = new FakeClock();
  const store = memoryStore(() => clock.now());
  const bus = new Bus();
  const queue = new QueueService(store.queue, bus);
  const media = new FakeMedia();
  const sink = new MemorySink();
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
    log: createLogger({ level: 'debug', sinks: [sink] }),
    fetchTimeoutMs: options.fetchTimeoutMs ?? 60_000,
  });
  const tracks = addTracks(store, options.queued ?? 3);
  queue.add(
    GUILD,
    tracks.map((track) => track.id),
    'end',
    'u1',
  );
  return { clock, store, bus, queue, media, sink, snapshots, player, tracks };
}

// Starts the first track and lets it get ready.
async function startPlaying(context: ReturnType<typeof setup>, durationMs = SONG): Promise<void> {
  assert.equal(context.player.play(), true);
  context.media.finish(durationMs);
  await flush();
  assert.equal(context.player.snapshot().status, 'playing');
}

describe('Player', () => {
  it('stays idle when there is nothing to play', () => {
    const context = setup({ queued: 0 });
    assert.equal(context.player.play(), false);
    assert.equal(context.player.snapshot().status, 'idle');
  });

  it('loads the first track, plays it, and follows the clock', async () => {
    const context = setup();
    const output = new FakeOutput();
    context.player.attach(output);
    context.player.play();
    assert.equal(context.player.snapshot().status, 'loading');
    assert.equal(context.media.last().track.title, 'Track 1');
    // Taken out of the queue when it became current.
    assert.equal(context.queue.size(GUILD), 2);
    context.media.finish(SONG);
    await flush();
    assert.equal(context.player.snapshot().status, 'playing');
    assert.deepEqual(output.of('start'), [
      { kind: 'start', offsetMs: 0, session: output.lastSession(), file: '/cache/1.opus' },
    ]);
    await context.clock.advance(10_000);
    assert.equal(context.player.snapshot().positionMs, 10_000);
    // Each change produced one snapshot with a growing version.
    const versions = context.snapshots.map((snapshot) => snapshot.version);
    assert.deepEqual(
      versions,
      versions.map((_, index) => index + 1),
    );
  });

  it('moves on by the clock at the end when no output is attached (browser-only)', async () => {
    const context = setup();
    await startPlaying(context);
    await context.clock.advance(SONG);
    assert.equal(context.player.snapshot().status, 'loading');
    assert.equal(context.media.last().track.title, 'Track 2');
    const [entry] = context.store.history.list(GUILD);
    assert.equal(entry?.track.title, 'Track 1');
    assert.equal(entry?.playedMs, SONG);
  });

  it('moves on when the output reports the end, and ignores reports from an older session', async () => {
    const context = setup();
    const output = new FakeOutput();
    context.player.attach(output);
    await startPlaying(context);
    const first = output.lastSession();
    // A seek restarts the output with a new session; an "ended" from the old stream must not skip the song.
    context.player.seek(30_000);
    context.player.outputEnded(first);
    assert.equal(context.player.snapshot().status, 'playing');
    // The current stream's end, at the end of the track.
    await context.clock.advance(SONG - 30_000);
    context.player.outputEnded(output.lastSession(), output);
    assert.equal(context.player.snapshot().status, 'loading');
    assert.equal(context.media.last().track.title, 'Track 2');
  });

  it('restarts an output that stops early, twice at most, and lets the clock end the track', async () => {
    const context = setup();
    const output = new FakeOutput();
    context.player.attach(output);
    await startPlaying(context);
    // The stream breaks a minute in (a file gone, ffmpeg dead): the track goes on, the output starts again there.
    await context.clock.advance(60_000);
    context.player.outputEnded(output.lastSession(), output);
    assert.equal(context.player.snapshot().status, 'playing');
    assert.equal(context.player.snapshot().track?.title, 'Track 1');
    assert.equal(output.of('start').length, 2);
    context.player.outputEnded(output.lastSession(), output);
    context.player.outputEnded(output.lastSession(), output);
    // Two restarts, then no more: a broken output cannot make the queue fly by.
    assert.equal(output.of('start').length, 3);
    assert.equal(context.player.snapshot().track?.title, 'Track 1');
    // The clock ends the track when it is over (with the grace period an output gets).
    await context.clock.advance(SONG);
    assert.equal(context.media.last().track.title, 'Track 2');
  });

  it('waits a grace period for the output before ending by the clock', async () => {
    const context = setup();
    const output = new FakeOutput();
    context.player.attach(output);
    await startPlaying(context);
    await context.clock.advance(SONG);
    assert.equal(context.player.snapshot().status, 'playing');
    await context.clock.advance(5_000);
    assert.equal(context.player.snapshot().status, 'loading');
    assert.ok(context.sink.records.some((record) => record.msg.includes('no output reported the end')));
  });

  it('pauses and resumes at the same place', async () => {
    const context = setup();
    const output = new FakeOutput();
    context.player.attach(output);
    await startPlaying(context);
    await context.clock.advance(20_000);
    assert.equal(context.player.pause(), true);
    assert.equal(context.player.pause(), false);
    await context.clock.advance(60_000);
    // The position does not move while paused, and the end timer does not fire.
    assert.equal(context.player.snapshot().positionMs, 20_000);
    assert.equal(context.player.resume(), true);
    assert.deepEqual(
      output.calls.map((call) => call.kind),
      ['start', 'pause', 'resume'],
    );
    await context.clock.advance(SONG - 20_000 + 5_000);
    assert.equal(context.media.last().track.title, 'Track 2');
  });

  it('runs the first seek at once and merges the ones that follow within the cooldown', async () => {
    const context = setup();
    const output = new FakeOutput();
    context.player.attach(output);
    await startPlaying(context);
    context.player.seek(10_000);
    context.player.seek(20_000);
    context.player.seek(30_000);
    assert.deepEqual(
      output.of('start').map((call) => (call.kind === 'start' ? call.offsetMs : -1)),
      [0, 10_000],
    );
    await context.clock.advance(400);
    assert.deepEqual(
      output.of('start').map((call) => (call.kind === 'start' ? call.offsetMs : -1)),
      [0, 10_000, 30_000],
    );
    // Seeks stay inside the track.
    await context.clock.advance(1000);
    context.player.seek(SONG + 50_000);
    assert.equal(context.player.snapshot().positionMs, SONG - 500);
  });

  it('moves the place while paused and restarts the output there on resume', async () => {
    const context = setup();
    const output = new FakeOutput();
    context.player.attach(output);
    await startPlaying(context);
    context.player.pause();
    context.player.seek(90_000);
    context.player.resume();
    assert.deepEqual(
      output.calls.map((call) => (call.kind === 'start' ? `start@${call.offsetMs}` : call.kind)),
      ['start@0', 'pause', 'stop', 'start@90000'],
    );
  });

  it('records a skip after a real listen but not one right after the start', async () => {
    const context = setup();
    await startPlaying(context);
    await context.clock.advance(500);
    context.player.skip();
    context.media.finish(SONG);
    await flush();
    await context.clock.advance(2000);
    context.player.skip();
    assert.deepEqual(
      context.store.history.list(GUILD).map((entry) => [entry.track.title, entry.playedMs]),
      [['Track 2', 2000]],
    );
  });

  it('abandons a fetch that is skipped and does not let its late result start playing', async () => {
    const context = setup();
    context.player.play();
    const first = context.media.last();
    context.player.skip();
    assert.equal(first.signal.aborted, true);
    // A result arriving after the skip changes nothing.
    first.resolve({ file: '/cache/late.opus', durationMs: SONG });
    await flush();
    assert.equal(context.player.snapshot().track?.title, 'Track 2');
    assert.equal(context.player.snapshot().status, 'loading');
    assert.equal(context.store.history.list(GUILD).length, 0);
  });

  it('skips a track that fails, says why, and does not record it', async () => {
    const context = setup();
    context.player.play();
    context.media.last().reject(new Error('Video unavailable'));
    await flush();
    const snapshot = context.player.snapshot();
    assert.equal(snapshot.track?.title, 'Track 2');
    // A short reason for people (core/reasons.ts); the full text went to the log.
    assert.equal(snapshot.error, 'Track 1: the video is unavailable');
    // The error clears when the next track starts.
    context.media.finish(SONG);
    await flush();
    assert.equal(context.player.snapshot().error, null);
  });

  it('gives up on a fetch that takes longer than the timeout, which grows with the track', async () => {
    const context = setup({ fetchTimeoutMs: 10_000 });
    context.player.play();
    const first = context.media.last();
    const limit = fetchLimitMs(10_000, first.track.durationMs);
    // A tenth of the track's length on top of the base limit.
    assert.equal(limit, 10_000 + Math.round((first.track.durationMs ?? 0) / 10));
    await context.clock.advance(limit - 1);
    assert.equal(first.signal.aborted, false);
    await context.clock.advance(1);
    assert.equal(first.signal.aborted, true);
    assert.equal(context.player.snapshot().track?.title, 'Track 2');
    assert.equal(context.player.snapshot().error, 'Track 1: getting it took too long');
  });

  it('stops after three tracks in a row fail, leaving the rest of the queue alone', async () => {
    const context = setup({ queued: 5 });
    context.player.play();
    for (let i = 0; i < 3; i += 1) {
      context.media.last().reject(new Error('Sign in to confirm you’re not a bot'));
      await flush();
    }
    const snapshot = context.player.snapshot();
    assert.equal(snapshot.status, 'idle');
    assert.equal(snapshot.error, 'Track 3: YouTube is refusing this server for now');
    // The three tracks are back at the front, in order, before the two never tried: the cause was not them.
    assert.deepEqual(
      context.queue.list(GUILD).map((item) => item.track.title),
      ['Track 1', 'Track 2', 'Track 3', 'Track 4', 'Track 5'],
    );
  });

  it('puts back the tracks of a queue that ran out on failures, as three failures in a row do', async () => {
    for (const queued of [1, 2]) {
      const context = setup({ queued });
      context.player.play();
      for (let i = 0; i < queued; i += 1) {
        context.media.last().reject(new Error('Temporary failure in name resolution'));
        await flush();
      }
      // An outage with one or two tracks queued: they wait at the front, in order, instead of being thrown away.
      assert.equal(context.player.snapshot().status, 'idle', `${queued} queued`);
      assert.deepEqual(
        context.queue.list(GUILD).map((item) => item.track.title),
        context.tracks.map((track) => track.title),
      );
      // Added by the same person, and nothing more was fetched.
      assert.ok(context.queue.list(GUILD).every((item) => item.addedBy === 'u1'));
      assert.equal(context.media.calls.length, queued);
    }
  });

  it('keeps a track that failed once in a looping queue, and drops one that is gone for good', async () => {
    const context = setup({ queued: 3 });
    context.player.setRepeat('queue');
    context.player.play();
    // Track 1 fails on a network blip: it goes back to the end of the loop, added by the same person.
    context.media.last().reject(new Error('HTTP Error 503: Service Unavailable'));
    await flush();
    assert.equal(context.player.snapshot().track?.title, 'Track 2');
    assert.deepEqual(
      context.queue.list(GUILD).map((item) => [item.track.title, item.addedBy]),
      [
        ['Track 3', 'u1'],
        ['Track 1', 'u1'],
      ],
    );
    // Track 2 plays; Track 3 is gone from the site: it leaves the loop.
    context.media.finish(SONG);
    await flush();
    await context.clock.advance(SONG);
    context.media.last().reject(new Error('ERROR: [youtube] abc: Video unavailable'));
    await flush();
    assert.equal(context.player.snapshot().track?.title, 'Track 1');
    assert.deepEqual(
      context.queue.list(GUILD).map((item) => item.track.title),
      ['Track 2'],
    );
  });

  it('stops a looping queue after three failures in a row without putting a track back twice', async () => {
    const context = setup({ queued: 2 });
    context.player.setRepeat('queue');
    context.player.play();
    // An outage: Track 1, Track 2 and Track 1 again fail; each went back to the end of the loop when it failed.
    for (let i = 0; i < 3; i += 1) {
      context.media.last().reject(new Error('Temporary failure in name resolution'));
      await flush();
    }
    assert.equal(context.player.snapshot().status, 'idle');
    // The loop is whole: both tracks once each, in the loop's order.
    assert.deepEqual(
      context.queue.list(GUILD).map((item) => item.track.title),
      ['Track 2', 'Track 1'],
    );
  });

  it('counts failures in a row only until someone acts', async () => {
    const context = setup({ queued: 8 });
    context.player.play();
    // Two failures, then a person skips: the count starts again, so two more failures do not stop the player.
    for (let i = 0; i < 2; i += 1) {
      context.media.last().reject(new Error('HTTP Error 503'));
      await flush();
    }
    context.player.skip();
    for (let i = 0; i < 2; i += 1) {
      context.media.last().reject(new Error('HTTP Error 503'));
      await flush();
    }
    // Still going: the sixth track is being got ready.
    assert.equal(context.player.snapshot().status, 'loading');
    assert.equal(context.media.last().track.title, 'Track 6');
  });

  it('starts paused when paused while loading, and starts the output on resume', async () => {
    const context = setup();
    const output = new FakeOutput();
    context.player.attach(output);
    context.player.play();
    assert.equal(context.player.pause(), true);
    context.media.finish(SONG);
    await flush();
    assert.equal(context.player.snapshot().status, 'paused');
    assert.equal(output.calls.length, 0);
    context.player.resume();
    assert.deepEqual(output.of('start').length, 1);
  });

  it('stops and keeps the queue', async () => {
    const context = setup();
    const output = new FakeOutput();
    context.player.attach(output);
    await startPlaying(context);
    await context.clock.advance(3000);
    assert.equal(context.player.stop(), true);
    assert.equal(context.player.snapshot().status, 'idle');
    assert.equal(output.calls.at(-1)?.kind, 'stop');
    assert.equal(context.queue.size(GUILD), 2);
    assert.equal(context.store.history.list(GUILD).length, 1);
    // A stopped player leaves no timer running.
    assert.equal(context.clock.pending(), 0);
  });

  it('starts an output attached in the middle of a track at the current place', async () => {
    const context = setup();
    await startPlaying(context);
    await context.clock.advance(42_000);
    const output = new FakeOutput();
    context.player.attach(output);
    assert.deepEqual(
      output.of('start').map((call) => (call.kind === 'start' ? call.offsetMs : -1)),
      [42_000],
    );
    context.player.detach(output);
    assert.equal(output.calls.at(-1)?.kind, 'stop');
  });

  it('saves where it is and comes back paused there after a restart', async () => {
    const context = setup();
    await startPlaying(context);
    await context.clock.advance(65_000);
    context.player.checkpoint();
    const saved = context.store.playerState.load(GUILD);
    assert.equal(saved?.status, 'playing');
    assert.equal(saved?.positionMs, 65_000);

    // A new player over the same database, as after a restart.
    const media = new FakeMedia();
    const restarted = new Player({
      guildId: GUILD,
      queue: context.queue,
      media,
      history: context.store.history,
      state: context.store.playerState,
      bus: context.bus,
      clock: context.clock,
      log: createLogger({ level: 'debug', sinks: [] }),
      fetchTimeoutMs: 60_000,
    });
    const track = context.store.tracks.get(saved?.trackId ?? -1);
    restarted.restore(track, saved?.addedBy ?? null, saved?.positionMs ?? 0);
    media.finish(SONG);
    await flush();
    assert.equal(restarted.snapshot().status, 'paused');
    assert.equal(restarted.snapshot().positionMs, 65_000);
  });
});

describe('Player failures after a restart', () => {
  it('keeps the next track paused when the restored one cannot be got ready', async () => {
    const context = setup();
    const [first] = context.tracks;
    assert.ok(first);
    context.player.restore(first, 'u1', 30_000);
    context.media.last().reject(new Error('Video unavailable'));
    await flush();
    context.media.finish(SONG);
    await flush();
    // A restart never comes back playing, even through a failure.
    assert.equal(context.player.snapshot().status, 'paused');
  });
});
