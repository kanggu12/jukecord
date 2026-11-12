import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { InjectOptions } from 'fastify';
import { CoverError } from '../../src/media/covers.ts';
import { API_PREFIX } from '../../src/web/api.ts';
import {
  ALICE,
  asHost,
  BOB,
  exampleTrack,
  GUILD,
  OTHER_GUILD,
  sessionFor,
  type TestServer,
  testServer,
} from '../support/web.ts';

const api = (path: string) => `${API_PREFIX}${path}`;

// The smallest PNG there is (one pixel).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

// A track with a picture on a made-up image host.
const pictured = (name: string) => ({ ...exampleTrack(name), thumbnail: `https://images.example.com/${name}.png` });

// A server whose made-up image host has one picture for each of these tracks, and none for "gone".
async function serverWithPictures(rates?: { covers: { perSecond: number; burst: number } }): Promise<TestServer> {
  const pictures = Object.fromEntries(
    ['queued', 'played', 'saved', 'other', 'cached', 'busy', 'one', 'two'].map((name) => [
      `https://images.example.com/${name}.png`,
      { bytes: PNG, type: 'png' as const },
    ]),
  );
  pictures['https://images.example.com/gone.png'] = new CoverError('the site answered 404') as never;
  const server = await testServer({ pictures, ...(rates ? { rates } : {}) });
  server.directory.join(GUILD, ALICE);
  return server;
}

