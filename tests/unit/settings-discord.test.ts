/**
 * The Discord login's test, against a fake of Discord's token endpoint only (no test reaches Discord): what each of
 * Discord's answers says, nothing sent without an ID and a secret, the secret sent to Discord's address alone, and the
 * same through the API with the page's values not saved yet.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { testDiscordLogin } from '../../src/settings/discord.ts';
import { API_PREFIX } from '../../src/web/api.ts';
import { asHost, testServer } from '../support/web.ts';

// A fake Discord: the answer given to every token request, and each request it got (address and form).
function fakeDiscord(status: number, body: unknown) {
  const asked: { url: string; form: URLSearchParams }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: String(url), form: new URLSearchParams(String(init?.body ?? '')) });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { asked, fetch: fetcher };
}

const FAKE_API = 'http://discord.test/api/v10';
const REDIRECT = 'https://music.example.com/auth/callback';

describe('testing the Discord login', () => {
  it('takes "the code is not valid" for an application Discord knows, and sends nothing a login could use', async () => {
    const discord = fakeDiscord(400, { error: 'invalid_grant', error_description: 'Invalid "code" in request.' });
    const found = await testDiscordLogin({
      clientId: '123456789012345678',
      clientSecret: 'secret-made-up',
      redirectUri: REDIRECT,
      api: FAKE_API,
      fetch: discord.fetch,
    });
    assert.equal(found.ok, true);
    assert.deepEqual(
      found.checks.map((check) => [check.name, check.status]),
      [
        ['application', 'ok'],
        ['redirect', 'ok'],
      ],
    );
    assert.equal(found.checks[1]?.detail, `the application's OAuth2 redirects must list ${REDIRECT}`);
    // One request, to the token endpoint, with a code made up for the test.
    assert.equal(discord.asked.length, 1);
    assert.equal(discord.asked[0]?.url, `${FAKE_API}/oauth2/token`);
    assert.match(String(discord.asked[0]?.form.get('code')), /^jukecord-test-/);
    assert.equal(discord.asked[0]?.form.get('redirect_uri'), REDIRECT);
  });

  it('says a refused ID or secret, Discord out of reach, and a missing setting without asking', async () => {
    const refused = await testDiscordLogin({
      clientId: '123456789012345678',
      clientSecret: 'wrong-made-up',
      redirectUri: REDIRECT,
      api: FAKE_API,
      fetch: fakeDiscord(401, { error: 'invalid_client' }).fetch,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.checks[0]?.detail, 'Discord refused the client ID or its secret (invalid_client)');
    const away = await testDiscordLogin({
      clientId: '123456789012345678',
      clientSecret: 'secret-made-up',
      redirectUri: REDIRECT,
      api: FAKE_API,
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    assert.equal(away.checks[0]?.detail, 'Discord could not be reached (fetch failed)');
    const discord = fakeDiscord(400, { error: 'invalid_grant' });
    const none = await testDiscordLogin({
      clientId: '123456789012345678',
      clientSecret: null,
      redirectUri: REDIRECT,
      api: FAKE_API,
      fetch: discord.fetch,
    });
    assert.equal(none.checks[0]?.detail, 'no client secret (JUKECORD_DISCORD_CLIENT_SECRET)');
    assert.equal(discord.asked.length, 0, 'asked Discord without a secret');
  });

  it('tries the page’s values not saved yet through the API, the saved secret with them, for the host alone', async () => {
    const discord = fakeDiscord(400, { error: 'invalid_grant' });
    const server = await testServer({ hostSettings: { discord: { api: FAKE_API, fetch: discord.fetch } } });
    try {
      // A secret saved, then a test with an ID and a public address typed but not saved: the saved secret goes with
      // them, to Discord's address (the only one this test ever asks).
      const saved = await server.web.app.inject({
        method: 'PATCH',
        url: `${API_PREFIX}/settings`,
        headers: asHost,
        payload: {
          values: {
            JUKECORD_DISCORD_CLIENT_ID: '123456789012345678',
            JUKECORD_DISCORD_CLIENT_SECRET: 'saved-secret-made-up',
          },
        },
      });
      assert.equal(saved.statusCode, 200, saved.body);
      const tested = await server.web.app.inject({
        method: 'POST',
        url: `${API_PREFIX}/auth/test-discord`,
        headers: asHost,
        payload: {
          settings: {
            JUKECORD_DISCORD_CLIENT_ID: '876543210987654321',
            JUKECORD_PUBLIC_URL: 'https://music.example.com',
          },
        },
      });
      assert.equal(tested.statusCode, 200, tested.body);
      assert.equal(tested.json().ok, true);
      assert.equal(discord.asked[0]?.form.get('client_id'), '876543210987654321');
      assert.equal(discord.asked[0]?.form.get('client_secret'), 'saved-secret-made-up');
      assert.equal(discord.asked[0]?.form.get('redirect_uri'), REDIRECT);
      // Nothing was saved by the test.
      const view = (
        await server.web.app.inject({ method: 'GET', url: `${API_PREFIX}/settings`, headers: asHost })
      ).json() as { settings: { name: string; value: string | null }[] };
      assert.equal(
        view.settings.find((setting) => setting.name === 'JUKECORD_DISCORD_CLIENT_ID')?.value,
        '123456789012345678',
      );
      // Another setting in the form is not the Discord login's.
      const other = await server.web.app.inject({
        method: 'POST',
        url: `${API_PREFIX}/auth/test-discord`,
        headers: asHost,
        payload: { settings: { JUKECORD_QUEUE_MAX: '20' } },
      });
      assert.equal(other.statusCode, 400);
      assert.equal(other.json().error.message, 'JUKECORD_QUEUE_MAX is no setting of the Discord login');
    } finally {
      await server.close();
    }
  });
});
