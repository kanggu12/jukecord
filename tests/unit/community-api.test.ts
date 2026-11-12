/**
 * How a server's people share the music, over the HTTP API: who may change each setting, and what the answers say.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { InjectOptions } from 'fastify';
import { API_PREFIX } from '../../src/web/api.ts';
import { CSRF_HEADER } from '../../src/web/auth.ts';
import { ALICE, asHost, BOB, exampleTrack, GUILD, sessionFor, type TestServer, testServer } from '../support/web.ts';

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
