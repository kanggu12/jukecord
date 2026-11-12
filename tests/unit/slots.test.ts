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
  it('starts fetches somebody waits for at once up to twice the limit, past the limit for fetches ahead', async () => {
    const slots = new Slots(2);
    assert.equal(slots.nowLimit, 4);
    const tickets = [1, 2, 3, 4].map(() => slots.request('now', new AbortController().signal));
    for (const ticket of tickets) assert.equal(await settled(ticket.granted), true);
    assert.equal(slots.active, 4);
    // The fifth waits for a place, and gets the first one that frees, before any fetch ahead of time.
    const ahead = slots.request('ahead', new AbortController().signal);
    const fifth = slots.request('now', new AbortController().signal);
    assert.equal(await settled(fifth.granted), false);
    tickets[0]?.release();
    assert.equal(await settled(fifth.granted), true);
    assert.equal(await settled(ahead.granted), false);
  });

  it('never starts a fetch cancelled while it waited, as in a skip storm, and starts the newest when a place frees', async () => {
    const slots = new Slots(1, 1);
    const playing = slots.request('now', new AbortController().signal);
    // Skip after skip: each new fetch cancels the one before, which was still waiting for the place.
    const skips = Array.from({ length: 5 }, () => new AbortController());
    const waiting = skips.map((skip) => slots.request('now', skip.signal));
    for (const skip of skips.slice(0, -1)) skip.abort();
    for (const ticket of waiting.slice(0, -1)) await assert.rejects(ticket.granted);
    assert.equal(slots.queued, 1);
    // The cancelled fetch that was running exits: the newest one starts, alone.
    playing.release();
    assert.equal(await settled(waiting.at(-1)?.granted ?? Promise.reject()), true);
    assert.equal(slots.active, 1);
    assert.equal(slots.queued, 0);
  });

  it('frees a place for the next fetch somebody waits for when nobody waits for a running one any more', async () => {
    const slots = new Slots(1, 1);
    // Wanted now, then only ahead of time (the player skipped it, the prefetcher still wants it).
    const skipped = slots.request('now', new AbortController().signal);
    const next = slots.request('now', new AbortController().signal);
    assert.equal(await settled(next.granted), false);
    skipped.demote();
    assert.equal(await settled(next.granted), true);
    // Still running, now counted with the fetches ahead of time; promoted again it counts as now once more.
    assert.equal(slots.active, 2);
    skipped.promote();
    const third = slots.request('now', new AbortController().signal);
    assert.equal(await settled(third.granted), false);
  });

  it('moves a waiting fetch ahead of time to the line of those somebody waits for when it is promoted', async () => {
    const slots = new Slots(1, 1);
    const running = slots.request('now', new AbortController().signal);
    const first = slots.request('ahead', new AbortController().signal);
    const second = slots.request('ahead', new AbortController().signal);
    // No place for another "now" either: it waits, but before the fetches ahead of time.
    second.promote();
    assert.equal(await settled(second.granted), false);
    assert.equal(slots.queued, 2);
    running.release();
    assert.equal(await settled(second.granted), true);
    assert.equal(await settled(first.granted), false);
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
    // One of the two places for fetches somebody waits for is free.
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
