/**
 * What the API answers when the request is not the problem, or is: a database that stops answering is jukecord's
 * trouble for now (503, with when to ask again, never its address), and a token's name the store refuses is the
 * request's mistake (400), where only a login that may not make the token is forbidden (403).
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { ConnectionError, DATABASE_DOWN, DATABASE_RETRY_MS } from '../../src/store/network.ts';
import { asHost, type TestServer, testServer } from '../support/web.ts';

describe('the API, when a request meets trouble', () => {
  const servers: TestServer[] = [];
  after(async () => {
    for (const server of servers) await server.close();
  });

  it('answers 503 with Retry-After while the database does not answer, never naming it', async () => {
    const server = await testServer({ browserOnly: true });
    servers.push(server);
    // The tokens' list, as it fails when the database went away under the request (the address stays in the log).
    server.store.tokens.list = async () => {
      throw new ConnectionError('PostgreSQL at db.example.internal:5432 closed the connection', true);
    };
    const answer = await server.web.app.inject({ method: 'GET', url: '/api/v1/tokens', headers: asHost });
    assert.equal(answer.statusCode, 503);
    assert.equal(answer.headers['retry-after'], String(DATABASE_RETRY_MS / 1000));
    assert.deepEqual(answer.json(), { error: { code: 'unavailable', message: DATABASE_DOWN } });
    assert.doesNotMatch(answer.body, /db\.example\.internal/);
  });

  it("answers a token's name the store refuses as invalid, and a database that does not answer as unavailable", async () => {
    const server = await testServer({ browserOnly: true });
    servers.push(server);
    const create = (name: string) =>
      server.web.app.inject({
        method: 'POST',
        url: '/api/v1/tokens',
        headers: asHost,
        payload: { name, scope: 'read' },
      });
    // A NUL in the name: the store refuses it on every database alike, and it is the request's mistake.
    const nul = await create('tea\u0000time');
    assert.equal(nul.statusCode, 400);
    assert.equal(nul.json().error.code, 'invalid');
    // A good name still makes a token.
    assert.equal((await create('tea time')).statusCode, 200);
    // The database gone while the token is written: asked again later, not refused.
    server.store.tokens.create = async () => {
      throw new ConnectionError('MySQL at db.example.internal:3306 closed the connection', true);
    };
    const down = await create('later');
    assert.equal(down.statusCode, 503);
    assert.equal(down.json().error.code, 'unavailable');
  });
});
