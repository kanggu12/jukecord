import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatSize, parseDuration, parseSize, UnitError } from '../../src/util/units.ts';

describe('parseSize', () => {
  it('reads plain bytes and both decimal and binary units', () => {
    assert.equal(parseSize('1048576'), 1_048_576);
    assert.equal(parseSize('2GiB'), 2 * 1024 ** 3);
    assert.equal(parseSize('1GB'), 1_000_000_000);
    assert.equal(parseSize(' 500 mb '), 500_000_000);
    // Fractions round down: a limit is never raised above what was written.
    assert.equal(parseSize('1.5KiB'), 1536);
  });

  it('refuses what it cannot read instead of guessing', () => {
    assert.throws(() => parseSize('-1GiB'), UnitError);
    assert.throws(() => parseSize('2 gigs'), /unknown size unit/);
    assert.throws(() => parseSize(''), UnitError);
  });
});

describe('parseDuration', () => {
  it('reads units and treats a plain number as seconds', () => {
    assert.equal(parseDuration('250ms'), 250);
    assert.equal(parseDuration('60'), 60_000);
    assert.equal(parseDuration('5m'), 300_000);
    assert.equal(parseDuration('1.5h'), 5_400_000);
  });

  it('refuses unknown units', () => {
    assert.throws(() => parseDuration('3 days'), /unknown duration unit/);
  });
});

describe('formatSize', () => {
  it('writes binary units with one decimal, bytes without', () => {
    assert.equal(formatSize(512), '512 B');
    assert.equal(formatSize(1536), '1.5 KiB');
    assert.equal(formatSize(2 * 1024 ** 3), '2.0 GiB');
  });
});
