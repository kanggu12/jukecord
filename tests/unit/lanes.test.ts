import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GuildLanes } from '../../src/core/lanes.ts';
import { flush } from '../support/fakes.ts';

const ONE = '100000000000000001';
const TWO = '100000000000000002';

// A turn of the event loop, as a network database's answer takes.
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

// A task that notes when it starts and ends, and waits a few turns of the event loop in between.
function noted(log: string[], name: string, turns = 3): () => Promise<string> {
  return async () => {
    log.push(`${name} starts`);
    for (let i = 0; i < turns; i += 1) await tick();
    log.push(`${name} ends`);
    return name;
  };
}

describe('GuildLanes', () => {
  it('runs two changes to one server one after the other, in the order asked, never interleaved', async () => {
    const lanes = new GuildLanes();
    const log: string[] = [];
    const results = await Promise.all([
      lanes.run(ONE, noted(log, 'first')),
      lanes.run(ONE, noted(log, 'second')),
      lanes.run(ONE, noted(log, 'third', 1)),
    ]);
    assert.deepEqual(results, ['first', 'second', 'third']);
    assert.deepEqual(log, ['first starts', 'first ends', 'second starts', 'second ends', 'third starts', 'third ends']);
  });

  it('runs the lanes of two servers side by side', async () => {
    const lanes = new GuildLanes();
    const log: string[] = [];
    await Promise.all([lanes.run(ONE, noted(log, 'one')), lanes.run(TWO, noted(log, 'two'))]);
    // Both started before either ended.
    assert.deepEqual(log.slice(0, 2).sort(), ['one starts', 'two starts']);
  });

  it('starts a change at once when its lane is idle, as a change ran before there were lanes', () => {
    const lanes = new GuildLanes();
    let started = false;
    void lanes.run(ONE, () => {
      started = true;
    });
    assert.equal(started, true);
  });

  it('runs a call for the lane it holds at once, inside its own turn (reentrant), and others in theirs', async () => {
    const lanes = new GuildLanes();
    const log: string[] = [];
    // Waiting behind the first turn, which calls into its own lane meanwhile.
    const waiting = lanes.run(ONE, noted(log, 'waiting', 1));
    const outer = lanes.run(ONE, async () => {
      log.push('outer starts');
      assert.equal(lanes.holds(ONE), true);
      // The same lane: no wait for itself.
      const inner = await lanes.run(ONE, async () => {
        log.push('inner runs');
        await tick();
        return 'inner';
      });
      // Another server's lane: a turn of that lane, which is idle.
      await lanes.run(TWO, () => {
        log.push('other server runs');
      });
      log.push('outer ends');
      return inner;
    });
    assert.equal(await outer, 'inner');
    await waiting;
    assert.deepEqual(log, [
      'waiting starts',
      'waiting ends',
      'outer starts',
      'inner runs',
      'other server runs',
      'outer ends',
    ]);
    assert.equal(lanes.holds(ONE), false);
  });

  it('gives work a turn started and did not wait for (a timer, a callback) a turn of its own', async () => {
    const lanes = new GuildLanes();
    const log: string[] = [];
    let fromTimer: Promise<void> = Promise.resolve();
    let timerFired: () => void = () => {};
    const fired = new Promise<void>((resolve) => {
      timerFired = resolve;
    });
    await lanes.run(ONE, () => {
      // Its context is this turn's, which will have ended when it fires.
      setTimeout(() => {
        fromTimer = lanes.run(ONE, () => {
          log.push(`timer runs, in a turn of its own: ${lanes.holds(ONE)}`);
        });
        timerFired();
      }, 1);
    });
    // Another turn holds the lane when the timer fires: the timer's change waits for it.
    const holding = lanes.run(ONE, async () => {
      log.push('holding starts');
      await fired;
      await tick();
      log.push('holding ends');
    });
    await holding;
    await fromTimer;
    assert.deepEqual(log, ['holding starts', 'holding ends', 'timer runs, in a turn of its own: true']);
  });

  it('runs later() after the turn asking for it, even from inside that turn', async () => {
    const lanes = new GuildLanes();
    const log: string[] = [];
    let after: Promise<void> = Promise.resolve();
    await lanes.run(ONE, async () => {
      after = lanes.later(ONE, () => {
        log.push('later');
      });
      await tick();
      log.push('turn ends');
    });
    await after;
    assert.deepEqual(log, ['turn ends', 'later']);
  });

  it('passes a failed change its error, and goes on with the next', async () => {
    const lanes = new GuildLanes();
    const failing = lanes.run(ONE, async () => {
      await tick();
      throw new Error('nope');
    });
    const thrown = lanes.run(ONE, () => {
      throw new Error('at once');
    });
    const next = lanes.run(ONE, () => 'next');
    await assert.rejects(failing, /nope/);
    await assert.rejects(thrown, /at once/);
    assert.equal(await next, 'next');
  });

  it('settles idle() once every turn asked for, and every turn those asked for, is over', async () => {
    const lanes = new GuildLanes();
    const log: string[] = [];
    void lanes.run(ONE, async () => {
      await tick();
      void lanes.later(ONE, noted(log, 'asked by the first', 1));
    });
    void lanes.run(TWO, noted(log, 'two', 2));
    await lanes.idle();
    assert.deepEqual(log.filter((line) => line.endsWith('ends')).sort(), ['asked by the first ends', 'two ends']);
    await flush();
    await lanes.idle(ONE);
  });
});
