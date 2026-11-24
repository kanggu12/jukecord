/**
 * `/metrics` as a scraper sees it: both formats by their rules, every family with its HELP and TYPE, labels that never
 * carry a server, a person, a track or an address, and the rule of who may read it (the address, the token, a wrong
 * token, no token set, the forwarding headers).
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { gunzipSync } from 'node:zlib';
import type { InjectOptions } from 'fastify';
import { API_PREFIX } from '../../src/web/api.ts';
import { labelValues, parseExposition } from '../support/exposition.ts';
import { ALICE, asHost, exampleTrack, GUILD, OTHER_GUILD, type TestServer, testServer } from '../support/web.ts';

const PROMETHEUS_ACCEPT =
  'application/openmetrics-text;version=1.0.0;q=0.5,application/openmetrics-text;version=0.0.1;q=0.4,text/plain;version=0.0.4;q=0.3,*/*;q=0.2';
const TOKEN = 'metrics-token-for-the-tests-0123456789';

// The families 0.3 wrote, which keep their names (the event loop's is the runtime's now, see metrics-runtime.test.ts).
const KEPT = [
  'jukecord_info',
  'jukecord_discord_connected',
  'jukecord_players',
  'jukecord_queue_tracks',
  'jukecord_cache_bytes',
  'jukecord_cache_tracks',
  'jukecord_cache_covers',
  'jukecord_panel_connections',
  'jukecord_browser_listeners',
  'jukecord_http_responses_total',
];

