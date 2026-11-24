import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { MemoryCache } from '../../src/cache/memory.ts';

// A clock the tests move by hand.
function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('MemoryCache', () => {
  const caches: MemoryCache[] = [];
  const make = (options: ConstructorParameters<typeof MemoryCache>[0] = {}) => {
    const cache = new MemoryCache(options);
    caches.push(cache);
    return cache;
  };
  afterEach(async () => {
    for (const cache of caches.splice(0)) await cache.close();
  });

  it('keeps a value until its age runs out', async () => {
    const time = clock();
    const cache = make({ now: time.now });
    await cache.set('a', '1', 1000);
    assert.equal(await cache.get('a'), '1');
    time.advance(999);
    assert.equal(await cache.get('a'), '1');
    time.advance(1);
    assert.equal(await cache.get('a'), null);
  });

  it('adds only to an empty key, and an expired one counts as empty', async () => {
    const time = clock();
    const cache = make({ now: time.now });
    assert.equal(await cache.add('lock', 'first', 100), true);
    assert.equal(await cache.add('lock', 'second', 100), false);
    assert.equal(await cache.get('lock'), 'first');
    time.advance(100);
    assert.equal(await cache.add('lock', 'third', 100), true);
  });

  it('gives a one-time value to the first taker only', async () => {
    const cache = make();
    await cache.set('code', 'link', 60_000);
    const [one, two] = await Promise.all([cache.take('code'), cache.take('code')]);
    assert.deepEqual([one, two], ['link', null]);
  });

  it('counts in a window that closes when the first count is that old', async () => {
    const time = clock();
    const cache = make({ now: time.now });
    assert.equal(await cache.increment('fail', 1000), 1);
    time.advance(600);
    assert.equal(await cache.increment('fail', 1000, 2), 3);
    // A later increment does not move the end of the window.
    time.advance(400);
    assert.equal(await cache.increment('fail', 1000), 1);
  });

  it('drops the least recently used beyond its capacity', async () => {
    const cache = make({ capacity: 2 });
    await cache.set('a', '1', 60_000);
    await cache.set('b', '2', 60_000);
    // Reading a makes b the least recently used.
    await cache.get('a');
    await cache.set('c', '3', 60_000);
    assert.deepEqual([await cache.get('a'), await cache.get('b'), await cache.get('c')], ['1', null, '3']);
  });

  it('spends a token from every bucket or from none, and says how long to wait', async () => {
    const time = clock();
    const cache = make({ now: time.now });
    const rate = { perSecond: 2, burst: 2 };
    assert.equal(await cache.spend(['person', 'address'], rate), 0);
    assert.equal(await cache.spend(['person', 'address'], rate), 0);
    // Both empty: half a second until a token comes back at two a second.
    assert.equal(await cache.spend(['person', 'address'], rate), 500);
    time.advance(500);
    // Another person from the same address: the address bucket is shared, so nothing is taken from the new one.
    assert.equal(await cache.spend(['address'], rate), 0);
    assert.equal(await cache.spend(['other', 'address'], rate), 500);
    assert.equal(await cache.spend(['other'], rate), 0);
  });

  it('gives a refused request its token back, up to the burst', async () => {
    const cache = make({ now: clock().now });
    const rate = { perSecond: 1, burst: 1 };
    assert.equal(await cache.spend(['a'], rate), 0);
    await cache.refund(['a'], rate);
    assert.equal(await cache.spend(['a'], rate), 0);
    // A bucket never seen is full, and a refund cannot overfill it.
    await cache.refund(['b', 'b'], rate);
    assert.equal(await cache.spend(['b'], rate), 0);
    assert.ok((await cache.spend(['b'], rate)) > 0);
  });

  it('answers a ping until it is closed, then refuses every call', async () => {
    const cache = make();
    assert.equal(await cache.ping(), true);
    await cache.close();
    assert.equal(await cache.ping(), false);
    await assert.rejects(cache.get('a'), /closed/);
  });
});
