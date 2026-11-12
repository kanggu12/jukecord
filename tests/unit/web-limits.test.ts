import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import type { InjectOptions } from 'fastify';
import { MediaCache } from '../../src/media/cache.ts';
import { API_PREFIX } from '../../src/web/api.ts';
import { CSRF_HEADER } from '../../src/web/auth.ts';
import { Buckets, Pressure } from '../../src/web/limits.ts';
import { ALICE, asHost, exampleTrack, GUILD, sessionFor, testServer } from '../support/web.ts';

const api = (path: string) => `${API_PREFIX}${path}`;

describe('Buckets', () => {
  it('lets a burst through, then the steady rate, and says how long to wait', () => {
    let now = 0;
    const buckets = new Buckets({ perSecond: 10, burst: 20 }, { now: () => now });
    for (let i = 0; i < 20; i += 1) {
      assert.equal(buckets.wait(['a']), 0);
      buckets.take(['a']);
    }
    // Empty: one token comes back every 100 ms.
    assert.equal(buckets.wait(['a']), 100);
    now += 100;
    assert.equal(buckets.wait(['a']), 0);
    // Every key must have one: a full bucket beside an empty one still waits.
    assert.equal(buckets.wait(['b']), 0);
    buckets.take(['a']);
    assert.equal(buckets.wait(['b', 'a']), 100);
    // After a quiet while it is full again, never fuller.
    now += 60_000;
    for (let i = 0; i < 20; i += 1) buckets.take(['a']);
    assert.ok(buckets.wait(['a']) > 0);
  });

  it('keeps at most its capacity of keys, forgetting the least recently used', () => {
    const buckets = new Buckets({ perSecond: 1, burst: 1 }, { now: () => 0, capacity: 2 });
    buckets.take(['a']);
    buckets.take(['b']);
    buckets.take(['c']);
    // "a" was forgotten, so it is full again; "c" is not.
    assert.equal(buckets.wait(['a']), 0);
    assert.ok(buckets.wait(['c']) > 0);
  });
});

describe('Pressure', () => {
  it('is behind for the window after the event loop was held up, and not once it runs freely again', async () => {
    const pressure = new Pressure({ limitMs: 150, everyMs: 200 });
    try {
      const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      await settle(250);
      assert.equal(pressure.behind, false);
      // The main thread held for 300 ms, as a long synchronous job would.
      const until = Date.now() + 300;
      while (Date.now() < until) {
        // Busy on purpose.
      }
      await settle(150);
      assert.equal(pressure.behind, true, `${pressure.delayMs} ms`);
      await settle(450);
      assert.equal(pressure.behind, false, `${pressure.delayMs} ms`);
    } finally {
      pressure.stop();
    }
  });
});

