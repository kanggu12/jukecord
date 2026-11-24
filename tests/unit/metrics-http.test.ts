import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MetricsGate, negotiate } from '../../src/metrics/http.ts';

const TOKEN = 'a-metrics-token-long-enough-1234';

describe('who may read /metrics', () => {
  it('keeps the address rule when no token is set: private and direct only, whatever Authorization says', () => {
    const gate = new MetricsGate(null);
    assert.equal(gate.verdict('127.0.0.1', {}), 'allowed');
    assert.equal(gate.verdict('10.1.2.3', {}), 'allowed');
    assert.equal(gate.verdict('::ffff:192.168.1.20', {}), 'allowed');
    assert.equal(gate.verdict('fd00::5', {}), 'allowed');
    assert.equal(gate.verdict('203.0.113.9', {}), 'hidden');
    assert.equal(gate.verdict('2001:db8::1', { authorization: `Bearer ${TOKEN}` }), 'hidden');
    // Through a proxy, by either header, even from a private address.
    assert.equal(gate.verdict('127.0.0.1', { 'x-forwarded-for': '198.51.100.7' }), 'hidden');
    assert.equal(gate.verdict('127.0.0.1', { forwarded: 'for=198.51.100.7' }), 'hidden');
    // A bearer token means nothing without one set: the address decides, as before the token.
    assert.equal(gate.verdict('10.0.0.8', { authorization: 'Bearer anything' }), 'allowed');
  });

  it('takes any header a proxy adds for being proxied, not only X-Forwarded-For and Forwarded', () => {
    const gate = new MetricsGate(null);
    // nginx with only `proxy_set_header X-Real-IP`, a proxy that says only Via, and the rest of the usual ones.
    for (const headers of [
      { 'x-real-ip': '203.0.113.9' },
      { via: '1.1 proxy.example' },
      { 'x-forwarded-host': 'music.example.com' },
      { 'x-forwarded-proto': 'https' },
      { forwarded: 'proto=https' },
    ]) {
      assert.equal(gate.verdict('127.0.0.1', headers), 'hidden', JSON.stringify(headers));
    }
    // The token still lets in through any of them.
    assert.equal(
      new MetricsGate(TOKEN).verdict('127.0.0.1', { authorization: `Bearer ${TOKEN}`, via: '1.1 p' }),
      'allowed',
    );
  });

  it('lets the token in from anywhere and through a proxy, and tells a wrong one so', () => {
    const gate = new MetricsGate(TOKEN);
    assert.equal(gate.hasToken, true);
    assert.equal(gate.verdict('203.0.113.9', { authorization: `Bearer ${TOKEN}` }), 'allowed');
    assert.equal(
      gate.verdict('127.0.0.1', { authorization: `bearer ${TOKEN}`, 'x-forwarded-for': '203.0.113.9' }),
      'allowed',
    );
    assert.equal(gate.verdict('203.0.113.9', { authorization: `Bearer ${TOKEN}x` }), 'wrong-token');
    assert.equal(gate.verdict('203.0.113.9', { authorization: 'Bearer short' }), 'wrong-token');
    // A wrong token from a private address is still wrong: it is not let in by where it runs.
    assert.equal(gate.verdict('10.0.0.8', { authorization: 'Bearer stale-token' }), 'wrong-token');
    // No token shown: the address rule, as without one.
    assert.equal(gate.verdict('10.0.0.8', {}), 'allowed');
    assert.equal(gate.verdict('203.0.113.9', {}), 'hidden');
    assert.equal(gate.verdict('203.0.113.9', { authorization: 'Basic dXNlcjpwYXNz' }), 'hidden');
    assert.equal(gate.verdict('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }), 'hidden');
  });
});

describe('the format /metrics is written in', () => {
  it("gives Prometheus the OpenMetrics it asks for first, and everyone else Prometheus's text format", () => {
    // Prometheus 2 and 3, as they ask.
    assert.equal(
      negotiate(
        'application/openmetrics-text;version=1.0.0;q=0.5,application/openmetrics-text;version=0.0.1;q=0.4,text/plain;version=0.0.4;q=0.3,*/*;q=0.2',
      ).contentType,
      'application/openmetrics-text; version=1.0.0; charset=utf-8',
    );
    assert.equal(
      negotiate(
        'application/openmetrics-text;version=1.0.0;escaping=allow-utf-8;q=0.6,application/openmetrics-text;version=0.0.1;q=0.5,text/plain;version=1.0.0;escaping=allow-utf-8;q=0.4,text/plain;version=0.0.4;q=0.3,*/*;q=0.2',
      ).format,
      'openmetrics',
    );
    assert.equal(negotiate('application/openmetrics-text; version=0.0.1').contentType.includes('0.0.1'), true);
    // Asked for the text format first, or for nothing in particular.
    assert.equal(negotiate('text/plain;version=0.0.4;q=0.9,application/openmetrics-text;q=0.5').format, 'text');
    assert.equal(negotiate('*/*').contentType, 'text/plain; version=0.0.4; charset=utf-8');
    assert.equal(negotiate(undefined).format, 'text');
    assert.equal(negotiate('application/json').format, 'text');
    // A version of OpenMetrics jukecord does not write, or one refused with q=0, is passed over.
    assert.equal(negotiate('application/openmetrics-text;version=2.0.0,text/plain;q=0.1').format, 'text');
    assert.equal(negotiate('application/openmetrics-text;q=0,*/*;q=0.1').format, 'text');
  });
});
