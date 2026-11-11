import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultLimit, Slots } from '../../src/media/slots.ts';

// Whether a promise has settled by now (after the microtasks queued so far).
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await Promise.resolve();
  await Promise.resolve();
  return done;
}

describe('Slots', () => {
  it('starts fetches somebody waits for at once, even past the limit', async () => {
    const slots = new Slots(2);
    const tickets = [1, 2, 3].map(() => slots.request('now', new AbortController().signal));
    for (const ticket of tickets) assert.equal(await settled(ticket.granted), true);
    assert.equal(slots.active, 3);
  });

  it('starts ahead fetches only while fewer than the limit run, then in the order they asked', async () => {
    const slots = new Slots(2);
    const now = slots.request('now', new AbortController().signal);
    const a = slots.request('ahead', new AbortController().signal);
    const b = slots.request('ahead', new AbortController().signal);
    const c = slots.request('ahead', new AbortController().signal);
    assert.equal(await settled(a.granted), true);
    assert.equal(await settled(b.granted), false);
    assert.equal(slots.queued, 2);
    // The fetch somebody waited for ends: the oldest waiting one starts, the next still waits.
    now.release();
    assert.equal(await settled(b.granted), true);
    assert.equal(await settled(c.granted), false);
    a.release();
    assert.equal(await settled(c.granted), true);
    assert.equal(slots.queued, 0);
  });

  it('starts a waiting ahead fetch at once when somebody comes to wait for it', async () => {
    const slots = new Slots(1);
    slots.request('now', new AbortController().signal);
    const ahead = slots.request('ahead', new AbortController().signal);
    assert.equal(await settled(ahead.granted), false);
    ahead.promote();
    assert.equal(await settled(ahead.granted), true);
    assert.equal(slots.active, 2);
    assert.equal(slots.queued, 0);
  });

  it('lets a waiting fetch go when its signal aborts, and gives its turn to the next', async () => {
    const slots = new Slots(1);
    const running = slots.request('ahead', new AbortController().signal);
    const stop = new AbortController();
    const gone = slots.request('ahead', stop.signal);
    const next = slots.request('ahead', new AbortController().signal);
    stop.abort();
    await assert.rejects(gone.granted);
    running.release();
    assert.equal(await settled(next.granted), true);
    // Releasing twice, or releasing what never started, changes nothing.
    running.release();
    gone.release();
    assert.equal(slots.active, 1);
  });

  it('keeps between 2 and 6 by default, half the processors', () => {
    assert.equal(defaultLimit(1), 2);
    assert.equal(defaultLimit(4), 2);
    assert.equal(defaultLimit(8), 4);
    assert.equal(defaultLimit(32), 6);
  });
});
