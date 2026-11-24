/**
 * What else travels the bus: the core's events reaching every edge's own bus in the order they happened, the endings
 * of live connections, who listens on each edge added up (and forgotten when an edge goes quiet), and the core's
 * heartbeat and lease (one core at a time; an edge tells a core found, lost and replaced). On the memory bus always,
 * and on Redis or Valkey when JUKECORD_TEST_BUS_URL names one.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { CoreBeat, type CoreChange, type CoreFacts, CoreWatch } from '../../src/bus/beat.ts';
import { serviceId } from '../../src/bus/commands.ts';
import { type EdgeListeners, Presence, PresenceReporter } from '../../src/bus/presence.ts';
import { type Ending, EventReceiver, EventSender } from '../../src/bus/relay.ts';
import { busNames } from '../../src/bus/transport.ts';
import { Bus } from '../../src/core/bus.ts';
import type { PlayerSnapshot } from '../../src/core/player.ts';
import { eventually, settle, testBuses, testLog } from '../support/bus.ts';

const FACTS: CoreFacts = { discordMode: false, discordReady: false, self: null, behind: false };

// A player snapshot as the core's bus carries it (only the fields the test looks at matter).
function snapshot(guildId: string, version: number): PlayerSnapshot {
  return {
    guildId,
    status: 'playing',
    track: null,
    addedBy: null,
    positionMs: 0,
    at: 0,
    durationMs: null,
    error: null,
    repeat: 'off',
    progress: null,
    version,
    notice: null,
    waiting: false,
    stopAfter: false,
    autoplay: 'off',
  };
}

for (const { name, make } of testBuses()) {
  describe(`events on the ${name} bus`, () => {
    const bus = make();
    after(() => bus.close());
    let next = 0;
    // Names of a test's own, so tests do not hear each other.
    const names = () => {
      next += 1;
      return busNames(`${bus.prefix}-${next}`);
    };

    it("hands the core's events to every edge's bus in order, and not the ones only the core needs", async () => {
      const where = names();
      const core = new Bus();
      const sender = new EventSender(core, { transport: await bus.connect('core'), names: where, log: testLog().log });
      const heard: string[][] = [[], []];
      const endings: Ending[] = [];
      const receivers = await Promise.all(
        [0, 1].map(async (index) => {
          const edge = new Bus();
          for (const event of ['player', 'queue', 'listeners', 'people'] as const) {
            edge.on(event, (payload: { guildId: string; version?: number }) => {
              heard[index]?.push(`${event} ${payload.guildId} ${payload.version ?? ''}`.trim());
            });
          }
          return EventReceiver.start(edge, {
            transport: await bus.connect(`edge${index}`),
            names: where,
            log: testLog().log,
            ended: (ending) => endings.push(ending),
          });
        }),
      );
      core.emit('queue', { guildId: 'g1', version: 1 });
      core.emit('player', snapshot('g1', 7));
      // Who listens is the core's own business: it is not sent.
      core.emit('listeners', { guildId: 'g1', count: 3 });
      core.emit('people', { guildId: 'g1' });
      core.emit('queue', { guildId: 'g1', version: 2 });
      sender.end({ what: 'guests', linkId: 4, reason: 'the listening link has ended' });
      await eventually(() => heard.every((list) => list.length === 3) && endings.length === 2, 'every event');
      for (const list of heard) assert.deepEqual(list, ['queue g1 1', 'player g1 7', 'queue g1 2']);
      assert.deepEqual(endings[0], { what: 'guests', linkId: 4, reason: 'the listening link has ended' });
      sender.stop();
      await Promise.all(receivers.map((receiver) => receiver.stop()));
    });

    it('adds up who listens on each edge, as the core and the other edges see it', async () => {
      const where = names();
      const changes: string[] = [];
      const core = await Presence.start({
        transport: await bus.connect('core'),
        names: where,
        changed: (guild) => changes.push(guild),
        log: testLog().log,
      });
      // What each edge's browsers hold, set by the test.
      const held: Record<string, Record<string, EdgeListeners>> = {
        a: {
          g1: { count: 2, shown: [{ person: 'u1', who: { id: 'u1', name: 'One', avatar: null } }], people: ['u1'] },
        },
        b: {
          g1: {
            count: 1,
            shown: [
              { person: 'u1', who: { id: 'u1', name: 'One', avatar: null } },
              { person: 'guest x', who: { id: null, name: 'Guest', avatar: null, guest: true } },
            ],
            people: ['u1'],
          },
        },
      };
      const reporters = await Promise.all(
        ['a', 'b'].map(async (edge) =>
          PresenceReporter.start({
            transport: await bus.connect(edge),
            names: where,
            edge,
            listeners: (guild) => held[edge]?.[guild] ?? { count: 0, shown: [], people: [] },
            guilds: () => Object.keys(held[edge] ?? {}),
            log: testLog().log,
          }),
        ),
      );
      // Edge a's own view: the other edges only.
      const elsewhere = await Presence.start({
        transport: await bus.connect('a-view'),
        names: where,
        changed: () => {},
        self: 'a',
        log: testLog().log,
      });
      await eventually(() => core.count('g1') === 3 && elsewhere.count('g1') === 1, 'both reports');
      // One person on two edges is one person; everyone's browsers count.
      assert.deepEqual(core.people('g1'), ['u1']);
      assert.deepEqual(
        core.shown('g1').map((entry) => entry.person),
        ['u1', 'guest x'],
      );
      assert.equal(core.edgeCount, 2);
      assert.ok(changes.includes('g1'));
      // A change is reported at once; the heartbeat's repeats are not told as changes.
      changes.length = 0;
      held.b = {};
      reporters[1]?.changed('g1');
      await eventually(() => core.count('g1') === 2, 'the change on edge b');
      assert.deepEqual(changes, ['g1']);
      // An edge that stops says so: it counts no more at once.
      await reporters[0]?.stop();
      await eventually(() => core.count('g1') === 0 && core.edgeCount === 1, 'edge a gone');
      await reporters[1]?.stop();
      await Promise.all([core.stop(), elsewhere.stop()]);
    });

    it('takes one core at a time, and an edge tells the core found, replaced and lost', async () => {
      const where = names();
      const changes: CoreChange[] = [];
      const watch = await CoreWatch.start({
        transport: await bus.connect('edge'),
        names: where,
        version: '0.4.0',
        changed: (change) => changes.push(change),
        log: testLog().log,
        lostAfterMs: 400,
      });
      const lost: string[] = [];
      const first = await CoreBeat.start({
        transport: await bus.connect('core1'),
        names: where,
        instance: serviceId('core'),
        version: '0.4.0',
        facts: () => ({ ...FACTS, discordMode: true }),
        log: testLog().log,
        lost: () => lost.push('first'),
        everyMs: 50,
      });
      await eventually(() => changes.includes('found'), 'the core found');
      assert.equal(watch.facts?.discordMode, true);
      // A second core waits while the first holds the lease.
      const secondInstance = serviceId('core');
      let second: CoreBeat | null = null;
      const starting = CoreBeat.start({
        transport: await bus.connect('core2'),
        names: where,
        instance: secondInstance,
        version: '0.4.0',
        facts: () => FACTS,
        log: testLog().log,
        lost: () => lost.push('second'),
        everyMs: 50,
        retryMs: 50,
      }).then((beat) => {
        second = beat;
      });
      await settle(200);
      assert.equal(second, null, 'the second core waits');
      // The first stops (its goodbye: the edge takes it for lost at once), and the second takes over.
      await first.stop();
      await starting;
      await eventually(() => watch.instance === secondInstance, 'the second core heard');
      assert.deepEqual(changes, ['found', 'lost', 'found']);
      await (second as unknown as CoreBeat).stop();
      await eventually(() => changes.length === 4, 'the second core gone');
      // Neither core lost its lease to the other while it ran.
      assert.deepEqual(lost, []);
      await watch.stop();
    });
  });
}

describe('a core replaced without a goodbye', () => {
  it('is told as replaced: a new instance heartbeat while the old one was still counted', async () => {
    const { memoryBus } = await import('../support/bus.ts');
    const bus = memoryBus();
    const changes: CoreChange[] = [];
    const watch = await CoreWatch.start({
      transport: await bus.connect(),
      names: bus.names,
      version: '0.4.0',
      changed: (change) => changes.push(change),
      log: testLog().log,
    });
    const transport = await bus.connect();
    const beat = (instance: string) =>
      transport.publish(
        bus.names.beat,
        JSON.stringify({ v: 1, type: 'beat', instance, version: '0.4.0', facts: FACTS }),
      );
    await beat('core-old');
    await eventually(() => changes.length === 1, 'found');
    await beat('core-new');
    await eventually(() => changes.length === 2, 'replaced');
    assert.deepEqual(changes, ['found', 'replaced']);
    // A heartbeat of another protocol is not understood, and no core is taken from it.
    await transport.publish(bus.names.beat, JSON.stringify({ v: 2, type: 'bye', instance: 'core-new' }));
    await settle();
    assert.equal(watch.instance, 'core-new');
    await watch.stop();
    await bus.close();
  });

  it('is lost when its heartbeats stop without a goodbye (a core that froze or was cut off)', async () => {
    const { memoryBus } = await import('../support/bus.ts');
    const bus = memoryBus();
    const changes: CoreChange[] = [];
    const watch = await CoreWatch.start({
      transport: await bus.connect(),
      names: bus.names,
      version: '0.4.0',
      changed: (change) => changes.push(change),
      log: testLog().log,
      lostAfterMs: 200,
    });
    const transport = await bus.connect();
    await transport.publish(
      bus.names.beat,
      JSON.stringify({ v: 1, type: 'beat', instance: 'core-a', version: '0.4.0', facts: FACTS }),
    );
    await eventually(() => watch.seen, 'the core seen');
    await eventually(() => changes.at(-1) === 'lost', 'the silent core lost', 2000);
    assert.equal(watch.seen, false);
    assert.equal(watch.facts, null);
    await watch.stop();
    await bus.close();
  });
});
