import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { niceTop } from '../../panel/src/axis.ts';

describe('the top of a chart axis', () => {
  it('is a tidy number at or above the tallest bar, close enough that the bars use the height', () => {
    // [the tallest bar, the axis top]
    for (const [max, top] of [
      [0, 2],
      [1, 2],
      [3, 4],
      [7, 8],
      [9, 10],
      [10, 10],
      [11, 12],
      [13, 16],
      [23, 30],
      [52, 60],
      [100, 100],
      [101, 120],
      [1300, 1600],
    ] as const) {
      assert.equal(niceTop(max), top, `for ${max}`);
    }
  });

  it('has a whole number in the middle, and never leaves the bars under half the height above 10', () => {
    for (let max = 0; max <= 5000; max += 1) {
      const top = niceTop(max);
      assert.ok(top >= max, `${top} is under ${max}`);
      assert.ok(Number.isInteger(top / 2), `half of ${top} (for ${max}) is not whole`);
      if (max >= 10) assert.ok(max / top > 0.5, `${max} of ${top} is half the height or less`);
    }
  });
});