describe('covers through jukecord', () => {
  it("sends the cover of a track the server shows, fetched once, and nothing of another server's", async () => {
    const server = await serverWithPictures();
    const inject = (options: InjectOptions) => server.web.app.inject(options);
    try {
      const { store, queue } = server;
      const queued = store.tracks.upsert(pictured('queued'));
      const url = api(`/guilds/${GUILD}/tracks/${queued.id}/cover`);
      // Not in the server at all yet: nothing is fetched for it.
      assert.equal((await inject({ method: 'GET', url, headers: asHost })).statusCode, 404);
      assert.deepEqual(server.pictureRequests, []);
      queue.add(GUILD, [queued.id], 'end', null);
      const first = await inject({ method: 'GET', url, headers: asHost });
      assert.equal(first.statusCode, 200);
      assert.equal(first.headers['content-type'], 'image/png');
      assert.deepEqual(first.rawPayload, PNG);
      assert.equal(first.headers['cache-control'], 'private, max-age=86400');
      assert.deepEqual(server.pictureRequests, ['https://images.example.com/queued.png']);
      // From the cache after: the site is not asked again, and a browser that has it hears "not modified".
      const again = await inject({ method: 'GET', url, headers: { ...asHost, 'if-none-match': first.headers.etag } });
      assert.equal(again.statusCode, 304);
      assert.equal(server.pictureRequests.length, 1);
      // Played once, or only in a saved playlist: shown in the history and the playlists, so served too.
      const played = store.tracks.upsert(pictured('played'));
      store.history.add({ guildId: GUILD, trackId: played.id, addedBy: null, playedAt: 1, playedMs: 60_000 });
      const saved = store.tracks.upsert(pictured('saved'));
      store.playlists.save(GUILD, 'Later', [saved.id], null);
      for (const id of [played.id, saved.id]) {
        const answer = await inject({
          method: 'GET',
          url: api(`/guilds/${GUILD}/tracks/${id}/cover`),
          headers: asHost,
        });
        assert.equal(answer.statusCode, 200, String(id));
      }
      // Through another server's path, which does not have it.
      const elsewhere = await inject({
        method: 'GET',
        url: api(`/guilds/${OTHER_GUILD}/tracks/${queued.id}/cover`),
        headers: asHost,
      });
      assert.equal(elsewhere.statusCode, 404);
      assert.equal(elsewhere.json().error.message, 'that track is not in this server');
      // A member of the server may see it; someone who is not, cannot ask; nobody logged in neither.
      const alice = sessionFor(server, ALICE);
      assert.equal((await inject({ method: 'GET', url, headers: { cookie: alice.cookie } })).statusCode, 200);
      const bob = sessionFor(server, BOB);
      assert.equal((await inject({ method: 'GET', url, headers: { cookie: bob.cookie } })).statusCode, 403);
      assert.equal((await inject({ method: 'GET', url })).statusCode, 401);
      // Numbers that are not a track's are not looked for.
      for (const odd of ['abc', '0', '1.5', '99999999999999999999']) {
        const answer = await inject({
          method: 'GET',
          url: api(`/guilds/${GUILD}/tracks/${odd}/cover`),
          headers: asHost,
        });
        assert.equal(answer.statusCode, 404, odd);
      }
    } finally {
      await server.close();
    }
  });

  it('says a cover that cannot be had is not there, for an hour, without asking the site again', async () => {
    const server = await serverWithPictures();
    try {
      const gone = server.store.tracks.upsert(pictured('gone'));
      const bare = server.store.tracks.upsert(exampleTrack('bare'));
      server.queue.add(GUILD, [gone.id, bare.id], 'end', null);
      for (let round = 0; round < 2; round += 1) {
        const answer = await server.web.app.inject({
          method: 'GET',
          url: api(`/guilds/${GUILD}/tracks/${gone.id}/cover`),
          headers: asHost,
        });
        assert.equal(answer.statusCode, 404);
        assert.equal(answer.json().error.message, 'that track has no cover');
        assert.equal(answer.headers['cache-control'], 'private, max-age=3600');
      }
      assert.deepEqual(server.pictureRequests, ['https://images.example.com/gone.png']);
      // A track the site gave no picture for asks nothing at all.
      const none = await server.web.app.inject({
        method: 'GET',
        url: api(`/guilds/${GUILD}/tracks/${bare.id}/cover`),
        headers: asHost,
      });
      assert.equal(none.statusCode, 404);
      assert.equal(server.pictureRequests.length, 1);
    } finally {
      await server.close();
    }
  });

  it('holds the covers it must fetch to a rate per login, sends cached ones freely, and the host is not held', async () => {
    const server = await serverWithPictures({ covers: { perSecond: 0.001, burst: 1 } });
    try {
      const [one, two] = [pictured('one'), pictured('two')].map((track) => server.store.tracks.upsert(track));
      if (!one || !two) throw new Error('no tracks');
      server.queue.add(GUILD, [one.id, two.id], 'end', null);
      const alice = sessionFor(server, ALICE);
      const ask = (id: number, headers: Record<string, string>) =>
        server.web.app.inject({ method: 'GET', url: api(`/guilds/${GUILD}/tracks/${id}/cover`), headers });
      assert.equal((await ask(one.id, { cookie: alice.cookie })).statusCode, 200);
      // Cached now: sent again whatever the rate.
      assert.equal((await ask(one.id, { cookie: alice.cookie })).statusCode, 200);
      const held = await ask(two.id, { cookie: alice.cookie });
      assert.equal(held.statusCode, 429);
      assert.ok(Number(held.headers['retry-after']) >= 1);
      assert.equal((await ask(two.id, asHost)).statusCode, 200);
    } finally {
      await server.close();
    }
  });

  it('fetches no cover while jukecord is behind, and still sends the ones it has', async () => {
    let behind = false;
    const server = await testServer({
      pictures: {
        'https://images.example.com/cached.png': { bytes: PNG, type: 'png' },
        'https://images.example.com/busy.png': { bytes: PNG, type: 'png' },
      },
      behind: () => behind,
    });
    try {
      const [cached, busy] = [pictured('cached'), pictured('busy')].map((track) => server.store.tracks.upsert(track));
      if (!cached || !busy) throw new Error('no tracks');
      server.queue.add(GUILD, [cached.id, busy.id], 'end', null);
      const ask = (id: number) =>
        server.web.app.inject({ method: 'GET', url: api(`/guilds/${GUILD}/tracks/${id}/cover`), headers: asHost });
      assert.equal((await ask(cached.id)).statusCode, 200);
      behind = true;
      assert.equal((await ask(cached.id)).statusCode, 200);
      const later = await ask(busy.id);
      assert.equal(later.statusCode, 503);
      assert.equal(later.headers['retry-after'], '2');
      assert.equal(server.pictureRequests.length, 1);
    } finally {
      await server.close();
    }
  });
});
