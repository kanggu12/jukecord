import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MetricsRegistry, NO_METRICS } from '../../src/metrics/registry.ts';
import { parseExposition } from '../support/exposition.ts';

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

  it('counts an observation on a bound into that bucket, takes bounds in any order once, and leaves NaN out', () => {
    const registry = new MetricsRegistry();
    const sizes = registry.histogram('jukecord_test_bytes', 'Sizes.', [], [10, 1, 10, Number.POSITIVE_INFINITY, 5]);
    for (const value of [1, 5, 5, 7, 10, 11, Number.NaN]) sizes.observe(value);
    const text = registry.render();
    assert.deepEqual(text.match(/^jukecord_test_bytes_bucket.*$/gm), [
      'jukecord_test_bytes_bucket{le="1"} 1',
      'jukecord_test_bytes_bucket{le="5"} 3',
      'jukecord_test_bytes_bucket{le="10"} 5',
      'jukecord_test_bytes_bucket{le="+Inf"} 6',
    ]);
    assert.match(text, /^jukecord_test_bytes_sum 39$/m);
    parseExposition(text);
  });

  it('gives the same metric when asked twice, and refuses a clash or an undeclared label', () => {
    const registry = new MetricsRegistry();
    const one = registry.counter('jukecord_test_total', 'Things.', ['kind']);
    const two = registry.counter('jukecord_test_total', 'Things.', ['kind']);
    one.inc({ kind: 'a' });
    two.inc({ kind: 'a' });
    assert.match(registry.render(), /^jukecord_test_total\{kind="a"\} 2$/m);
    assert.throws(() => registry.gauge('jukecord_test_total', 'Things.', ['kind']), /_total/);
    assert.throws(() => registry.counter('jukecord_test_total', 'Things.', ['other']), /declared already/);
    assert.throws(() => one.inc({ guild: '1' }), /no label guild/);
    assert.throws(() => one.inc({ kind: 'a', guild: '1' }), /no label guild/);
    assert.throws(() => one.inc({ kind: 'a' }, -1), /cannot go down/);
    assert.throws(() => registry.counter('jukecord-bad', 'x'), /not a metric name/);
  });

  it("holds every name to Prometheus's rules", () => {
    const registry = new MetricsRegistry();
    // A counter ends in _total; nothing else does, nor in another kind's sample suffix.
    assert.throws(() => registry.counter('jukecord_test_requests', 'x'), /ends in _total/);
    assert.throws(() => registry.gauge('jukecord_test_running_total', 'x'), /only a counter/);
    assert.throws(() => registry.histogram('jukecord_test_count', 'x'), /only a counter/);
    assert.throws(() => registry.gauge('jukecord_test_bucket', 'x'), /only a counter/);
    assert.throws(() => registry.counter('jukecord_test_created_total', 'x', ['le']), /not a label name/);
    // Labels: not `le`, not Prometheus's own (two underscores), not twice, not with a dash.
    assert.throws(() => registry.histogram('jukecord_test_seconds', 'x', ['le']), /not a label name/);
    assert.throws(() => registry.gauge('jukecord_test_value', 'x', ['__name']), /not a label name/);
    assert.throws(() => registry.gauge('jukecord_test_value', 'x', ['kind', 'kind']), /named twice/);
    assert.throws(() => registry.gauge('jukecord_test_value', 'x', ['a-b']), /not a label name/);
    // A counter x_total and a gauge x are one family in OpenMetrics, whichever is declared first.
    registry.counter('jukecord_test_fetches_total', 'x');
    assert.throws(() => registry.gauge('jukecord_test_fetches', 'x'), /one family in OpenMetrics/);
    registry.gauge('jukecord_test_jobs', 'x');
    assert.throws(() => registry.counter('jukecord_test_jobs_total', 'x'), /one family in OpenMetrics/);
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

  it('writes the rest when a collector fails, and tells who listens', () => {
    const failures: unknown[] = [];
    const registry = new MetricsRegistry({ onError: (error) => failures.push(error) });
    const fine = registry.gauge('jukecord_test_fine', 'Fine.');
    registry.collect(() => {
      throw new Error('the folder is gone');
    });
    registry.collect(() => fine.set(1));
    assert.match(registry.render(), /^jukecord_test_fine 1$/m);
    assert.equal(String(failures[0]), 'Error: the folder is gone');
  });

  it('writes OpenMetrics when asked: counters named without _total, bounds as floats, quotes escaped, and # EOF', () => {
    const registry = new MetricsRegistry();
    registry.counter('jukecord_test_requests_total', 'Requests "answered".', ['outcome']).inc({ outcome: 'ok' }, 2);
    registry.gauge('jukecord_test_players', 'Players.').set(3);
    registry.histogram('jukecord_test_seconds', 'How long.', [], [0.5, 1]).observe(0.7);
    const text = registry.render('openmetrics');
    assert.equal(
      text,
      [
        '# HELP jukecord_test_requests Requests \\"answered\\".',
        '# TYPE jukecord_test_requests counter',
        'jukecord_test_requests_total{outcome="ok"} 2',
        '# HELP jukecord_test_players Players.',
        '# TYPE jukecord_test_players gauge',
        'jukecord_test_players 3',
        '# HELP jukecord_test_seconds How long.',
        '# TYPE jukecord_test_seconds histogram',
        'jukecord_test_seconds_bucket{le="0.5"} 0',
        'jukecord_test_seconds_bucket{le="1.0"} 1',
        'jukecord_test_seconds_bucket{le="+Inf"} 1',
        'jukecord_test_seconds_sum 0.7',
        'jukecord_test_seconds_count 1',
        '# EOF',
        '',
      ].join('\n'),
    );
    parseExposition(text, 'openmetrics');
    // The same registry in the text format keeps the counter's name whole and its quotes as they are in the help.
    const plain = registry.render();
    assert.match(plain, /^# HELP jukecord_test_requests_total Requests "answered"\.$/m);
    parseExposition(plain);
  });

  it('lists what it declared, in order, for the tests that check a dashboard', () => {
    const registry = new MetricsRegistry();
    registry.gauge('jukecord_test_players', 'Players.', ['status']);
    registry.counter('jukecord_test_total', 'Things.');
    assert.deepEqual(registry.declared(), [
      { name: 'jukecord_test_players', kind: 'gauge', help: 'Players.', labelNames: ['status'] },
      { name: 'jukecord_test_total', kind: 'counter', help: 'Things.', labelNames: [] },
    ]);
  });

  it('gathers what takes a question first, once for scrapes at the same moment, and waits for it only so long', async () => {
    const registry = new MetricsRegistry({ gatherWaitMs: 50 });
    const queued = registry.gauge('jukecord_test_queued', 'Queued.');
    let runs = 0;
    registry.gather(async () => {
      runs += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      queued.set(runs);
    });
    const [first, second] = await Promise.all([registry.scrape(), registry.scrape()]);
    assert.equal(runs, 1);
    assert.match(first, /^jukecord_test_queued 1$/m);
    assert.equal(first, second);
    // A gatherer that does not answer holds the scrape back for the wait only; what the others found is written.
    registry.gather(() => new Promise(() => {}));
    const started = performance.now();
    assert.match(await registry.scrape('openmetrics'), /^jukecord_test_queued 2\n# EOF\n$/m);
    assert.ok(performance.now() - started < 1000);
  });

  it('keeps nothing when asked through NO_METRICS', () => {
    const counter = NO_METRICS.counter('jukecord_test_total', 'x', ['kind']);
    counter.inc({ kind: 'a' });
    NO_METRICS.histogram('jukecord_test_seconds', 'x').time()();
    NO_METRICS.gather(async () => {});
  });
});

describe('the exposition reader the tests use', () => {
  it('refuses what a scraper would misread', () => {
    const bad: [string, RegExp][] = [
      ['jukecord_x 1\n', /not a sample of the family before it/],
      ['# TYPE jukecord_x gauge\njukecord_x 1\n', /has no HELP/],
      ['# HELP jukecord_x x\n# TYPE jukecord_x gauge\njukecord_x 1\njukecord_x 2\n', /written twice/],
      ['# HELP jukecord_x x\n# TYPE jukecord_x gauge\njukecord_x{a="\\t"} 1\n', /escape/],
      ['# HELP jukecord_x x\n# TYPE jukecord_x gauge\njukecord_x one\n', /not a number/],
      ['# HELP jukecord_x_total x\n# TYPE jukecord_x_total counter\njukecord_x_total -1\n', /below zero/],
      [
        '# HELP jukecord_h x\n# TYPE jukecord_h histogram\njukecord_h_bucket{le="1"} 2\njukecord_h_bucket{le="+Inf"} 1\njukecord_h_sum 1\njukecord_h_count 1\n',
        /not cumulative/,
      ],
      [
        '# HELP jukecord_h x\n# TYPE jukecord_h histogram\njukecord_h_bucket{le="1"} 1\njukecord_h_sum 1\njukecord_h_count 1\n',
        /no \+Inf/,
      ],
      ['# HELP jukecord_x x\n# TYPE jukecord_x gauge\njukecord_x 1', /line break/],
    ];
    for (const [text, problem] of bad) assert.throws(() => parseExposition(text), problem, text);
    assert.throws(() => parseExposition('# HELP jukecord_x x\n# TYPE jukecord_x gauge\n', 'openmetrics'), /# EOF/);
    assert.throws(
      () => parseExposition('# HELP jukecord_x_total x\n# TYPE jukecord_x_total counter\n# EOF\n', 'openmetrics'),
      /keeps its _total/,
    );
  });
});
