import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Countdowns } from '../../src/core/countdowns.ts';
import { FakeClock } from '../support/fakes.ts';

describe('Countdowns', () => {
  it('runs out after the time, keeps the first deadline when armed twice, and can be disarmed', async () => {
    const clock = new FakeClock();
    const expired: string[] = [];
    const countdowns = new Countdowns(clock, 5 * 60_000, (key) => expired.push(key));
    countdowns.arm('a');
    await clock.advance(4 * 60_000);
    // Arming again (a second person leaving) does not restart the wait.
    countdowns.arm('a');
    countdowns.arm('b');
    await clock.advance(60_000);
    assert.deepEqual(expired, ['a']);
    // Someone came back to b's channel.
    countdowns.disarm('b');
    await clock.advance(10 * 60_000);
    assert.deepEqual(expired, ['a']);
    assert.equal(countdowns.armed('b'), false);
  });
});
