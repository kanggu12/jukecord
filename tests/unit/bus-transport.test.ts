/**
 * The bus's transports keep one contract: messages reach whoever listens when they are sent, in order and later (never
 * inside the publisher's call), a count of who heard them, and a lease one owner holds at a time. The same tests run
 * on the memory transport and, when JUKECORD_TEST_BUS_URL names a server, on Redis or Valkey, where a connection the
 * server cuts is seen going down and coming back with its subscriptions.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { connectRedis } from '../../src/bus/redis.ts';
import { eventually, settle, TEST_BUS_URL, testBuses, testLog } from '../support/bus.ts';

for (const { name, make } of testBuses()) {
  describe(`the ${name} bus`, () => {
    const bus = make();
    after(() => bus.close());

    it('hands a message to every listener, in the order sent, and says how many heard it', async () => {
      const a = await bus.connect('a');
      const b = await bus.connect('b');
      const heard: string[] = [];
      await a.subscribe(`${bus.prefix}:x`, (message) => heard.push(`a ${message}`));
      await b.subscribe(`${bus.prefix}:x`, (message) => heard.push(`b ${message}`));
      const sender = await bus.connect('sender');
      assert.equal(await sender.publish(`${bus.prefix}:x`, 'one'), 2);
      assert.equal(await sender.publish(`${bus.prefix}:x`, 'two'), 2);
      await eventually(() => heard.length === 4, 'four deliveries');
      assert.deepEqual(
        heard.filter((line) => line.startsWith('a')),
        ['a one', 'a two'],
      );
      assert.deepEqual(
        heard.filter((line) => line.startsWith('b')),
        ['b one', 'b two'],
      );
    });

    it("delivers later than the publisher's own call, and to nobody when nobody listens", async () => {
      const t = await bus.connect('t');
      const heard: string[] = [];
      await t.subscribe(`${bus.prefix}:later`, (message) => heard.push(message));
      const sending = t.publish(`${bus.prefix}:later`, 'm');
      assert.deepEqual(heard, []);
      await sending;
      assert.equal(await t.publish(`${bus.prefix}:nobody`, 'lost'), 0);
      await eventually(() => heard.length === 1, 'the message');
    });

    it('stops handing messages to a listener that let go', async () => {
      const t = await bus.connect('t');
      const heard: string[] = [];
      const stop = await t.subscribe(`${bus.prefix}:stop`, (message) => heard.push(message));
      await t.publish(`${bus.prefix}:stop`, 'before');
      await eventually(() => heard.length === 1, 'the first message');
      await stop();
      assert.equal(await t.publish(`${bus.prefix}:stop`, 'after'), 0);
      await settle();
      assert.deepEqual(heard, ['before']);
    });

    it('lets one owner hold a lease at a time, renewed by it, given back by it only, and lapsing by itself', async () => {
      const t = await bus.connect('t');
      const lease = `${bus.prefix}:lease:test`;
      assert.equal(await t.hold(lease, 'first', 300), true);
      assert.equal(await t.hold(lease, 'second', 300), false);
      // Renewed: still the first's after what would have been its end.
      assert.equal(await t.hold(lease, 'first', 300), true);
      await t.release(lease, 'second');
      assert.equal(await t.hold(lease, 'second', 300), false);
      await t.release(lease, 'first');
      assert.equal(await t.hold(lease, 'second', 150), true);
      // Not renewed: it lapses, and the next owner takes it.
      await settle(250);
      assert.equal(await t.hold(lease, 'third', 300), true);
      assert.equal(await t.ping(), true);
    });
  });
}

describe('the memory bus cut off', () => {
  it('fails calls at once while down, loses what was on its way, and says when it is back', async () => {
    const { memoryBus } = await import('../support/bus.ts');
    const bus = memoryBus();
    const sender = await bus.connect();
    const listener = (await bus.connect()) as import('../../src/bus/memory.ts').MemoryTransport;
    const heard: string[] = [];
    const changes: boolean[] = [];
    listener.onChange((up) => changes.push(up));
    await listener.subscribe(`${bus.prefix}:c`, (message) => heard.push(message));
    // Sent, then the listener's connection drops before it arrives: lost, as on a network.
    await sender.publish(`${bus.prefix}:c`, 'lost');
    listener.setConnected(false);
    await assert.rejects(listener.publish(`${bus.prefix}:c`, 'x'), /not connected/);
    assert.equal(await sender.publish(`${bus.prefix}:c`, 'while down'), 0);
    listener.setConnected(true);
    await sender.publish(`${bus.prefix}:c`, 'back');
    await eventually(() => heard.length === 1, 'the message after it came back');
    assert.deepEqual(heard, ['back']);
    assert.deepEqual(changes, [false, true]);
    await bus.close();
  });
});

describe('the Redis bus cut off', { skip: !TEST_BUS_URL && 'JUKECORD_TEST_BUS_URL is not set' }, () => {
  it('goes down when the server cuts its connections, and comes back subscribed', async () => {
    const { redisBus } = await import('../support/bus.ts');
    const bus = redisBus(TEST_BUS_URL ?? '');
    const admin = await connectRedis(TEST_BUS_URL ?? '', { log: testLog().log, name: 'jukecord-test-admin' });
    try {
      const t = await bus.connect('cut');
      const changes: boolean[] = [];
      t.onChange((up) => changes.push(up));
      const heard: string[] = [];
      await t.subscribe(`${bus.prefix}:cut`, (message) => heard.push(message));
      // The server closes this service's two connections, as a restart or a network cut does. Each line of the list
      // names its connection (" name=", not the library's "lib-name=" further on).
      const list = String(await admin.sendCommand(['CLIENT', 'LIST']));
      const ids = [...list.matchAll(/^id=(\d+) .*? name=(\S+)/gm)]
        .filter((match) => match[2]?.startsWith(`jukecord-${bus.prefix}-cut`))
        .map((match) => match[1] ?? '');
      assert.equal(ids.length, 2, 'both connections of the service are found by their names');
      for (const id of ids) await admin.sendCommand(['CLIENT', 'KILL', 'ID', id]);
      await eventually(() => changes.includes(false), 'the bus going down');
      await eventually(() => t.up, 'the bus coming back', 10_000);
      assert.deepEqual(changes.slice(-1), [true]);
      // Subscribed again: a message sent now arrives.
      await eventually(() => {
        void t.publish(`${bus.prefix}:cut`, 'after').catch(() => {});
        return heard.length > 0;
      }, 'a message after the reconnect');
      assert.equal(heard[0], 'after');
    } finally {
      await admin.close();
      await bus.close();
    }
  });
});
