import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Bus } from '../../src/core/bus.ts';
import { fetchLimitMs } from '../../src/core/player.ts';
import { Players } from '../../src/core/players.ts';
import { QueueService } from '../../src/core/queue.ts';
import { createLogger } from '../../src/log.ts';
import { MediaCache } from '../../src/media/cache.ts';
import type { Ffmpeg } from '../../src/media/ffmpeg.ts';
import { Media } from '../../src/media/preparer.ts';
import type { YtDlp } from '../../src/media/ytdlp.ts';
import { FakeClock, flush } from '../support/fakes.ts';
import { addTracks, memoryStore } from '../support/store.ts';

const log = createLogger({ level: 'error', sinks: [] });
let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-preparer-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// An ffmpeg that runs nothing: a download lasts until it is cancelled, then takes a moment to end (as a killed process
// takes a moment to exit); how many run at once is counted. An MP3 copy is written at once, its time limit noted.
function fakeFfmpeg() {
  const seen = { running: 0, most: 0, started: 0, mp3Limits: [] as number[] };
  const ffmpeg = {
    fromYtDlp: (_ytdlp: unknown, _url: string, _out: string, signal: AbortSignal) => {
      seen.started += 1;
      seen.running += 1;
      seen.most = Math.max(seen.most, seen.running);
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () =>
            setTimeout(() => {
              seen.running -= 1;
              reject(new Error('ffmpeg cancelled'));
            }, 20),
          { once: true },
        );
      });
    },
    toMp3: async (_in: string, out: string, _signal: AbortSignal, timeoutMs: number) => {
      seen.mp3Limits.push(timeoutMs);
      fs.writeFileSync(out, Buffer.alloc(10, 3));
    },
  };
  return { seen, ffmpeg: ffmpeg as unknown as Ffmpeg };
}

function setup() {
  const store = memoryStore();
  const cache = new MediaCache({ dir, maxBytes: 1024 ** 3, log });
  cache.init();
  const { seen, ffmpeg } = fakeFfmpeg();
  // Two fetches ahead of time at once, so four that somebody waits for.
  const media = new Media({
    cache,
    ytdlp: {} as YtDlp,
    ffmpeg,
    tracks: store.tracks,
    log,
    timeoutMs: 60_000,
    fetchLimit: 2,
  });
  return { store, cache, media, seen };
}

describe('Media under a crowd', () => {
  it('runs at most four downloads somebody waits for while skips cancel each other, and starts the newest', async () => {
    const { store, media, seen } = setup();
    const tracks = addTracks(store, 30);
    // A crowd pressing skip: each new track's fetch cancels the one before, as the player does.
    let previous: AbortController | null = null;
    const loads: Promise<unknown>[] = [];
    for (const track of tracks) {
      previous?.abort();
      const signal = new AbortController();
      previous = signal;
      loads.push(media.prepare(track, signal.signal).catch(() => 'cancelled'));
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Never more than four at once, though thirty were asked for; most never started at all.
    assert.ok(seen.most <= 4, `${seen.most} downloads ran at once`);
    assert.ok(seen.started < 30, `${seen.started} downloads started`);
    // The newest one is running (nobody cancelled it).
    assert.equal(seen.running, 1);
    previous?.abort();
    await Promise.all(loads);
  });

  it('does not count the wait for a place against a track somebody waits for', async () => {
    const { store, media, seen } = setup();
    const clock = new FakeClock();
    const bus = new Bus();
    const queue = new QueueService(store.queue, bus);
    const players = new Players({
      queue,
      media,
      history: store.history,
      state: store.playerState,
      bus,
      clock,
      log,
      fetchTimeoutMs: 60_000,
    });
    // Four servers each fetching a long mix take every place for a fetch somebody waits for (two cores: four). A mix
    // is three hours long, so its own time limit (60 s and a tenth of its length) outlasts every wait below and only a
    // stop frees its place. A three-minute mix gave up at 78 s, inside the five minutes, and the check that nothing had
    // started yet held only while the clock's five minutes took less real time than a killed download takes to end.
    const [mix1, mix2, mix3, mix4, ...songs] = addTracks(store, 9).map((track, index) =>
      // The first four become mixes: the same track stored again with a longer length.
      index < 4 ? store.tracks.upsert({ ...track, durationMs: 3 * 3_600_000 }) : track,
    );
    for (const [index, mix] of [mix1, mix2, mix3, mix4].entries()) {
      queue.add(`mix-server-${index}`, [mix?.id ?? 0], 'end', null);
      players.get(`mix-server-${index}`).play();
    }
    await flush();
    assert.equal(seen.running, 4);
    // A fifth server's songs wait their turn: five minutes on, none has started, and none was given up on.
    queue.add(
      'fifth',
      songs.map((song) => song.id),
      'end',
      null,
    );
    const fifth = players.get('fifth');
    fifth.play();
    await clock.advance(5 * 60_000);
    assert.equal(seen.started, 4);
    // The mixes still hold their places: none was given up on either.
    for (let index = 0; index < 4; index += 1)
      assert.deepEqual(
        [players.get(`mix-server-${index}`).snapshot().status, players.get(`mix-server-${index}`).snapshot().error],
        ['loading', null],
      );
    assert.equal(fifth.snapshot().status, 'loading');
    assert.equal(fifth.snapshot().error, null);
    assert.equal(fifth.snapshot().track?.title, 'Track 5');
    // A mix server stops: its place goes to the fifth server, whose time limit counts from there.
    players.get('mix-server-0').stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await flush();
    assert.equal(seen.started, 5);
    await clock.advance(fetchLimitMs(60_000, songs[0]?.durationMs ?? null) - 1000);
    assert.equal(fifth.snapshot().status, 'loading');
    assert.equal(fifth.snapshot().error, null);
    // And it is still given up on once that limit has passed since it started.
    await clock.advance(2000);
    assert.match(fifth.snapshot().error ?? '', /getting it took too long/);
    for (const player of players.all()) player.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it('gives an MP3 copy the time limit of the track, which grows with its length', async () => {
    const { store, cache, media, seen } = setup();
    const [track] = addTracks(store, 1);
    assert.ok(track);
    // A three-hour track in the cache (a few bytes stand in for its audio; the length is the sidecar's).
    const key = MediaCache.keyOf(track.source);
    const tmp = cache.tmpPath(key);
    fs.writeFileSync(tmp, Buffer.alloc(100, 1));
    cache.commit(key, tmp, { source: track.source, durationMs: 3 * 3_600_000, loudness: null });
    const mp3 = await media.mp3(track, new AbortController().signal);
    assert.equal(mp3, cache.mp3Path(key));
    // The base 60 s and a tenth of three hours on top: eighteen minutes more, where a fixed minute failed every time.
    assert.deepEqual(seen.mp3Limits, [fetchLimitMs(60_000, 3 * 3_600_000)]);
    assert.equal(seen.mp3Limits[0], 60_000 + 1_080_000);
  });
});
