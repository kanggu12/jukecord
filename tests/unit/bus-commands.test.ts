/**
 * Commands over the bus: an edge's call gets the core's value, or its error as one process would have had it (an
 * ActionError with its code, message, spent and Retry-After; a store's error; anything else as the core's failure,
 * logged there). Nothing hangs: no core, a bus that is down, a core too slow, a core lost meanwhile and a caller that
 * goes away each end the call at once or at its time limit, and the core hears when nobody waits any more. On the
 * memory bus always, and on Redis or Valkey when JUKECORD_TEST_BUS_URL names one.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { ActionError } from '../../src/app/actions.ts';
import { CoreFailure, decodeArgs, encodeArgs } from '../../src/bus/codec.ts';
import {
  CORE_AWAY,
  CORE_LATE,
  CommandClient,
  type CommandHandler,
  CommandServer,
  serviceId,
} from '../../src/bus/commands.ts';
import type { MemoryTransport } from '../../src/bus/memory.ts';
import { busNames } from '../../src/bus/transport.ts';
import { sayError } from '../../src/core/say.ts';
import { MetricsRegistry } from '../../src/metrics/registry.ts';
import { busReport } from '../../src/metrics/services.ts';
import { StoreError } from '../../src/store/sql.ts';
import { eventually, memoryBus, settle, testBuses, testLog } from '../support/bus.ts';

describe("an edge's refusals", () => {
  it('are said in Korean too, as the panel shows them', () => {
    for (const message of [CORE_AWAY, CORE_LATE]) {
      assert.notEqual(sayError(message, 'ko'), sayError(message, 'en'), `no Korean for "${message}"`);
    }
  });
});

describe('the wire codec', () => {
  it('keeps an undefined argument between two given ones, which JSON would turn into null', () => {
    const args = ['g', undefined, 3, null, { a: 1 }];
    const back = decodeArgs(JSON.parse(JSON.stringify(encodeArgs(args))));
    assert.deepEqual(back, ['g', undefined, 3, null, { a: 1 }]);
    assert.equal(back.length, 5);
  });
});

for (const { name, make } of testBuses()) {
  describe(`commands on the ${name} bus`, () => {
    const bus = make();
    after(() => bus.close());

    // A core answering the handlers given, and an edge calling it, on the test's bus under names of their own (two
    // cores on one commands channel would both take every call).
    let pairs = 0;
    async function pair(handlers: Record<string, CommandHandler>, limits: Record<string, number> = {}) {
      const core = testLog();
      const edge = testLog();
      pairs += 1;
      const names = busNames(`${bus.prefix}-${pairs}`);
      const server = await CommandServer.start({
        transport: await bus.connect('core'),
        names,
        handlers: new Map(Object.entries(handlers)),
        log: core.log,
      });
      const metrics = new MetricsRegistry();
      const client = await CommandClient.start({
        transport: await bus.connect('edge'),
        names,
        caller: serviceId('edge'),
        log: edge.log,
        // The names these tests send, as an edge's list of the core's commands.
        report: busReport(metrics, ['ok', 'no', 'slow', 'echo', 'check', 'boom']),
        limitMs: (command) => limits[command] ?? 2000,
      });
      return { server, client, core, edge, metrics };
    }

    it("gives the core's value, the arguments arriving as they were sent", async () => {
      const { server, client } = await pair({ echo: (args) => ({ args, n: args.length }), nothing: () => undefined });
      assert.deepEqual(await client.call('echo', ['g1', undefined, 2]), { args: ['g1', null, 2], n: 3 });
      // The handler had undefined where the caller left an argument out (JSON's null is only how the answer came back).
      const { server: second, client: other } = await pair({ check: (args) => args[1] === undefined });
      assert.equal(await other.call('check', ['a', undefined, 'c']), true);
      assert.equal(await client.call('nothing', []), undefined);
      await Promise.all([server.close(), client.close(), second.close(), other.close()]);
    });

    it("keeps an ActionError's code, message, spent and Retry-After, and a store's error as one", async () => {
      const { server, client } = await pair({
        busy: () => {
          throw new ActionError('unavailable', 'LRCLIB did not answer; try again in a moment', {
            retryAfterMs: 1234,
          });
        },
        missing: async () => {
          throw new ActionError('not-found', 'none of its tracks was found on YouTube', { spent: true });
        },
        store: () => {
          throw new StoreError('position 9 is outside the queue (0-3)');
        },
      });
      await assert.rejects(client.call('busy', []), (error: unknown) => {
        assert.ok(error instanceof ActionError);
        assert.equal(error.code, 'unavailable');
        assert.equal(error.retryAfterMs, 1234);
        assert.equal(error.spent, false);
        return true;
      });
      await assert.rejects(client.call('missing', []), (error: unknown) => {
        assert.ok(error instanceof ActionError);
        assert.equal(error.code, 'not-found');
        assert.equal(error.message, 'none of its tracks was found on YouTube');
        assert.equal(error.spent, true);
        assert.equal(error.retryAfterMs, null);
        return true;
      });
      await assert.rejects(client.call('store', []), (error: unknown) => {
        assert.ok(error instanceof StoreError);
        assert.equal(error.message, 'position 9 is outside the queue (0-3)');
        return true;
      });
      await Promise.all([server.close(), client.close()]);
    });

    it("tells the edge nothing of the core's own failure, and logs it at the core", async () => {
      const { server, client, core } = await pair({
        broken: () => {
          throw new TypeError('cannot read properties of undefined (secret details)');
        },
      });
      await assert.rejects(client.call('broken', []), (error: unknown) => {
        assert.ok(error instanceof CoreFailure);
        assert.doesNotMatch(error.message, /secret details/);
        return true;
      });
      await eventually(
        () => core.sink.records.some((record) => record.msg === 'a command failed'),
        "the core's log line",
      );
      // A command the core does not know is its failure too, not a hang.
      await assert.rejects(client.call('no-such-command', []), CoreFailure);
      await Promise.all([server.close(), client.close()]);
    });

    it('refuses at once when no core listens, as "unavailable" with a Retry-After', async () => {
      const lonely = await CommandClient.start({
        transport: await bus.connect('alone'),
        names: { ...bus.names, commands: `${bus.prefix}:nobody-here` },
        caller: serviceId('edge'),
        log: testLog().log,
      });
      const started = Date.now();
      await assert.rejects(lonely.call('anything', []), (error: unknown) => {
        assert.ok(error instanceof ActionError);
        assert.equal(error.code, 'unavailable');
        assert.equal(error.message, CORE_AWAY);
        assert.equal(error.retryAfterMs, 2000);
        return true;
      });
      assert.ok(Date.now() - started < 1000, 'refused without waiting for the time limit');
      await lonely.close();
    });

    it('refuses a call the core does not answer in time, and tells the core to stop it', async () => {
      let aborted = false;
      const { server, client } = await pair(
        {
          slow: (_args, signal) =>
            new Promise((resolve) => {
              signal.addEventListener('abort', () => {
                aborted = true;
                resolve('stopped');
              });
            }),
        },
        { slow: 150 },
      );
      await assert.rejects(client.call('slow', []), (error: unknown) => {
        assert.ok(error instanceof ActionError);
        assert.equal(error.message, CORE_LATE);
        return true;
      });
      await eventually(() => aborted, 'the core hearing that nobody waits');
      assert.equal(client.pending, 0);
      await Promise.all([server.close(), client.close()]);
    });

    it('stops waiting when its caller goes away, and the core stops the work', async () => {
      let aborted = false;
      let started = false;
      const { server, client } = await pair({
        search: (_args, signal) =>
          new Promise((_resolve, reject) => {
            started = true;
            signal.addEventListener('abort', () => {
              aborted = true;
              reject(new Error('aborted'));
            });
          }),
      });
      const gone = new AbortController();
      const call = client.call('search', ['words'], { signal: gone.signal });
      await eventually(() => started, 'the search starting at the core');
      gone.abort(new Error('the browser went away'));
      await assert.rejects(call, /the browser went away/);
      await eventually(() => aborted, 'the core stopping the search');
      await Promise.all([server.close(), client.close()]);
    });

    it('refuses every call waiting when the core is lost', async () => {
      const { server, client } = await pair({ forever: () => new Promise(() => {}) });
      const calls = [client.call('forever', []), client.call('forever', [])];
      await eventually(() => server.busy === 2, 'both calls running at the core');
      client.failAll();
      for (const call of calls) await assert.rejects(call, /starting or restarting/);
      assert.equal(client.pending, 0);
      await Promise.all([server.close(), client.close()]);
    });

    it('counts each command and its time in the metrics, by outcome, a name off the list as other', async () => {
      const { server, client, metrics } = await pair({
        ok: () => 1,
        no: () => {
          throw new ActionError('conflict', 'nothing is playing');
        },
        unlisted: () => 2,
      });
      await client.call('ok', []);
      await assert.rejects(client.call('no', []));
      await client.call('unlisted', []);
      const aborted = new AbortController();
      const cancelled = client.call('ok', [], { signal: aborted.signal });
      aborted.abort(new Error('the browser went away'));
      await assert.rejects(cancelled, /went away/);
      const text = metrics.render();
      assert.match(text, /jukecord_bus_commands_total\{command="ok",outcome="ok"\} 1/);
      assert.match(text, /jukecord_bus_commands_total\{command="no",outcome="error"\} 1/);
      assert.match(text, /jukecord_bus_commands_total\{command="other",outcome="ok"\} 1/);
      assert.match(text, /jukecord_bus_commands_total\{command="ok",outcome="cancelled"\} 1/);
      assert.match(text, /jukecord_bus_command_duration_seconds_count\{command="ok"\} 2/);
      await Promise.all([server.close(), client.close()]);
    });
  });
}

describe('commands on a bus that goes down', () => {
  it('refuses a call at once while the edge is cut off from the bus', async () => {
    const bus = memoryBus();
    const server = await CommandServer.start({
      transport: await bus.connect(),
      names: bus.names,
      handlers: new Map([['ok', () => 1]]),
      log: testLog().log,
    });
    const transport = (await bus.connect()) as MemoryTransport;
    const client = await CommandClient.start({
      transport,
      names: bus.names,
      caller: serviceId('edge'),
      log: testLog().log,
    });
    assert.equal(await client.call('ok', []), 1);
    transport.setConnected(false);
    await assert.rejects(client.call('ok', []), /starting or restarting/);
    transport.setConnected(true);
    assert.equal(await client.call('ok', []), 1);
    await Promise.all([server.close(), client.close(), bus.close()]);
  });

  it('does not run a call that reaches the core after its caller stopped waiting', async () => {
    const bus = memoryBus();
    let ran = false;
    // The core's clock is a minute ahead: every call looks as if it waited somewhere past its time.
    const server = await CommandServer.start({
      transport: await bus.connect(),
      names: bus.names,
      handlers: new Map([
        [
          'change',
          () => {
            ran = true;
          },
        ],
      ]),
      log: testLog().log,
      now: () => Date.now() + 60_000,
    });
    const client = await CommandClient.start({
      transport: await bus.connect(),
      names: bus.names,
      caller: serviceId('edge'),
      log: testLog().log,
      limitMs: () => 100,
    });
    await assert.rejects(client.call('change', []), /did not answer in time/);
    await settle();
    assert.equal(ran, false);
    await Promise.all([server.close(), client.close(), bus.close()]);
  });
});
