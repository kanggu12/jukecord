/**
 * The test of an address for the shared cache or the bus against a real Redis or Valkey server, when
 * JUKECORD_TEST_BUS_URL names one: what it is and how far, and the server's own words when it refuses the password.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { testServer } from '../../src/settings/servers.ts';
import { TEST_BUS_URL } from '../support/bus.ts';

describe('testing a Redis or Valkey address', { skip: !TEST_BUS_URL && 'JUKECORD_TEST_BUS_URL is not set' }, () => {
  const url = TEST_BUS_URL ?? '';

  it('says which server answered, its version and a ping there and back, for the cache and the bus', async () => {
    for (const use of ['cache', 'bus'] as const) {
      const found = await testServer(url, use);
      assert.equal(found.ok, true, String(found.problem));
      assert.match(String(found.server), /^(Valkey|Redis) \d+\.\d+/);
      assert.equal(typeof found.roundTripMs, 'number');
      // The address as the answer says it: never its password.
      const password = new URL(url).password;
      if (password) assert.ok(!JSON.stringify(found).includes(password));
    }
  });

  it('says the server’s own words when it refuses the password, and leaves no connection behind', async () => {
    // A user the server does not have, with a made-up password: refused whether the server has a password or not (one
    // without lets its default user in on any password).
    const wrong = new URL(url);
    wrong.username = 'nobody-made-up';
    wrong.password = 'not-the-password-made-up';
    const refused = await testServer(wrong.href, 'bus');
    assert.equal(refused.ok, false);
    // Valkey and Redis both say WRONGPASS (or, with no password set on the server, that AUTH was not needed).
    assert.match(String(refused.problem), /WRONGPASS|AUTH/i);
    assert.ok(!JSON.stringify(refused).includes('not-the-password-made-up'));
  });
});
