/**
 * yt-dlp's search and mix, run as programs: the stand-in yt-dlp prints the real shapes of a search and of a mix
 * (tests/fixtures, made-up values), and the arguments it was given are checked.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { YtDlp } from '../../src/media/ytdlp.ts';

const FAKE = fileURLToPath(new URL('../support/fake-yt-dlp.mjs', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

describe("yt-dlp's search and mix", () => {
  let dir: string;
  let ytdlp: YtDlp;
  // The arguments of each run, one run per line.
  const runs = () =>
    fs
      .readFileSync(path.join(dir, 'args.log'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-search-'));
    fs.chmodSync(FAKE, 0o755);
    process.env.FAKE_YTDLP_ARGS = path.join(dir, 'args.log');
    ytdlp = new YtDlp({
      binary: FAKE,
      jsRuntime: 'node',
      timeoutMs: 30_000,
      maxPlaylist: 100,
      proxy: 'http://127.0.0.1:9',
    });
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.FAKE_YTDLP_ARGS;
    delete process.env.FAKE_YTDLP_INFO;
  });

  it('searches with one flat listing through the guard, and reads the results', async () => {
    process.env.FAKE_YTDLP_INFO = path.join(FIXTURES, 'ytdlp-search.json');
    const found = await ytdlp.search('example chill songs', 14);
    const args = runs().at(-1) ?? [];
    assert.ok(args.includes('--flat-playlist'));
    assert.deepEqual(args.slice(args.indexOf('--playlist-end'), args.indexOf('--playlist-end') + 2), [
      '--playlist-end',
      '14',
    ]);
    assert.equal(args.at(-1), 'ytsearch14:example chill songs');
    // Every connection through the address guard, as every run of yt-dlp.
    assert.equal(args[args.indexOf('--proxy') + 1], 'http://127.0.0.1:9');
    // Ten listed, two of them live: eight tracks, in YouTube's order, with their channel, length and picture.
    assert.equal(found.length, 8);
    assert.deepEqual(found[4], {
      source: 'https://www.youtube.com/watch?v=srch0000006',
      url: 'https://www.youtube.com/watch?v=srch0000006',
      title: 'Low Tide',
      uploader: 'Example Band',
      durationMs: 203_000,
      thumbnail: 'https://i.example.com/vi/srch0000006/hq1.jpg',
    });
  });

  it("lists a video's mix from its own watch address, the video first", async () => {
    process.env.FAKE_YTDLP_INFO = path.join(FIXTURES, 'ytdlp-mix.json');
    const mix = await ytdlp.mix('mixx0000001', 25);
    const args = runs().at(-1) ?? [];
    assert.equal(args.at(-1), 'https://www.youtube.com/watch?v=mixx0000001&list=RDmixx0000001');
    // The playlist, not the one video.
    assert.ok(!args.includes('--no-playlist'));
    assert.equal(mix.length, 25);
    assert.equal(mix[0]?.source, 'https://www.youtube.com/watch?v=mixx0000001');
    assert.equal(mix[1]?.title, 'Paper Boats on the River');
  });

  it('finds nothing as an empty list, not as a failure', async () => {
    const empty = path.join(dir, 'empty.json');
    fs.writeFileSync(empty, JSON.stringify({ _type: 'playlist', id: 'none', entries: [] }));
    process.env.FAKE_YTDLP_INFO = empty;
    assert.deepEqual(await ytdlp.search('nothing at all', 10), []);
  });
});
