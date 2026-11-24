import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MetricsRegistry, NO_METRICS } from '../../src/metrics/registry.ts';

describe('MetricsRegistry', () => {
  it('writes counters and gauges with their help, type and labels', () => {
    const registry = new MetricsRegistry();
    const requests = registry.counter('jukecord_test_requests_total', 'Requests answered.', ['outcome']);
    requests.inc({ outcome: 'ok' });
    requests.inc({ outcome: 'ok' }, 2);
    requests.inc({ outcome: 'refused' });
    registry.gauge('jukecord_test_players', 'Players.').set(3);
    assert.equal(
      registry.render(),
      [
        '# HELP jukecord_test_requests_total Requests answered.',
        '# TYPE jukecord_test_requests_total counter',
        'jukecord_test_requests_total{outcome="ok"} 3',
        'jukecord_test_requests_total{outcome="refused"} 1',
        '# HELP jukecord_test_players Players.',
        '# TYPE jukecord_test_players gauge',
        'jukecord_test_players 3',
        '',
      ].join('\n'),
    );
  });

  it('writes a histogram as cumulative buckets with its sum and count', () => {
    const registry = new MetricsRegistry();
    const took = registry.histogram('jukecord_test_seconds', 'How long.', [], [0.1, 1]);
    took.observe(0.05);
    took.observe(0.5);
    took.observe(5);
    const text = registry.render();
    assert.match(text, /^jukecord_test_seconds_bucket\{le="0\.1"\} 1$/m);
    assert.match(text, /^jukecord_test_seconds_bucket\{le="1"\} 2$/m);
    assert.match(text, /^jukecord_test_seconds_bucket\{le="\+Inf"\} 3$/m);
    assert.match(text, /^jukecord_test_seconds_sum 5\.55$/m);
    assert.match(text, /^jukecord_test_seconds_count 3$/m);
  });

  it('gives the same metric when asked twice, and refuses a clash or an undeclared label', () => {
    const registry = new MetricsRegistry();
    const one = registry.counter('jukecord_test_total', 'Things.', ['kind']);
    const two = registry.counter('jukecord_test_total', 'Things.', ['kind']);
    one.inc({ kind: 'a' });
    two.inc({ kind: 'a' });
    assert.match(registry.render(), /^jukecord_test_total\{kind="a"\} 2$/m);
    assert.throws(() => registry.gauge('jukecord_test_total', 'Things.', ['kind']), /declared already/);
    assert.throws(() => one.inc({ guild: '1' }), /no label guild/);
    assert.throws(() => one.inc({ kind: 'a' }, -1), /cannot go down/);
    assert.throws(() => registry.counter('jukecord-bad', 'x'), /not a metric name/);
  });

  it('escapes label values and runs its collectors before writing', () => {
    const registry = new MetricsRegistry();
    const gauge = registry.gauge('jukecord_test_value', 'A value.', ['name']);
    let reads = 0;
    registry.collect(() => {
      reads += 1;
      gauge.set(reads, { name: 'say "hi"\\\n' });
    });
    assert.match(registry.render(), /^jukecord_test_value\{name="say \\"hi\\"\\\\\\n"\} 1$/m);
    registry.render();
    assert.equal(reads, 2);
  });

  it('keeps nothing when asked through NO_METRICS', () => {
    const counter = NO_METRICS.counter('jukecord_test_total', 'x', ['kind']);
    counter.inc({ kind: 'a' });
    NO_METRICS.histogram('jukecord_test_seconds', 'x').time()();
  });
});
