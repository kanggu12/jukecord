/**
 * How a server's people share the music, over the HTTP API: who may change each setting, and what the answers say.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { InjectOptions } from 'fastify';
import { API_PREFIX } from '../../src/web/api.ts';
import { CSRF_HEADER } from '../../src/web/auth.ts';
import {
  ALICE,
  asHost,
  BOB,
  DJ_ROLE,
  exampleTrack,
  GUILD,
  sessionFor,
  type TestServer,
  testServer,
} from '../support/web.ts';

const api = (path: string) => `${API_PREFIX}${path}`;

describe('the community settings over the API', () => {
  let server: TestServer;

  before(async () => {
    server = await testServer({ found: { one: [exampleTrack('a')] } });
    // Alice may change the music (no DJ role yet) but not the settings; Bob manages the server.
    server.directory.join(GUILD, ALICE);
    server.directory.join(GUILD, BOB, { manage: true });
  });
  after(() => server.close());

  const inject = (options: InjectOptions) => server.web.app.inject(options);
  // A panel session's headers for a change.
  const as = (userId: string) => {
    const { cookie, csrf } = sessionFor(server, userId);
    return { cookie, [CSRF_HEADER]: csrf };
  };

  it('keeps the bot in voice when asked by someone who manages the server, and tells the voice side', async () => {
    const refused = await inject({
      method: 'PUT',
      url: api(`/guilds/${GUILD}/settings/stay`),
      headers: as(ALICE),
      payload: { on: true },
    });
    assert.equal(refused.statusCode, 403);
    assert.equal(refused.json().error.message, 'only people who can manage the server can change this setting');
    const set = await inject({
      method: 'PUT',
      url: api(`/guilds/${GUILD}/settings/stay`),
      headers: as(BOB),
      payload: { on: true },
    });
    assert.equal(set.statusCode, 200);
    assert.equal(set.json().stay, true);
    assert.deepEqual(server.voice.stayed, [GUILD]);
    // Everyone may look, and the host may change it back.
    const shown = await inject({ method: 'GET', url: api(`/guilds/${GUILD}/settings`), headers: as(ALICE) });
    assert.equal(shown.json().stay, true);
    const off = await inject({
      method: 'PUT',
      url: api(`/guilds/${GUILD}/settings/stay`),
      headers: asHost,
      payload: { on: false },
    });
    assert.equal(off.json().stay, false);
  });
});

describe('votes to skip over the API', () => {
  let server: TestServer;

  before(async () => {
    server = await testServer({ found: { two: [exampleTrack('a'), exampleTrack('b')] } });
    // A server with a DJ role: Alice and Bob are in the bot's voice channel without it, Bob manages the server.
    server.directory.join(GUILD, ALICE);
    server.directory.join(GUILD, BOB, { manage: true });
    server.store.settings.setDjRole(GUILD, DJ_ROLE);
    server.voice.inVoice.set(GUILD, [ALICE, BOB, '300000000000000003']);
  });
  after(() => server.close());

  const inject = (options: InjectOptions) => server.web.app.inject(options);
  const as = (userId: string) => {
    const { cookie, csrf } = sessionFor(server, userId);
    return { cookie, [CSRF_HEADER]: csrf };
  };

  it("answers a skip without the DJ role with the vote's count, and turns votes off for those who manage", async () => {
    await inject({ method: 'POST', url: api(`/guilds/${GUILD}/queue`), headers: asHost, payload: { input: 'two' } });
    server.media.finish(180_000);
    const vote = await inject({ method: 'POST', url: api(`/guilds/${GUILD}/player/skip`), headers: as(ALICE) });
    assert.equal(vote.statusCode, 200);
    assert.deepEqual(vote.json().votes, { votes: 1, needed: 2 });
    assert.equal(vote.json().track.title, 'Track a');
    // The host skips at once; its answer says no vote.
    const skipped = await inject({ method: 'POST', url: api(`/guilds/${GUILD}/player/skip`), headers: asHost });
    assert.equal(skipped.json().votes, null);
    assert.equal(skipped.json().track.title, 'Track b');
    // Votes off: Skip needs the DJ role again.
    const off = await inject({
      method: 'PUT',
      url: api(`/guilds/${GUILD}/settings/vote-skip`),
      headers: as(BOB),
      payload: { on: false },
    });
    assert.equal(off.json().voteSkip, false);
    const refused = await inject({ method: 'POST', url: api(`/guilds/${GUILD}/player/skip`), headers: as(ALICE) });
    assert.equal(refused.statusCode, 403);
    assert.match(refused.json().error.message, /DJ role/);
  });
});

describe('taking turns and the limit per person over the API', () => {
  let server: TestServer;

  before(async () => {
    server = await testServer({ found: { one: [exampleTrack('t1')], two: [exampleTrack('t2'), exampleTrack('t3')] } });
    server.directory.join(GUILD, ALICE);
    server.directory.join(GUILD, BOB, { manage: true });
  });
  after(() => server.close());

  const inject = (options: InjectOptions) => server.web.app.inject(options);
  const as = (userId: string) => {
    const { cookie, csrf } = sessionFor(server, userId);
    return { cookie, [CSRF_HEADER]: csrf };
  };

  it('sets both for people who manage the server, and answers an add with what the limit left out', async () => {
    for (const [path, payload] of [
      ['take-turns', { on: true }],
      ['person-limit', { tracks: 1 }],
    ] as const) {
      const refused = await inject({
        method: 'PUT',
        url: api(`/guilds/${GUILD}/settings/${path}`),
        headers: as(ALICE),
        payload,
      });
      assert.equal(refused.statusCode, 403);
      const set = await inject({
        method: 'PUT',
        url: api(`/guilds/${GUILD}/settings/${path}`),
        headers: as(BOB),
        payload,
      });
      assert.equal(set.statusCode, 200);
    }
    const shown = (await inject({ method: 'GET', url: api(`/guilds/${GUILD}/settings`), headers: as(ALICE) })).json();
    assert.deepEqual([shown.takeTurns, shown.personLimit], [true, 1]);
    // Over the queue's own size: refused by the schema.
    const tooMany = await inject({
      method: 'PUT',
      url: api(`/guilds/${GUILD}/settings/person-limit`),
      headers: as(BOB),
      payload: { tracks: 5000 },
    });
    assert.equal(tooMany.statusCode, 400);
    // Alice's first track plays at once, the second waits, the third is over her limit of one.
    await inject({ method: 'POST', url: api(`/guilds/${GUILD}/queue`), headers: as(ALICE), payload: { input: 'one' } });
    const added = await inject({
      method: 'POST',
      url: api(`/guilds/${GUILD}/queue`),
      headers: as(ALICE),
      payload: { input: 'two' },
    });
    assert.deepEqual([added.json().items.length, added.json().skippedLimit], [1, 1]);
    // Putting the queue in turns is a change of the music: Alice may, and nothing needs to move.
    const now = await inject({ method: 'POST', url: api(`/guilds/${GUILD}/queue/turns`), headers: as(ALICE) });
    assert.deepEqual(now.json(), { moved: 0 });
  });
});
