import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatDuration, parseTimestamp } from '../../src/util/time.ts';

describe('formatDuration', () => {
  it('writes m:ss below an hour and h:mm:ss from an hour', () => {
    assert.equal(formatDuration(0), '0:00');
    assert.equal(formatDuration(187_900), '3:07');
    assert.equal(formatDuration(3_765_000), '1:02:45');
  });
});

describe('parseTimestamp', () => {
  it('reads seconds, clock form and units', () => {
    assert.equal(parseTimestamp('83'), 83_000);
    assert.equal(parseTimestamp('12.5'), 12_500);
    assert.equal(parseTimestamp('1:23'), 83_000);
    assert.equal(parseTimestamp('1:02:45'), 3_765_000);
    assert.equal(parseTimestamp('1m23s'), 83_000);
    assert.equal(parseTimestamp('2h'), 7_200_000);
  });

  it('refuses what it cannot read, with examples', () => {
    assert.throws(() => parseTimestamp('soon'), /examples/);
    assert.throws(() => parseTimestamp(''), /examples/);
  });
});