describe('the rates of changes and shedding when behind', () => {
  it('holds a login to its rate with 429 and Retry-After, the host not at all, and reads not at all', async () => {
    let now = 1_000_000;
    const server = await testServer({ rates: { now: () => now } });
    try {
      server.directory.join(GUILD, ALICE);
      const alice = sessionFor(server, ALICE);
      const asAlice = { cookie: alice.cookie, [CSRF_HEADER]: alice.csrf };
      const shuffle = (headers: Record<string, string>, remoteAddress = '10.1.0.1') =>
        server.web.app.inject({ method: 'POST', url: api(`/guilds/${GUILD}/queue/shuffle`), headers, remoteAddress });
      // Twenty at once pass (the burst), the next is refused with a clear code and when to try again.
      for (let i = 0; i < 20; i += 1) assert.equal((await shuffle(asAlice)).statusCode, 200);
      const refused = await shuffle(asAlice);
      assert.equal(refused.statusCode, 429);
      assert.deepEqual(refused.json(), {
        error: { code: 'rate-limited', message: 'too many changes at once; try again in a moment' },
      });
      assert.equal(refused.headers['retry-after'], '1');
      // Reading is not a change: the queue still answers.
      const read = await server.web.app.inject({
        method: 'GET',
        url: api(`/guilds/${GUILD}/queue`),
        headers: { cookie: alice.cookie },
        remoteAddress: '10.1.0.1',
      });
      assert.equal(read.statusCode, 200);
      // A tenth of a second later one more fits.
      now += 100;
      assert.equal((await shuffle(asAlice)).statusCode, 200);
      // The host's own command line is not held to it.
      for (let i = 0; i < 50; i += 1) assert.equal((await shuffle(asHost)).statusCode, 200);
    } finally {
      await server.close();
    }
  });

  it('counts an address across its logins, and skips against a tighter rate', async () => {
    const server = await testServer({ rates: { now: () => 5_000 } });
    try {
      server.directory.join(GUILD, ALICE);
      const sessions = [sessionFor(server, ALICE), sessionFor(server, ALICE)];
      const change = (session: { cookie: string; csrf: string }, path: string, remoteAddress: string) =>
        server.web.app.inject({
          method: 'POST',
          url: api(`/guilds/${GUILD}${path}`),
          headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrf },
          remoteAddress,
        } as InjectOptions);
      const [first, second] = sessions;
      assert.ok(first && second);
      // Fifteen from one login and five from another, both from one address: the address has had its twenty.
      for (let i = 0; i < 15; i += 1) await change(first, '/queue/shuffle', '10.2.0.1');
      for (let i = 0; i < 5; i += 1) assert.equal((await change(second, '/queue/shuffle', '10.2.0.1')).statusCode, 200);
      assert.equal((await change(second, '/queue/shuffle', '10.2.0.1')).statusCode, 429);
      // Skips: five at once (each answered, here "nothing is playing"), then the tighter rate refuses.
      for (let i = 0; i < 5; i += 1) assert.equal((await change(second, '/player/skip', '10.2.0.2')).statusCode, 409);
      const refused = await change(second, '/player/skip', '10.2.0.2');
      assert.equal(refused.statusCode, 429);
      assert.equal(refused.json().error.message, 'too many skips at once; try again in a moment');
      assert.equal(refused.headers['retry-after'], '1');
    } finally {
      await server.close();
    }
  });

  it('turns away audio and changes from anyone but the host while behind, and nothing a panel needs to come back', async () => {
    let behind = false;
    const server = await testServer({ behind: () => behind });
    try {
      server.directory.join(GUILD, ALICE);
      const alice = sessionFor(server, ALICE);
      const track = server.store.tracks.upsert(exampleTrack('shed'));
      server.queue.add(GUILD, [track.id], 'end', null);
      const key = MediaCache.keyOf(track.source);
      const tmp = server.cache.tmpPath(key);
      fs.writeFileSync(tmp, Buffer.alloc(1000, 7));
      server.cache.commit(key, tmp, { source: track.source, durationMs: 1000, loudness: null });
      const inject = (options: InjectOptions) => server.web.app.inject(options);
      const audio = { method: 'GET' as const, url: api(`/guilds/${GUILD}/tracks/${track.id}/audio`), headers: asHost };
      assert.equal((await inject(audio)).statusCode, 200);
      behind = true;
      const shed = await inject(audio);
      assert.equal(shed.statusCode, 503);
      assert.deepEqual(shed.json(), { error: { code: 'busy', message: 'jukecord is busy; try again in a moment' } });
      assert.equal(shed.headers['retry-after'], '2');
      const change = await inject({
        method: 'POST',
        url: api(`/guilds/${GUILD}/queue/shuffle`),
        headers: { cookie: alice.cookie, [CSRF_HEADER]: alice.csrf },
      });
      assert.equal(change.statusCode, 503);
      // The host's changes, the reads a panel needs to come back, the health checks and logging in still answer.
      const host = await inject({ method: 'POST', url: api(`/guilds/${GUILD}/queue/shuffle`), headers: asHost });
      assert.equal(host.statusCode, 200);
      for (const url of [api('/me'), api('/guilds'), api(`/guilds/${GUILD}/queue`), api(`/guilds/${GUILD}/player`)]) {
        assert.equal((await inject({ method: 'GET', url, headers: { cookie: alice.cookie } })).statusCode, 200, url);
      }
      assert.equal((await inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
      assert.equal((await inject({ method: 'GET', url: '/readyz' })).statusCode, 200);
      const link = server.auth.createLink();
      assert.equal((await inject({ method: 'GET', url: `/auth/link/${link.code}` })).headers.location, '/');
    } finally {
      await server.close();
    }
  });
});
