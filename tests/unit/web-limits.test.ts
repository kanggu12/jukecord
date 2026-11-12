import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import type { InjectOptions } from 'fastify';
import { MediaCache } from '../../src/media/cache.ts';
import { API_PREFIX } from '../../src/web/api.ts';
import { CSRF_HEADER } from '../../src/web/auth.ts';
import { Buckets, Pressure } from '../../src/web/limits.ts';
import { ALICE, asHost, BOB, DJ_ROLE, exampleTrack, GUILD, sessionFor, testServer } from '../support/web.ts';

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

  it('is not thrown by the system clock being set back', () => {
    // The system clock as jukecord would see it, which this test sets back; in place before the buckets are made, as
    // the system's is.
    const realNow = Date.now;
    let back = 0;
    Date.now = () => realNow() - back;
    try {
      const buckets = new Buckets({ perSecond: 10, burst: 2 });
      buckets.take(['someone']);
      back = 600_000;
      // Ten minutes back, one token still in the bucket: no wait, and after it at most a tenth of a second.
      assert.equal(buckets.wait(['someone']), 0);
      buckets.take(['someone']);
      assert.ok(buckets.wait(['someone']) <= 100, `${buckets.wait(['someone'])} ms to wait`);
    } finally {
      Date.now = realNow;
    }
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
  it('holds a login to its rate with 429 and Retry-After, the host not at all, and reads to their own', async () => {
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
      // Reading is not a change (reads have a rate of their own): the queue still answers.
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

  it('holds reads to a wider rate of their own, a person by themself, a request without a login by its address', async () => {
    let now = 2_000_000;
    const server = await testServer({ rates: { now: () => now } });
    try {
      server.directory.join(GUILD, ALICE);
      server.directory.join(GUILD, BOB);
      const alice = sessionFor(server, ALICE);
      const read = (headers: Record<string, string>, remoteAddress = '10.2.0.1') =>
        server.web.app.inject({ method: 'GET', url: api(`/guilds/${GUILD}/stats?days=365`), headers, remoteAddress });
      // Sixty at once pass (a panel reads a handful when it opens), the next is refused until one has come back.
      for (let i = 0; i < 60; i += 1) assert.equal((await read({ cookie: alice.cookie })).statusCode, 200);
      const refused = await read({ cookie: alice.cookie });
      assert.equal(refused.statusCode, 429);
      assert.deepEqual(refused.json(), {
        error: { code: 'rate-limited', message: 'too many requests at once; try again in a moment' },
      });
      // A second login of the same person (another browser, a token) shares that person's share.
      const again = sessionFor(server, ALICE);
      assert.equal((await read({ cookie: again.cookie })).statusCode, 429);
      now += 34;
      assert.equal((await read({ cookie: alice.cookie })).statusCode, 200);
      // Someone else behind the same address (a household, an office, Docker's bridge, a proxy not trusted) has a
      // share of their own: fifteen panels opening at once behind one address were refused, and a refused /me shows
      // the panel's start-failed page.
      const bob = sessionFor(server, BOB);
      for (let i = 0; i < 60; i += 1) assert.equal((await read({ cookie: bob.cookie })).statusCode, 200);
      // Without a login, the address alone counts, apart from the people there.
      const status = (remoteAddress: string) =>
        server.web.app.inject({ method: 'GET', url: api('/status'), remoteAddress });
      for (let i = 0; i < 60; i += 1) assert.equal((await status('10.2.0.1')).statusCode, 200);
      assert.equal((await status('10.2.0.1')).statusCode, 429);
      assert.equal((await status('10.2.0.9')).statusCode, 200);
      // The host's own command line is held to none of it.
      for (let i = 0; i < 100; i += 1) assert.equal((await read(asHost)).statusCode, 200);
    } finally {
      await server.close();
    }
  });

  it("leaves a refused change's share of the address to the others there", async () => {
    const server = await testServer({ rates: { now: () => 7_000 } });
    try {
      // Alice is not a DJ, Bob is; both are behind one address (a household, an office).
      server.directory.join(GUILD, ALICE);
      server.directory.join(GUILD, BOB, { roles: [DJ_ROLE] });
      server.store.settings.setDjRole(GUILD, DJ_ROLE);
      const alice = sessionFor(server, ALICE);
      const bob = sessionFor(server, BOB);
      const shuffle = (session: { cookie: string; csrf: string }) =>
        server.web.app.inject({
          method: 'POST',
          url: api(`/guilds/${GUILD}/queue/shuffle`),
          headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrf },
          remoteAddress: '10.3.0.1',
        });
      // Alice's refusals use up her own share, not the address's: she is held to the rate, Bob is not.
      for (let i = 0; i < 20; i += 1) assert.equal((await shuffle(alice)).statusCode, 403);
      assert.equal((await shuffle(alice)).statusCode, 429);
      assert.equal((await shuffle(bob)).statusCode, 200);
    } finally {
      await server.close();
    }
  });

  it("keeps a refused change's share of the address when the refusal came after a lookup", async () => {
    const server = await testServer({ rates: { now: () => 9_000 }, nothingFound: ['no such song'] });
    try {
      // Two people behind one address; Alice searches for something that is not there, again and again.
      server.directory.join(GUILD, ALICE);
      server.directory.join(GUILD, BOB);
      const alice = sessionFor(server, ALICE);
      const bob = sessionFor(server, BOB);
      const add = (session: { cookie: string; csrf: string }, input: string) =>
        server.web.app.inject({
          method: 'POST',
          url: api(`/guilds/${GUILD}/queue`),
          headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrf },
          payload: { input },
          remoteAddress: '10.4.0.1',
        });
      // Each one ran a search (yt-dlp, the network): a refusal that cost what a lookup costs counts against the
      // address too, so a person with several logins or tokens behind it still meets the address's brake.
      for (let i = 0; i < 20; i += 1) assert.equal((await add(alice, 'no such song')).statusCode, 404);
      assert.equal((await add(bob, 'no such song')).statusCode, 429);
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

  it('turns away audio, and changes from anyone but the host, while behind; nothing a panel needs to come back', async () => {
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
