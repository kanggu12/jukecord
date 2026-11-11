import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Bus } from '../../src/core/bus.ts';

describe('Bus', () => {
  it('calls every listener when one throws, and does not throw at the code that emitted', () => {
    const failures: [string, string | null, string][] = [];
    const bus = new Bus((event, guildId, error) => failures.push([event, guildId, String(error)]));
    const heard: string[] = [];
    bus.on('queue', () => heard.push('first'));
    bus.on('queue', () => {
      throw new Error('a panel could not be told');
    });
    bus.on('queue', (event) => heard.push(`third ${event.guildId}`));
    // A player's timer emits like this; an error here would end the process and every server's music.
    assert.doesNotThrow(() => bus.emit('queue', { guildId: 'g1', version: 3 }));
    assert.deepEqual(heard, ['first', 'third g1']);
    assert.deepEqual(failures, [['queue', 'g1', 'Error: a panel could not be told']]);
  });

  it('still calls a once() listener once and answers whether anyone listened', () => {
    const bus = new Bus(() => {});
    let calls = 0;
    bus.once('voice', () => {
      calls += 1;
    });
    assert.equal(bus.emit('voice', { guildId: 'g1', channel: null }), true);
    assert.equal(bus.emit('voice', { guildId: 'g1', channel: null }), false);
    assert.equal(calls, 1);
  });
});
