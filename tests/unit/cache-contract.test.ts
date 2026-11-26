/**
 * The cache port's one contract, kept by both adapters: the memory one always, the Redis one when
 * JUKECORD_TEST_BUS_URL names a Redis or Valkey server. Ages, one-time values, counters with a window, and token
 * buckets that take from every bucket or none, on the clock that adapter counts by (the server's, for Redis).
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, describe, it } from 'node:test';
import type { Cache } from '../../src/cache/cache.ts';
import { MemoryCache } from '../../src/cache/memory.ts';
import { openCache } from '../../src/cache/open.ts';
import { RedisCache } from '../../src/cache/redis.ts';
import { MetricsRegistry } from '../../src/metrics/registry.ts';
import { type SharedCacheReport, sharedCacheReport } from '../../src/metrics/services.ts';
import { settle, TEST_BUS_URL, testLog } from '../support/bus.ts';

// The adapters to run the contract on, each made fresh under a prefix of its own (and reporting where it is told).
const adapters: { name: string; make: (report?: SharedCacheReport) => Promise<Cache> }[] = [
  { name: 'memory', make: async (report) => new MemoryCache(report ? { report } : {}) },
];
const serverUrl = TEST_BUS_URL;
if (serverUrl) {
  adapters.push({
    name: 'redis',
    make: (report) =>
      RedisCache.open(serverUrl, {
        prefix: `jukecord-test-${randomBytes(4).toString('hex')}`,
        log: testLog().log,
        service: 'test',
        waitMs: 5000,
        ...(report ? { report } : {}),
      }),
  });
}

for (const { name, make } of adapters) {
  describe(`the ${name} cache`, () => {
    const made: Cache[] = [];
    const cache = async () => {
      const one = await make();
      made.push(one);
      return one;
    };
    after(async () => {
      for (const one of made) await one.close();
    });

    it('keeps a value for its age, and nothing after', async () => {
      const c = await cache();
      await c.set('a', 'one', 600);
      assert.equal(await c.get('a'), 'one');
      assert.equal(await c.get('missing'), null);
      await settle(700);
      assert.equal(await c.get('a'), null);
    });

    it('adds only to an empty key (an expired one is empty), and deletes', async () => {
      const c = await cache();
      assert.equal(await c.add('lock', 'first', 600), true);
      assert.equal(await c.add('lock', 'second', 600), false);
      assert.equal(await c.get('lock'), 'first');
      await settle(700);
      assert.equal(await c.add('lock', 'third', 5000), true);
      await c.delete('lock');
      assert.equal(await c.get('lock'), null);
      // Deleting nothing is no mistake.
      await c.delete('lock');
    });

    it('gives a one-time value to the first of two takers only', async () => {
      const c = await cache();
      await c.set('code', 'link', 60_000);
      const answers = await Promise.all([c.take('code'), c.take('code')]);
      assert.deepEqual(answers.sort(), [null, 'link'].sort());
      assert.equal(await c.get('code'), null);
    });

    it('counts in a window that closes when its first count is that old', async () => {
      const c = await cache();
      assert.equal(await c.increment('fail', 1000), 1);
      assert.equal(await c.increment('fail', 1000, 2), 3);
      await settle(100);
      // A later increment does not move the window's end.
      assert.equal(await c.increment('fail', 1000), 4);
      await settle(1000);
      assert.equal(await c.increment('fail', 1000), 1);
    });

    it('takes back from a counter, and never makes one by taking back', async () => {
      const c = await cache();
      // Nothing to take back from: no counter is made (one at -1 would give a window of more tries than its limit).
      assert.equal(await c.increment('tries', 600, -1), 0);
      assert.equal(await c.get('tries'), null);
      assert.equal(await c.increment('tries', 600), 1);
      assert.equal(await c.increment('tries', 600, -1), 0);
      assert.equal(await c.get('tries'), '0');
      // Once its window has closed, there is nothing to take back from again.
      await settle(700);
      assert.equal(await c.increment('tries', 600, -1), 0);
      assert.equal(await c.get('tries'), null);
    });

    it('takes a token from every bucket or from none, and says how long to wait', async () => {
      const c = await cache();
      // A token every hundred seconds: nothing comes back while the test runs, however slow the machine.
      const rate = { perSecond: 0.01, burst: 2 };
      assert.equal(await c.spend(['person', 'address'], rate), 0);
      assert.equal(await c.spend(['person', 'address'], rate), 0);
      // Both empty: up to a hundred seconds until a token is back.
      const wait = await c.spend(['person', 'address'], rate);
      assert.ok(wait > 90_000 && wait <= 100_000, `${wait} ms to wait`);
      // Another person behind the same address: refused for the address, and nothing taken from the new bucket.
      assert.ok((await c.spend(['other', 'address'], rate)) > 0);
      assert.equal(await c.spend(['other'], rate), 0);
      assert.equal(await c.spend(['other'], rate), 0);
      assert.ok((await c.spend(['other'], rate)) > 0);
    });

    it('brings tokens back at the steady rate', async () => {
      const c = await cache();
      const rate = { perSecond: 20, burst: 1 };
      assert.equal(await c.spend(['steady'], rate), 0);
      // A twentieth of a second later (and more if the machine is slow), the token is back.
      await settle(80);
      assert.equal(await c.spend(['steady'], rate), 0);
    });

    it('gives a refused request its token back, never past the burst', async () => {
      const c = await cache();
      const rate = { perSecond: 0.01, burst: 1 };
      assert.equal(await c.spend(['a'], rate), 0);
      await c.refund(['a'], rate);
      assert.equal(await c.spend(['a'], rate), 0);
      assert.ok((await c.spend(['a'], rate)) > 0);
      // A bucket never seen is full, and a refund cannot fill it past that.
      await c.refund(['b'], rate);
      await c.refund(['b'], rate);
      assert.equal(await c.spend(['b'], rate), 0);
      assert.ok((await c.spend(['b'], rate)) > 0);
    });

    it('keeps values and buckets apart under the same key', async () => {
      const c = await cache();
      await c.set('same', 'value', 60_000);
      assert.equal(await c.spend(['same'], { perSecond: 1, burst: 1 }), 0);
      assert.equal(await c.get('same'), 'value');
      assert.equal(await c.ping(), true);
    });
  });
}

describe('the Redis cache on a shared server', { skip: !TEST_BUS_URL && 'JUKECORD_TEST_BUS_URL is not set' }, () => {
  it('keeps two jukecords apart by their prefixes', async () => {
    const { log } = testLog();
    const open = (prefix: string) =>
      RedisCache.open(TEST_BUS_URL ?? '', { prefix, log, service: 'test', waitMs: 5000 });
    const tag = randomBytes(4).toString('hex');
    const one = await open(`jukecord-test-${tag}-one`);
    const two = await open(`jukecord-test-${tag}-two`);
    try {
      await one.set('k', 'mine', 60_000);
      assert.equal(await two.get('k'), null);
      assert.equal(await one.spend(['b'], { perSecond: 0.01, burst: 1 }), 0);
      assert.equal(await two.spend(['b'], { perSecond: 0.01, burst: 1 }), 0);
    } finally {
      await one.close();
      await two.close();
    }
  });
});

describe('the memory cache and the system clock', () => {
  it('counts its rates on the steady clock: a system clock set back empties no bucket', async () => {
    // The system clock as jukecord would see it, which this test sets back; in place before the cache is made, as the
    // system's is.
    const realNow = Date.now;
    let back = 0;
    Date.now = () => realNow() - back;
    const cache = new MemoryCache();
    try {
      const rate = { perSecond: 10, burst: 2 };
      assert.equal(await cache.spend(['someone'], rate), 0);
      back = 600_000;
      // Ten minutes back, one token still in the bucket: no wait, and after it at most a tenth of a second.
      assert.equal(await cache.spend(['someone'], rate), 0);
      const wait = await cache.spend(['someone'], rate);
      assert.ok(wait <= 100, `${wait} ms to wait`);
    } finally {
      Date.now = realNow;
      await cache.close();
    }
  });
});

describe("the shared cache's report", () => {
  for (const { name, make } of adapters) {
    it(`${name}: counts every read as found or not, in the same families either way`, async () => {
      const metrics = new MetricsRegistry();
      const cache = await make(sharedCacheReport(metrics));
      try {
        await cache.set('a', '1', 60_000);
        await cache.get('a');
        await cache.get('b');
        await cache.take('a');
        await cache.take('a');
        const text = metrics.render();
        assert.match(text, /jukecord_shared_cache_lookups_total\{result="hit"\} 2/);
        assert.match(text, /jukecord_shared_cache_lookups_total\{result="miss"\} 2/);
        assert.match(text, /jukecord_shared_cache_errors_total 0/);
      } finally {
        await cache.close();
      }
    });
  }

  it('redis: counts a call to a server that cannot answer it as a failure, and passes the failure on', {
    skip: !serverUrl,
  }, async () => {
    const metrics = new MetricsRegistry();
    const cache = await (adapters.find((adapter) => adapter.name === 'redis')?.make(sharedCacheReport(metrics)) ??
      Promise.reject(new Error('no Redis')));
    await cache.close();
    await assert.rejects(cache.get('a'));
    await assert.rejects(cache.spend(['x'], { perSecond: 1, burst: 1 }));
    assert.match(metrics.render(), /jukecord_shared_cache_errors_total 2/);
  });

  it('is what a process opens: memory unless a server is named', async () => {
    const cache = await openCache({ url: 'memory', prefix: 'jukecord', log: testLog().log, service: 'test' });
    assert.equal(cache.kind, 'memory');
    await cache.close();
  });
});
