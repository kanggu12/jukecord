/**
 * The buses tests run on: always the one in memory, and Redis or Valkey when JUKECORD_TEST_BUS_URL names a server
 * (a throwaway container: docs/TESTING.md). Every test gets names of its own on the server, so tests that run side by
 * side, and runs one after another, never hear each other.
 */
import { randomBytes } from 'node:crypto';
import { MemoryBroker } from '../../src/bus/memory.ts';
import { RedisTransport } from '../../src/bus/redis.ts';
import { type BusNames, type BusTransport, busNames } from '../../src/bus/transport.ts';
import { createLogger, type Logger, MemorySink } from '../../src/log.ts';

/** The Redis or Valkey server of the tests that need one, or null (those tests are skipped). */
export const TEST_BUS_URL = process.env.JUKECORD_TEST_BUS_URL?.trim() || null;

/** One bus for a test: connections to it (one per service), the names under a prefix of its own, and its end. */
export interface TestBus {
  readonly kind: 'memory' | 'redis';
  /** The server's address (a Redis bus), for the shared cache the services keep there too; null in memory. */
  readonly url: string | null;
  readonly names: BusNames;
  readonly prefix: string;
  /** Another service's connection to the same bus. */
  connect(service?: string): Promise<BusTransport>;
  /** Closes every connection made. */
  close(): Promise<void>;
}

/** A logger that keeps what it is told, for tests that look at the log. */
export function testLog(): { log: Logger; sink: MemorySink } {
  const sink = new MemorySink();
  return { log: createLogger({ level: 'debug', sinks: [sink] }), sink };
}

/** The buses to run a test on: memory, and Redis when a server is named. */
export function testBuses(): { name: string; make: () => TestBus }[] {
  const buses = [{ name: 'memory', make: memoryBus }];
  if (TEST_BUS_URL) buses.push({ name: 'redis', make: () => redisBus(TEST_BUS_URL) });
  return buses;
}

function prefix(): string {
  return `jukecord-test-${randomBytes(4).toString('hex')}`;
}

/** A bus in memory. */
export function memoryBus(): TestBus {
  const broker = new MemoryBroker();
  const made: BusTransport[] = [];
  const name = prefix();
  return {
    kind: 'memory',
    url: null,
    names: busNames(name),
    prefix: name,
    connect: async () => {
      const transport = broker.transport();
      made.push(transport);
      return transport;
    },
    close: async () => {
      await Promise.all(made.map((transport) => transport.close()));
    },
  };
}

/** A bus on a Redis or Valkey server. */
export function redisBus(url: string): TestBus {
  const made: BusTransport[] = [];
  const name = prefix();
  const { log } = testLog();
  return {
    kind: 'redis',
    url,
    names: busNames(name),
    prefix: name,
    connect: async (service = 'test') => {
      const transport = await RedisTransport.open(url, { log, service: `${name}-${service}`, waitMs: 5000 });
      made.push(transport);
      return transport;
    },
    close: async () => {
      await Promise.all(made.map((transport) => transport.close()));
    },
  };
}

/** Waits until `check` holds, looking every few milliseconds, for at most `ms` (then fails with `what`). */
export async function eventually(check: () => boolean, what: string, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Waits a little: long enough for messages on their way to arrive. */
export function settle(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
