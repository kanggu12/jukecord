/**
 * The download path's reinforcements with the real ffmpeg and the fake yt-dlp: one retry after a transient failure,
 * and download progress reported to the caller.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createLogger, MemorySink } from '../../src/log.ts';
import { MediaCache } from '../../src/media/cache.ts';
import { Ffmpeg } from '../../src/media/ffmpeg.ts';
import { Media } from '../../src/media/preparer.ts';
import { YtDlp } from '../../src/media/ytdlp.ts';
import { memoryStore } from '../support/store.ts';

const FFMPEG = process.env.JUKECORD_FFMPEG ?? 'ffmpeg';
const FAKE = fileURLToPath(new URL('../support/fake-yt-dlp.mjs', import.meta.url));

function haveFfmpeg(): boolean {
  try {
    return execFileSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).includes('libopus');
  } catch {
    return false;
  }
}

describe('media reinforcements', { skip: !haveFfmpeg() && 'ffmpeg with libopus is not installed' }, () => {
  let dir = '';

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-retry-'));
    execFileSync(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      // A source filter, not -f lavfi, so the image's FFmpeg (built without devices) runs it too.
      '-filter_complex',
      'sine=frequency=330:duration=3',
      '-c:a',
      'libopus',
      '-f',
      'webm',
      path.join(dir, 'tone.webm'),
    ]);
    fs.chmodSync(FAKE, 0o755);
    process.env.FAKE_YTDLP_AUDIO = path.join(dir, 'tone.webm');
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const name of ['FAKE_YTDLP_AUDIO', 'FAKE_YTDLP_FAIL_ONCE', 'FAKE_YTDLP_MARKER']) delete process.env[name];
  });

  it('retries once after a transient failure and reports progress on the way', async () => {
    process.env.FAKE_YTDLP_FAIL_ONCE = 'Unable to download webpage: HTTP Error 503: Service Unavailable';
    process.env.FAKE_YTDLP_MARKER = path.join(dir, 'failed-once');
    const sink = new MemorySink();
    const log = createLogger({ level: 'info', sinks: [sink] });
    const store = memoryStore();
    const cache = new MediaCache({ dir: path.join(dir, 'cache'), maxBytes: 1024 ** 3, log });
    cache.init();
    const media = new Media({
      cache,
      ytdlp: new YtDlp({ binary: FAKE, jsRuntime: 'node', timeoutMs: 30_000, maxPlaylist: 10 }),
      ffmpeg: new Ffmpeg(FFMPEG),
      tracks: store.tracks,
      log,
      timeoutMs: 60_000,
    });
    const track = store.tracks.upsert({
      source: 'https://example.com/flaky',
      url: 'https://example.com/flaky',
      title: 'Flaky',
      uploader: null,
      durationMs: null,
      thumbnail: null,
    });
    const fractions: number[] = [];
    const prepared = await media.prepare(track, new AbortController().signal, (fraction) => fractions.push(fraction));
    assert.ok(prepared.durationMs > 2500);
    assert.ok(
      sink.records.some((record) => record.msg.includes('retrying a download')),
      'no retry was logged',
    );
    // The fake prints a quarter, a half and all of it (byte counts are rounded, so compare to a thousandth).
    assert.equal(fractions.length, 3);
    [0.25, 0.5, 1].forEach((expected, index) => {
      assert.ok(Math.abs((fractions[index] ?? -1) - expected) < 0.001, `progress ${fractions[index]}`);
    });
  });

  it('does not retry a failure that is not transient', async () => {
    process.env.FAKE_YTDLP_FAIL_ONCE = 'Video unavailable';
    process.env.FAKE_YTDLP_MARKER = path.join(dir, 'failed-once-2');
    const log = createLogger({ level: 'error', sinks: [] });
    const store = memoryStore();
    const cache = new MediaCache({ dir: path.join(dir, 'cache-2'), maxBytes: 1024 ** 3, log });
    cache.init();
    const media = new Media({
      cache,
      ytdlp: new YtDlp({ binary: FAKE, jsRuntime: 'node', timeoutMs: 30_000, maxPlaylist: 10 }),
      ffmpeg: new Ffmpeg(FFMPEG),
      tracks: store.tracks,
      log,
      timeoutMs: 60_000,
    });
    const track = store.tracks.upsert({
      source: 'https://example.com/gone',
      url: 'https://example.com/gone',
      title: 'Gone',
      uploader: null,
      durationMs: null,
      thumbnail: null,
    });
    await assert.rejects(media.prepare(track, new AbortController().signal), /Video unavailable/);
  });
});
