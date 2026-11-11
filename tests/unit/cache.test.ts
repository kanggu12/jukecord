import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createLogger } from '../../src/log.ts';
import { MediaCache } from '../../src/media/cache.ts';

const log = createLogger({ level: 'error', sinks: [] });
let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-cache-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// Puts a track of `bytes` into the cache at time `at`.
function put(cache: MediaCache, source: string, bytes: number): string {
  const key = MediaCache.keyOf(source);
  const tmp = cache.tmpPath(key);
  fs.writeFileSync(tmp, Buffer.alloc(bytes));
  cache.commit(key, tmp, { source, durationMs: 1000, loudness: -12 });
  return key;
}

describe('MediaCache', () => {
  it('evicts the least recently used files first, never pinned ones', () => {
    let now = 1000;
    const cache = new MediaCache({ dir, maxBytes: 3000, log, now: () => now });
    cache.init();
    const a = put(cache, 'https://example.com/a', 1000);
    now += 1;
    const b = put(cache, 'https://example.com/b', 1000);
    now += 1;
    const c = put(cache, 'https://example.com/c', 1000);
    now += 1;
    // a is used again, so b is now the oldest; b is pinned (playing), so c goes instead when d arrives.
    cache.get(a);
    cache.pin(b);
    now += 1;
    const d = put(cache, 'https://example.com/d', 1000);
    assert.deepEqual(
      [a, b, c, d].map((key) => cache.has(key)),
      [true, true, false, true],
    );
    assert.equal(fs.existsSync(cache.opusPath(c)), false);
    assert.equal(cache.size(), 3000);
  });

  it('rebuilds itself from the directory and cleans up what a crash left', () => {
    const first = new MediaCache({ dir, maxBytes: 10_000, log });
    first.init();
    const kept = put(first, 'https://example.com/kept', 100);
    // A crash mid-download, an audio file without its description, a description without its audio.
    fs.writeFileSync(path.join(dir, `${kept}.1234.tmp.opus`), 'partial');
    fs.writeFileSync(path.join(dir, `${'a'.repeat(32)}.opus`), 'orphan');
    fs.writeFileSync(path.join(dir, `${'b'.repeat(32)}.json`), '{}');
    const second = new MediaCache({ dir, maxBytes: 10_000, log });
    second.init();
    assert.equal(second.count(), 1);
    assert.equal(second.get(kept)?.durationMs, 1000);
    assert.deepEqual(fs.readdirSync(dir).sort(), [`${kept}.json`, `${kept}.opus`]);
  });

  it('counts an MP3 copy towards the limit', () => {
    const cache = new MediaCache({ dir, maxBytes: 10_000, log });
    cache.init();
    const key = put(cache, 'https://example.com/a', 1000);
    const tmp = cache.tmpPath(key, 'mp3');
    fs.writeFileSync(tmp, Buffer.alloc(500));
    cache.addMp3(key, tmp);
    assert.equal(cache.hasMp3(key), true);
    assert.equal(cache.size(), 1500);
  });
});
