import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fetchLimitMs } from '../../src/core/player.ts';
import { createLogger } from '../../src/log.ts';
import { MediaCache } from '../../src/media/cache.ts';
import type { Ffmpeg } from '../../src/media/ffmpeg.ts';
import { Media } from '../../src/media/preparer.ts';
import type { YtDlp } from '../../src/media/ytdlp.ts';
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
