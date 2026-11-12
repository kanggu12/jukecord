import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { Track } from '../../src/core/types.ts';
import { createLogger } from '../../src/log.ts';
import { BusyError } from '../../src/media/busy.ts';
import { MediaCache } from '../../src/media/cache.ts';
import { CoverError, Covers, fetchPicture, type Picture, sniffImage } from '../../src/media/covers.ts';

const log = createLogger({ level: 'error', sinks: [] });

// A whole picture: the smallest PNG there is (one pixel), and the first bytes of the other kinds kept.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const AVIF = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypavif'), Buffer.from('mif1')]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

describe('sniffing a picture', () => {
  it('knows the five kinds jukecord keeps by their first bytes, and nothing else', () => {
    assert.equal(sniffImage(PNG), 'png');
    assert.equal(sniffImage(JPEG), 'jpg');
    assert.equal(sniffImage(GIF), 'gif');
    assert.equal(sniffImage(WEBP), 'webp');
    assert.equal(sniffImage(AVIF), 'avif');
    // A picture that can carry script, a page, a picture cut short, nothing at all.
    assert.equal(sniffImage(SVG), null);
    assert.equal(sniffImage(Buffer.from('<!doctype html><title>404</title>')), null);
    assert.equal(sniffImage(PNG.subarray(0, 4)), null);
    assert.equal(sniffImage(Buffer.alloc(0)), null);
  });
});

// Names as the fetch resolves them in these tests: "covers.test" is this machine, standing in for an image host on the
// internet; "inside.test" is on a private network.
const NAMES: Record<string, string[]> = {
  'covers.test': ['127.0.0.1'],
  'inside.test': ['10.0.0.1'],
  'mixed.test': ['10.9.9.9', '127.0.0.1'],
};
const rules = {
  lookup: async (host: string) => {
    const found = NAMES[host];
    if (!found) throw new Error('ENOTFOUND');
    return found;
  },
  allowed: (address: string) => address === '127.0.0.1',
  maxBytes: 1000,
  timeoutMs: 400,
};