describe('/metrics', () => {
  let server: TestServer;

  before(async () => {
    server = await testServer({ found: { one: [exampleTrack('a')] }, metricsToken: TOKEN });
    server.directory.join(GUILD, ALICE);
  });
  after(() => server.close());

  const inject = (options: InjectOptions) => server.web.app.inject(options);

  it("writes Prometheus's text format by default, and OpenMetrics when Prometheus asks, both by their rules", async () => {
    // Something to count first: a track added, some answers of each class.
    await inject({
      method: 'POST',
      url: `${API_PREFIX}/guilds/${GUILD}/queue`,
      headers: asHost,
      payload: { input: 'one' },
    });
    await inject({ method: 'GET', url: `${API_PREFIX}/guilds/${GUILD}/queue`, headers: asHost });
    await inject({ method: 'GET', url: `${API_PREFIX}/me` });
    const text = await inject({ method: 'GET', url: '/metrics' });
    assert.equal(text.statusCode, 200);
    assert.equal(text.headers['content-type'], 'text/plain; version=0.0.4; charset=utf-8');
    assert.equal(text.headers['cache-control'], 'no-store');
    const families = parseExposition(text.body);
    for (const name of KEPT) assert.ok(families.has(name), `${name} is gone`);
    assert.match(
      text.body,
      /^jukecord_info\{version="\d+\.\d+\.\d+[^"]*",role="all",database="sqlite",bus="in-process",cache="memory"\} 1$/m,
    );
    assert.match(text.body, /^jukecord_players\{status="loading"\} 1$/m);
    assert.match(text.body, /^jukecord_queue_tracks 0$/m);
    assert.match(text.body, /^jukecord_http_responses_total\{class="4xx"\} [1-9]\d*$/m);
    assert.match(
      text.body,
      /^jukecord_http_request_duration_seconds_count\{method="GET",route="\/api\/v1\/guilds\/:guild\/queue",class="2xx"\} 1$/m,
    );
    assert.match(text.body, /^jukecord_discord_gateway_state\{state="ready"\} 1$/m);
    const open = await inject({ method: 'GET', url: '/metrics', headers: { accept: PROMETHEUS_ACCEPT } });
    assert.equal(open.headers['content-type'], 'application/openmetrics-text; version=1.0.0; charset=utf-8');
    const openFamilies = parseExposition(open.body, 'openmetrics');
    // The same families in both: OpenMetrics names a counter's family without _total.
    assert.deepEqual(
      [...openFamilies.keys()].sort(),
      [...families.keys()]
        .map((name) => (families.get(name)?.type === 'counter' ? name.replace(/_total$/, '') : name))
        .sort(),
    );
  });

  it('compresses for a scraper that takes gzip', async () => {
    const answer = await inject({ method: 'GET', url: '/metrics', headers: { 'accept-encoding': 'gzip' } });
    assert.equal(answer.headers['content-encoding'], 'gzip');
    parseExposition(gunzipSync(answer.rawPayload).toString('utf8'));
  });

  it('never makes a series of a server, a person, a track or an address', async () => {
    // Addresses full of IDs, a track's number, made-up paths and methods, logins that fail: each a series if labels
    // took what was asked.
    for (const guild of [GUILD, OTHER_GUILD, '100000000000000999']) {
      await inject({ method: 'GET', url: `${API_PREFIX}/guilds/${guild}/player`, headers: asHost });
      await inject({ method: 'GET', url: `${API_PREFIX}/guilds/${guild}/tracks/12345/cover`, headers: asHost });
    }
    for (const nonsense of ['/wp-login.php', '/.env', '/api/v1/nope/300000000000000001', '/x?token=secret']) {
      await inject({ method: 'GET', url: nonsense });
    }
    await inject({ method: 'PROPFIND' as never, url: '/' });
    await inject({ method: 'GET', url: '/stats', headers: { accept: 'text/html' } });
    await inject({
      method: 'GET',
      url: `${API_PREFIX}/me`,
      headers: { authorization: 'Bearer jkc_not-a-real-token-0000' },
    });
    const families = parseExposition((await inject({ method: 'GET', url: '/metrics' })).body);
    for (const [key, values] of labelValues(families)) {
      for (const value of values) {
        // No Discord ID, no number of a track, no query, nothing a client made up.
        assert.doesNotMatch(value, /\d{6,}|\?|wp-login|\.env|nope|PROPFIND|jkc_/, `${key}="${value}"`);
        if (key.endsWith(':route'))
          assert.match(value, /^(\/(api\/v1\/|auth\/|healthz$|readyz$|metrics$)|static$|unmatched$)/, value);
      }
      // A label takes a handful of values; the route the most (one per route jukecord has).
      assert.ok(values.size <= (key.endsWith(':route') ? 120 : 20), `${key} has ${values.size} values`);
    }
    const routes = [...(labelValues(families).get('jukecord_http_request_duration_seconds:route') ?? [])];
    assert.ok(routes.includes('/api/v1/guilds/:guild/player'));
    assert.ok(routes.includes('unmatched'));
    assert.ok(routes.includes('static'));
    // The method a client made up is "other"; the live connection is not timed (its answer lasts as long as it is open).
    assert.ok(labelValues(families).get('jukecord_http_request_duration_seconds:method')?.has('other'));
    assert.ok(!routes.includes(`${API_PREFIX}/events`));
  });

  it('lets in a scraper beside jukecord, or one with the token from anywhere, and tells a wrong token so', async () => {
    const status = async (remoteAddress: string, headers: Record<string, string> = {}) =>
      (await inject({ method: 'GET', url: '/metrics', remoteAddress, headers })).statusCode;
    // The address rule, as without a token.
    assert.equal(await status('10.1.2.3'), 200);
    assert.equal(await status('203.0.113.9'), 404);
    assert.equal(await status('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }), 404);
    assert.equal(await status('127.0.0.1', { forwarded: 'for=198.51.100.7' }), 404);
    // The token, from a public address and through a proxy.
    assert.equal(await status('203.0.113.9', { authorization: `Bearer ${TOKEN}` }), 200);
    assert.equal(
      await status('127.0.0.1', { authorization: `Bearer ${TOKEN}`, 'x-forwarded-for': '203.0.113.9' }),
      200,
    );
    // A wrong one is told, wherever it comes from, and says how to log in.
    const wrong = await inject({
      method: 'GET',
      url: '/metrics',
      remoteAddress: '10.1.2.3',
      headers: { authorization: 'Bearer not-the-metrics-token' },
    });
    assert.equal(wrong.statusCode, 401);
    assert.equal(wrong.headers['www-authenticate'], 'Bearer');
    assert.deepEqual(wrong.json(), { error: { code: 'unauthorized', message: 'the metrics token is not right' } });
    // The host's API token is no metrics token.
    assert.equal(await status('203.0.113.9', asHost), 401);
  });
});

describe('/metrics without a token set', () => {
  let server: TestServer;
  before(async () => {
    server = await testServer();
  });
  after(() => server.close());

  it('keeps the rule of 0.3: a scraper beside jukecord only, whatever Authorization says', async () => {
    const status = async (remoteAddress: string, headers: Record<string, string> = {}) =>
      (await server.web.app.inject({ method: 'GET', url: '/metrics', remoteAddress, headers })).statusCode;
    assert.equal(await status('192.168.1.20'), 200);
    assert.equal(await status('203.0.113.9'), 404);
    assert.equal(await status('203.0.113.9', { authorization: `Bearer ${TOKEN}` }), 404);
    assert.equal(await status('10.0.0.8', { authorization: 'Bearer anything' }), 200);
    assert.equal(await status('127.0.0.1', { 'x-forwarded-for': '10.0.0.1' }), 404);
  });
});
