import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Lock } from '../../src/util/lock.ts';
import { flush } from '../support/fakes.ts';

describe('Lock', () => {
  it('has one holder at a time, and hands it on in the order asked', async () => {
    const lock = new Lock();
    const order: string[] = [];
    const first = await lock.acquire();
    // Two more ask while it is held: they wait, in line.
    const second = lock.acquire().then((release) => {
      order.push('second');
      return release;
    });
    const third = lock.acquire().then((release) => {
      order.push('third');
      return release;
    });
    await flush();
    assert.deepEqual(order, []);
    assert.equal(lock.queued, 2);
    first();
    const releaseSecond = await second;
    await flush();
    // The third still waits for the second.
    assert.deepEqual(order, ['second']);
    releaseSecond();
    (await third)();
    assert.deepEqual(order, ['second', 'third']);
    assert.equal(lock.locked, false);
  });

  it('ignores a second release, which must not free the turn of whoever holds it next', async () => {
    const lock = new Lock();
    const first = await lock.acquire();
    const next = lock.acquire();
    first();
    // A finally that runs twice: the lock is the next holder's still.
    first();
    const second = await next;
    assert.equal(lock.locked, true);
    second();
    assert.equal(lock.locked, false);
  });
});
