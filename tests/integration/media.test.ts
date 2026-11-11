/**
 * The media path end to end with the real ffmpeg and a fake yt-dlp: look up, download, encode, measure, cache,
 * share one download between two callers, cancel, and make the Safari copy.
 *
 * Skipped when ffmpeg is not installed; the container image and CI always have it.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../../src/log.ts';
import { MediaCache } from '../../src/media/cache.ts';
import { Ffmpeg } from '../../src/media/ffmpeg.ts';
import { oggOpusDurationMs } from '../../src/media/ogg.ts';
import { Media } from '../../src/media/preparer.ts';
import { Resolver } from '../../src/media/resolver.ts';
import { YtDlp } from '../../src/media/ytdlp.ts';
import { memoryStore } from '../support/store.ts';

const FFMPEG = process.env.JUKECORD_FFMPEG ?? 'ffmpeg';
const FAKE = fileURLToPath(new URL('../support/fake-yt-dlp.mjs', import.meta.url));
const log = createLogger({ level: 'error', sinks: [] });

// Whether ffmpeg with Opus and MP3 encoders is available.
function haveFfmpeg(): boolean {
  try {
    const encoders = execFileSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    return encoders.includes('libopus') && encoders.includes('libmp3lame');
  } catch {
    return false;
  }
}

describe('media, end to end', { skip: !haveFfmpeg() && 'ffmpeg with libopus and libmp3lame is not installed' }, () => {
  let dir = '';

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-media-'));
    // Five seconds of a 440 Hz tone, made here so the repository carries no audio file.
    execFileSync(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=5',
      '-c:a',
      'libopus',
      '-f',
      'webm',
      path.join(dir, 'tone.webm'),
    ]);
    fs.writeFileSync(
      path.join(dir, 'info.json'),
      JSON.stringify({
        id: 'tone',
        title: 'A tone',
        webpage_url: 'https://example.com/tone',
        uploader: 'Tests',
        duration: 5,
      }),
    );
    // The fake must be executable, as yt-dlp is.
    fs.chmodSync(FAKE, 0o755);
    process.env.FAKE_YTDLP_INFO = path.join(dir, 'info.json');
    process.env.FAKE_YTDLP_AUDIO = path.join(dir, 'tone.webm');
    process.env.FAKE_YTDLP_ARGS = path.join(dir, 'args.log');
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.FAKE_YTDLP_INFO;
    delete process.env.FAKE_YTDLP_AUDIO;
    delete process.env.FAKE_YTDLP_ARGS;
    delete process.env.FAKE_YTDLP_FAIL;
  });

  function build() {
    const store = memoryStore();
    // The proxy is only passed on (the fake yt-dlp makes no connections); the cache folder is where it would keep things.
    const ytdlp = new YtDlp({
      binary: FAKE,
      jsRuntime: 'node',
      timeoutMs: 30_000,
      maxPlaylist: 100,
      proxy: 'http://127.0.0.1:9',
      cacheDir: path.join(dir, 'yt-dlp'),
    });
    const cache = new MediaCache({ dir: fs.mkdtempSync(path.join(dir, 'cache-')), maxBytes: 1024 ** 3, log });
    cache.init();
    const ffmpeg = new Ffmpeg(FFMPEG);
    const media = new Media({ cache, ytdlp, ffmpeg, tracks: store.tracks, log, timeoutMs: 60_000 });
    const resolver = new Resolver({ ytdlp, tracks: store.tracks, log });
    return { store, cache, media, resolver };
  }

  it('looks up, downloads, encodes and caches a track, with its real length and loudness', async () => {
    const { store, cache, media, resolver } = build();
    const [track] = await resolver.resolve('https://example.com/tone');
    assert.equal(track?.title, 'A tone');
    assert.ok(track);
    const prepared = await media.prepare(track, new AbortController().signal);
    // Within 60 ms of five seconds (the encoder pads to whole frames).
    assert.ok(Math.abs(prepared.durationMs - 5000) <= 60, `length ${prepared.durationMs}`);
    assert.equal(await oggOpusDurationMs(prepared.file), prepared.durationMs);
    assert.ok(store.tracks.get(track.id)?.loudness !== null, 'loudness was not recorded');
    assert.equal(cache.count(), 1);
    // yt-dlp was told to use Node for JavaScript, to ignore config files, to keep its cache in the data directory and
    // to make every connection through the address guard: the lookup and the download alike.
    const runs = fs.readFileSync(path.join(dir, 'args.log'), 'utf8').trim().split('\n');
    assert.ok(runs.length >= 2, `only ${runs.length} yt-dlp runs were recorded`);
    for (const run of runs) {
      const args = JSON.parse(run) as string[];
      assert.ok(args.includes('--ignore-config'));
      assert.equal(args[args.indexOf('--js-runtimes') + 1], 'node');
      assert.equal(args[args.indexOf('--proxy') + 1], 'http://127.0.0.1:9');
      assert.equal(args[args.indexOf('--cache-dir') + 1], path.join(dir, 'yt-dlp'));
    }
    // The second time comes from the cache: no new download.
    fs.writeFileSync(path.join(dir, 'args.log'), '');
    await media.prepare(track, new AbortController().signal);
    assert.equal(fs.readFileSync(path.join(dir, 'args.log'), 'utf8'), '');
  });

  it('answers a known address from the database without asking the site', async () => {
    const { resolver } = build();
    await resolver.resolve('https://example.com/tone');
    fs.writeFileSync(path.join(dir, 'args.log'), '');
    const [again] = await resolver.resolve('example.com/tone');
    assert.equal(again?.title, 'A tone');
    assert.equal(fs.readFileSync(path.join(dir, 'args.log'), 'utf8'), '');
  });

  it('shares one download between two callers and keeps it going while one still waits', async () => {
    const { media, store } = build();
    const track = store.tracks.upsert({
      source: 'https://example.com/shared',
      url: 'https://example.com/shared',
      title: 'Shared',
      uploader: null,
      durationMs: null,
      thumbnail: null,
    });
    fs.writeFileSync(path.join(dir, 'args.log'), '');
    const first = new AbortController();
    const second = new AbortController();
    const a = media.prepare(track, first.signal);
    const b = media.prepare(track, second.signal);
    first.abort();
    await assert.rejects(a, /cancelled/);
    const prepared = await b;
    assert.ok(prepared.durationMs > 4000);
    const downloads = fs
      .readFileSync(path.join(dir, 'args.log'), 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line.includes('"-"'));
    assert.equal(downloads.length, 1);
  });

  it('reports the site error and leaves no partial file', async () => {
    const { media, store, cache } = build();
    const track = store.tracks.upsert({
      source: 'https://example.com/gone',
      url: 'https://example.com/gone',
      title: 'Gone',
      uploader: null,
      durationMs: null,
      thumbnail: null,
    });
    process.env.FAKE_YTDLP_FAIL = 'Video unavailable';
    try {
      await assert.rejects(
        media.prepare(track, new AbortController().signal),
        /yt-dlp failed: ERROR: Video unavailable/,
      );
    } finally {
      delete process.env.FAKE_YTDLP_FAIL;
    }
    assert.deepEqual(
      fs.readdirSync(cache.dir).filter((name) => name.includes('.tmp.')),
      [],
    );
  });

  it('makes an MP3 copy for Safari once, on request', async () => {
    const { media, resolver, cache } = build();
    const [track] = await resolver.resolve('https://example.com/tone');
    assert.ok(track);
    // Not prepared yet: there is nothing to convert.
    assert.equal(await media.mp3(track, new AbortController().signal), null);
    await media.prepare(track, new AbortController().signal);
    const mp3 = await media.mp3(track, new AbortController().signal);
    assert.equal(mp3, cache.mp3Path(MediaCache.keyOf(track.source)));
    // Five seconds at 192 kbit/s is about 120 KB.
    assert.ok(mp3 && fs.statSync(mp3).size > 100_000);
  });
});