describe('fetching a picture', () => {
  let site: http.Server;
  let port = 0;
  // What the site was asked last, with its headers.
  let asked: http.IncomingHttpHeaders = {};

  before(async () => {
    site = http.createServer((request, response) => {
      asked = request.headers;
      const route = request.url ?? '';
      if (route === '/cover.png') response.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
      else if (route === '/untyped') response.writeHead(200).end(PNG);
      else if (route === '/moved') response.writeHead(302, { location: '/cover.png' }).end();
      else if (route === '/loop') response.writeHead(302, { location: '/loop' }).end();
      else if (route === '/inside') response.writeHead(302, { location: 'http://inside.test/cover.png' }).end();
      // As YouTube answers a picture it does not have: a grey picture, with 404.
      else if (route === '/missing') response.writeHead(404, { 'content-type': 'image/jpeg' }).end(JPEG);
      else if (route === '/page') response.writeHead(200, { 'content-type': 'text/html' }).end('<html></html>');
      else if (route === '/svg') response.writeHead(200, { 'content-type': 'image/svg+xml' }).end(SVG);
      else if (route === '/big') response.writeHead(200, { 'content-type': 'image/png', 'content-length': 5000 }).end();
      else if (route === '/endless') {
        // No length said, and more than the limit sent.
        response.writeHead(200, { 'content-type': 'image/png' });
        response.write(PNG);
        response.end(Buffer.alloc(2000));
      } else if (route === '/slow') {
        // Never answers; the fetch gives up at its time limit.
      } else response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    port = (site.address() as net.AddressInfo).port;
  });
  after(() => {
    site.closeAllConnections();
    site.close();
  });

  const at = (name: string, route: string) => `http://${name}:${port}${route}`;

  it('fetches a picture from a public address, asking for pictures only and saying nothing about anyone', async () => {
    const picture = await fetchPicture(at('covers.test', '/cover.png'), rules);
    assert.equal(picture.type, 'png');
    assert.deepEqual(picture.bytes, PNG);
    assert.match(String(asked.accept), /^image\//);
    assert.match(String(asked['user-agent']), /^jukecord\//);
    assert.equal(asked.cookie, undefined);
    assert.equal(asked.referer, undefined);
    // A name with a private address too reaches the public one only.
    assert.equal((await fetchPicture(at('mixed.test', '/cover.png'), rules)).type, 'png');
    // No type said: the bytes decide.
    assert.equal((await fetchPicture(at('covers.test', '/untyped'), rules)).type, 'png');
  });

  it('follows a redirect by the same rules, and only a few', async () => {
    assert.equal((await fetchPicture(at('covers.test', '/moved'), rules)).type, 'png');
    await assert.rejects(fetchPicture(at('covers.test', '/loop'), rules), /too many redirects/);
    await assert.rejects(fetchPicture(at('covers.test', '/inside'), rules), /private network/);
  });

  it('refuses private addresses, other schemes and names that do not resolve, before any connection', async () => {
    await assert.rejects(fetchPicture('http://inside.test/cover.png', rules), /private network/);
    await assert.rejects(fetchPicture('http://10.1.2.3/cover.png', rules), /private network/);
    await assert.rejects(fetchPicture('http://[::1]/cover.png', rules), /private network/);
    await assert.rejects(fetchPicture('file:///etc/passwd', rules), /not a web address/);
    await assert.rejects(fetchPicture('http://nowhere.test/cover.png', rules), /no such site/);
    await assert.rejects(fetchPicture('not an address', rules), CoverError);
  });

  it('keeps only whole pictures of the kinds it knows, within the size and the time', async () => {
    await assert.rejects(fetchPicture(at('covers.test', '/missing'), rules), /answered 404/);
    await assert.rejects(fetchPicture(at('covers.test', '/page'), rules), /text\/html, not a picture/);
    await assert.rejects(fetchPicture(at('covers.test', '/svg'), rules), /not a picture jukecord keeps/);
    await assert.rejects(fetchPicture(at('covers.test', '/big'), rules), /larger than jukecord keeps/);
    await assert.rejects(fetchPicture(at('covers.test', '/endless'), rules), /larger than jukecord keeps/);
    const started = Date.now();
    await assert.rejects(fetchPicture(at('covers.test', '/slow'), rules), /took too long/);
    assert.ok(Date.now() - started < 2000);
  });

  it('keeps to public addresses by default, and reaches this machine by its system name when private ones are allowed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-covers-private-'));
    try {
      const cache = new MediaCache({ dir, maxBytes: 1024 ** 2, log });
      cache.init();
      // This machine's own site: by its address (nothing is asked of DNS), and by the name the system gives it (from
      // /etc/hosts, which DNS asked directly lacks).
      const local = (name: string, host: string): Track => ({
        id: 1,
        source: `https://example.com/watch?v=${name}`,
        url: `https://example.com/watch?v=${name}`,
        title: name,
        uploader: null,
        durationMs: 1000,
        thumbnail: `http://${host}:${port}/cover.png`,
        loudness: null,
      });
      assert.equal(await new Covers({ cache, log }).get(local('refused', '127.0.0.1')), null);
      const allowed = await new Covers({ cache, log, allowPrivate: true }).get(local('allowed', 'localhost'));
      assert.equal(allowed?.type, 'png');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('takes a picture given inline as it is, checked the same way', async () => {
    const png = await fetchPicture(`data:image/png;base64,${PNG.toString('base64')}`, rules);
    assert.equal(png.type, 'png');
    await assert.rejects(
      fetchPicture(`data:image/svg+xml;base64,${SVG.toString('base64')}`, rules),
      /not a picture jukecord keeps/,
    );
    await assert.rejects(fetchPicture('data:image/svg+xml,<svg/>', rules), /not base64/);
    await assert.rejects(
      fetchPicture(`data:image/png;base64,${Buffer.alloc(5000).toString('base64')}`, rules),
      /larger than jukecord keeps/,
    );
  });
});

describe('the covers', () => {
  let dir = '';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-covers-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // A track as the database has it, with a picture's address.
  const track = (name: string, thumbnail: string | null = `https://images.example.com/${name}.png`): Track => ({
    id: 1,
    source: `https://example.com/watch?v=${name}`,
    url: `https://example.com/watch?v=${name}`,
    title: `Track ${name}`,
    uploader: null,
    durationMs: 1000,
    thumbnail,
    loudness: null,
  });

  it('fetches a cover once however many ask, keeps it in the cache and sends it from there after', async () => {
    const cache = new MediaCache({ dir, maxBytes: 1024 ** 2, log });
    cache.init();
    let asked = 0;
    let finish: (picture: Picture) => void = () => {};
    const covers = new Covers({
      cache,
      log,
      fetch: () => {
        asked += 1;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    const one = track('a');
    const both = [covers.get(one), covers.get(one)];
    await new Promise((resolve) => setImmediate(resolve));
    finish({ bytes: PNG, type: 'png' });
    const [first, second] = await Promise.all(both);
    assert.equal(asked, 1);
    assert.equal(first?.type, 'png');
    assert.equal(second?.path, first?.path);
    assert.deepEqual(fs.readFileSync(first?.path ?? ''), PNG);
    // From the cache now, without asking the site.
    assert.equal(covers.cached(one)?.path, first?.path);
    assert.equal((await covers.get(one))?.path, first?.path);
    assert.equal(asked, 1);
    // Counted in the cache's size, as a cover of its own.
    assert.equal(cache.size(), PNG.length);
    assert.equal(cache.coverCount(), 1);
    // A track without a picture asks nothing.
    assert.equal(await covers.get(track('b', null)), null);
    assert.equal(asked, 1);
  });

  it('remembers a cover that cannot be had for an hour, and tries a new picture of the track at once', async () => {
    const cache = new MediaCache({ dir, maxBytes: 1024 ** 2, log });
    cache.init();
    let now = 1_000_000;
    let asked = 0;
    const covers = new Covers({
      cache,
      log,
      now: () => now,
      fetch: async () => {
        asked += 1;
        throw new CoverError('the site answered 404');
      },
    });
    assert.equal(await covers.get(track('a')), null);
    assert.equal(await covers.get(track('a')), null);
    assert.equal(asked, 1);
    // Looked up again with another picture: that one is tried.
    assert.equal(await covers.get(track('a', 'https://images.example.com/other.png')), null);
    assert.equal(asked, 2);
    now += 3_600_000;
    assert.equal(await covers.get(track('a')), null);
    assert.equal(asked, 3);
  });

  it('fetches a few at once and refuses more than its line holds, or than it can start in time', async () => {
    const cache = new MediaCache({ dir, maxBytes: 1024 ** 2, log });
    cache.init();
    const pending: ((picture: Picture) => void)[] = [];
    const covers = new Covers({
      cache,
      log,
      concurrency: 1,
      waitingMax: 1,
      waitMs: 300,
      fetch: () => new Promise((resolve) => pending.push(resolve)),
    });
    const running = covers.get(track('a'));
    const waiting = covers.get(track('b'));
    await assert.rejects(covers.get(track('c')), BusyError);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pending.length, 1);
    // The one in line waits no longer than its limit while the first does not finish.
    await assert.rejects(waiting, BusyError);
    pending[0]?.({ bytes: PNG, type: 'png' });
    assert.equal((await running)?.type, 'png');
    // With the place free again, the next one starts at once.
    const next = covers.get(track('d'));
    await new Promise((resolve) => setImmediate(resolve));
    pending[1]?.({ bytes: PNG, type: 'png' });
    assert.equal((await next)?.type, 'png');
  });
});

describe('covers in the media cache', () => {
  let dir = '';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-cache-covers-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Puts a track's audio of `bytes` into the cache.
  const audio = (cache: MediaCache, key: string, bytes: number) => {
    const tmp = cache.tmpPath(key);
    fs.writeFileSync(tmp, Buffer.alloc(bytes));
    cache.commit(key, tmp, { source: key, durationMs: 1000, loudness: null });
  };

  it('evicts covers and audio by their own last use, keeps a pinned key whole, and counts both in the limit', () => {
    let now = 1000;
    const cache = new MediaCache({ dir, maxBytes: 3000, log, now: () => now });
    cache.init();
    const [a, b, c] = ['a', 'b', 'c'].map((letter) => letter.repeat(32)) as [string, string, string];
    audio(cache, a, 1000);
    now += 1;
    cache.putCover(a, Buffer.alloc(1000, 1), 'jpg');
    now += 1;
    audio(cache, b, 1000);
    assert.equal(cache.size(), 3000);
    now += 1;
    // a's audio is the oldest use: it goes first, and its cover (used later) stays.
    cache.putCover(b, Buffer.alloc(500, 1), 'png');
    assert.equal(cache.has(a), false);
    assert.ok(cache.cover(a));
    assert.equal(cache.size(), 2500);
    // Pinned (playing), b keeps its audio and its cover; a's cover goes for c's audio.
    cache.pin(b);
    now += 1;
    audio(cache, c, 1000);
    assert.equal(cache.cover(a), null);
    assert.ok(cache.has(b) && cache.cover(b) && cache.has(c));
    assert.equal(fs.existsSync(path.join(dir, `${a}.cover.jpg`)), false);
  });

  it('finds its covers again after a restart, keeping the newer of two and dropping half-written ones', () => {
    const first = new MediaCache({ dir, maxBytes: 10_000, log });
    first.init();
    const key = 'd'.repeat(32);
    first.putCover(key, PNG, 'png');
    // A newer cover of another type written just before a crash removed the old one, and a cover cut short.
    const later = path.join(dir, `${key}.cover.jpg`);
    fs.writeFileSync(later, JPEG);
    fs.utimesSync(later, Date.now() / 1000 + 60, Date.now() / 1000 + 60);
    fs.writeFileSync(path.join(dir, `${key}.1234.tmp.cover`), 'part');
    const second = new MediaCache({ dir, maxBytes: 10_000, log });
    second.init();
    assert.equal(second.cover(key)?.type, 'jpg');
    assert.equal(second.coverCount(), 1);
    assert.equal(second.size(), JPEG.length);
    assert.deepEqual(fs.readdirSync(dir).sort(), [`${key}.cover.jpg`]);
    // A cover of another type replaces the one there, on the disk too.
    second.putCover(key, PNG, 'png');
    assert.deepEqual(fs.readdirSync(dir).sort(), [`${key}.cover.png`]);
    assert.equal(second.size(), PNG.length);
  });
});
