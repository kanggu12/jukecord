/**
 * The search operation over HTTP: who may search, words only, the results without internal fields, and the rate of
 * searches that a login is held to beside its reads.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { API_PREFIX } from '../../src/web/api.ts';
import { ALICE, asHost, exampleTrack, GUILD, sessionFor, type TestServer, testServer } from '../support/web.ts';

const api = (path: string) => `${API_PREFIX}${path}`;

describe('searching over HTTP', () => {
  let server: TestServer;
  // The rate's clock, moved by hand.
  let now = 0;

  before(async () => {
    server = await testServer({
      searched: { 'example words': [exampleTrack('a'), exampleTrack('b'), exampleTrack('c')] },
      rates: { searches: { perSecond: 1, burst: 2 }, now: () => now },
    });
    server.directory.join(GUILD, ALICE);
  });
  after(() => server.close());

  it('answers what was found, each with the address that adds it and nothing internal', async () => {
    const answer = await server.web.app.inject({
      method: 'GET',
      url: api(`/guilds/${GUILD}/search?q=${encodeURIComponent('  example   words ')}&limit=2`),
      headers: asHost,
    });
    assert.equal(answer.statusCode, 200);
    assert.deepEqual(answer.json(), {
      query: 'example words',
      results: [
        {
          url: 'https://example.com/watch?v=a',
          title: 'Track a',
          uploader: 'Example',
          durationMs: 180_000,
          thumbnail: null,
        },
        {
          url: 'https://example.com/watch?v=b',
          title: 'Track b',
          uploader: 'Example',
          durationMs: 180_000,
          thumbnail: null,
        },
      ],
    });
  });

  it('refuses an address, a read-only token, and a search beyond the limits', async () => {
    const address = await server.web.app.inject({
      method: 'GET',
      url: api(`/guilds/${GUILD}/search?q=${encodeURIComponent('https://example.com/watch?v=a')}`),
      headers: asHost,
    });
    assert.equal(address.statusCode, 400);
    assert.equal(address.json().error.message, 'a search takes words, not an address');
    const tooMany = await server.web.app.inject({
      method: 'GET',
      url: api(`/guilds/${GUILD}/search?q=x&limit=11`),
      headers: asHost,
    });
    assert.equal(tooMany.statusCode, 400);
    const created = await server.web.app.inject({
      method: 'POST',
      url: api('/tokens'),
      headers: asHost,
      payload: { name: 'reader', scope: 'read' },
    });
    const reader = await server.web.app.inject({
      method: 'GET',
      url: api(`/guilds/${GUILD}/search?q=words`),
      headers: { authorization: `Bearer ${created.json().token}` },
    });
    assert.equal(reader.statusCode, 403);
  });

  it("holds a login's searches to their own rate, and lets them go on as it refills", async () => {
    const { cookie } = sessionFor(server, ALICE);
    const search = () =>
      server.web.app.inject({
        method: 'GET',
        url: api(`/guilds/${GUILD}/search?q=example%20words`),
        headers: { cookie },
      });
    assert.equal((await search()).statusCode, 200);
    assert.equal((await search()).statusCode, 200);
    // The burst of two is spent: the third waits, and says for how long.
    const refused = await search();
    assert.equal(refused.statusCode, 429);
    assert.equal(refused.json().error.message, 'too many searches at once; try again in a moment');
    assert.equal(refused.headers['retry-after'], '1');
    // Other reads are not held by it.
    assert.equal(
      (await server.web.app.inject({ method: 'GET', url: api(`/guilds/${GUILD}/queue`), headers: { cookie } }))
        .statusCode,
      200,
    );
    now += 1000;
    assert.equal((await search()).statusCode, 200);
  });
});
