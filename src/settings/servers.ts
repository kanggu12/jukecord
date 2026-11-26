/**
 * The test of a Redis or Valkey server's address for the shared cache or the bus, without saving it or changing
 * anything: whether jukecord reaches it, what it is (the program and its version), how long a ping takes there and
 * back; or the exact failure, in one sentence.
 *
 * The address is tried as typed, whole: its own user and password, never one saved for another address (a saved secret
 * goes only where it was saved for).
 */

import { withAuthorityHint } from '../authorities.ts';
import { type RedisConnection, redisAddress, shownAddress } from '../bus/redis.ts';
import { REDIS_SCHEMES } from '../config.ts';

/** What the shared cache or the bus is for: the cache may also be this process's memory. */
export type ServerUse = 'cache' | 'bus';

/** What a test of a server's address found. */
export interface ServerTest {
  /** Whether jukecord reached it and it answered. */
  readonly ok: boolean;
  /** The address in words: without its user or password ("memory" for the cache in memory). */
  readonly where: string;
  /** The program and its version ("Valkey 8.1.12", "Redis 7.4.2"), when it answered. */
  readonly server: string | null;
  /** How long a ping took there and back, in milliseconds. */
  readonly roundTripMs: number | null;
  /** Why it cannot be used, in one sentence, when it cannot. */
  readonly problem: string | null;
}

// How long the test waits for the server: long enough for one across a network, short enough for a page that waits.
const WAIT_MS = 5000;

/** Tries an address for the shared cache or the bus. */
export async function testServer(url: string, use: ServerUse, trust?: readonly string[]): Promise<ServerTest> {
  const text = url.trim();
  // The cache in this process's memory: nothing to reach, so nothing that can fail.
  if (use === 'cache' && text.toLowerCase() === 'memory')
    return { ok: true, where: 'memory', server: null, roundTripMs: null, problem: null };
  // The address read by the start's own rule (a Redis or Valkey address with a host), so a test that passes is one the
  // start takes.
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return refused('that is not an address (example: redis://valkey:6379)', 'an address that is not a URL');
  }
  if (!REDIS_SCHEMES.includes(parsed.protocol) || !parsed.hostname)
    return refused(
      'a Redis or Valkey address starts with redis://, rediss:// (TLS), valkey:// or valkeys:// (TLS), and names a host',
      shownAddress(text),
    );
  const where = shownAddress(text);
  let client: RedisConnection | null = null;
  try {
    // A connection of the test's own, named so in the server's list of clients, tried once: the first failure (refused,
    // a wrong password, no answer) is the answer, where the services' connections try again for as long as it takes.
    // Loaded here, as the bus loads it: a single process never needs the client otherwise.
    const { createClient } = await import('@redis/client');
    client = createClient({
      url: redisAddress(text),
      name: 'jukecord-test',
      disableOfflineQueue: true,
      commandOptions: { timeout: WAIT_MS },
      socket: {
        connectTimeout: WAIT_MS,
        reconnectStrategy: false,
        // Over TLS, with authorities the page has not saved yet: those and the ones in use (see trustedWith).
        ...(trust && /^(rediss|valkeys):/i.test(text) ? { tls: true, ca: [...trust] } : {}),
      },
    } as Parameters<typeof createClient>[0]) as unknown as RedisConnection;
    // The client reports its failures as events too; without a listener Node would end the process on one.
    client.on('error', () => {});
    await client.connect();
    // What the server is: Valkey says its own version beside the Redis one it speaks for.
    const info = String(await client.sendCommand(['INFO', 'server']));
    const field = (name: string) => new RegExp(`^${name}:(.+)$`, 'm').exec(info)?.[1]?.trim() ?? null;
    const valkey = field('valkey_version');
    const redis = field('redis_version');
    const server = valkey ? `Valkey ${valkey}` : redis ? `Redis ${redis}` : null;
    // One ping, timed: what each of the cache's reads costs at least.
    const started = performance.now();
    await client.ping();
    const roundTripMs = Math.round((performance.now() - started) * 10) / 10;
    return { ok: true, where, server, roundTripMs, problem: null };
  } catch (error) {
    // The exact failure: the client's or the server's own words ("WRONGPASS invalid username-password pair ..."),
    // after which address.
    // A certificate no trusted authority signed says what to do about it in jukecord's own setting.
    return {
      ok: false,
      where,
      server: null,
      roundTripMs: null,
      problem: `${where}: ${withAuthorityHint(reason(error), error)}`,
    };
  } finally {
    // The test's connection is gone after it, whatever it found (one never made closes nothing).
    if (client?.isReady) await client.close().catch(() => client?.destroy());
    else client?.destroy();
  }

  function refused(problem: string, shown: string): ServerTest {
    return { ok: false, where: shown, server: null, roundTripMs: null, problem };
  }
}

// A failure's sentence: the message of the error, without the stack, one line.
function reason(error: unknown): string {
  const text = error instanceof Error ? error.message || error.constructor.name : String(error);
  return text.split('\n')[0] ?? text;
}
