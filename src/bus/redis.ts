/**
 * The bus over Redis or Valkey: the services of a split jukecord, each in its own process, joined through one server.
 *
 * Two connections: one that sends (publish, the lease, the ping) and one that listens (a connection that subscribes
 * can do nothing else). Neither queues anything while it is down: a call then fails at once, so nothing that waits on
 * the bus hangs for the length of an outage; the callers above say "unavailable" instead. Both reconnect by themselves
 * (the client's own backoff, up to two seconds between tries) and the listening one subscribes again; the listeners
 * hear that the connection was lost and that it is back, because what was sent meanwhile is lost.
 *
 * The client (`@redis/client`, pure JavaScript) is loaded only when a bus address is set, so one process never loads
 * it. Valkey speaks the same protocol; `valkey://` and `valkeys://` are taken as `redis://` and `rediss://` (TLS).
 */
import type { Logger } from '../log.ts';
import type { BusTransport } from './transport.ts';

/** What the two adapters over a Redis server (this one and the cache's) need from a client connection. */
export interface RedisConnection {
  readonly isReady: boolean;
  connect(): Promise<unknown>;
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string, listener: (message: string) => void): Promise<unknown>;
  unsubscribe(channel: string, listener: (message: string) => void): Promise<unknown>;
  sendCommand(args: string[]): Promise<unknown>;
  ping(): Promise<unknown>;
  close(): Promise<unknown>;
  destroy(): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** The address as the client takes it: Valkey's own schemes under Redis's names. */
export function redisAddress(url: string): string {
  return url.replace(/^valkey(s?):\/\//i, 'redis$1://');
}

/** An address fit for a log line: the password (and the user name) left out. */
export function shownAddress(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
    }
    return parsed.href.replace(/\/$/, '');
  } catch {
    return 'an address that is not a URL';
  }
}

/** Opens a client connection to a Redis or Valkey server, waiting for it up to `waitMs` (60 s by default). */
export async function connectRedis(
  url: string,
  options: { log: Logger; name: string; waitMs?: number },
): Promise<RedisConnection> {
  // Loaded here, not at the top: a single process (no bus, no Redis cache) never loads the client.
  const { createClient } = await import('@redis/client');
  const client = createClient({
    url: redisAddress(url),
    // A call while the connection is down fails at once instead of waiting in a queue for the server to come back.
    disableOfflineQueue: true,
    // The server's view of who is connected (CLIENT LIST) names the service.
    name: options.name,
    // A ping every five seconds finds a connection that went silent (a server gone without closing it).
    pingInterval: 5000,
    socket: { connectTimeout: 5000 },
  }) as unknown as RedisConnection;
  const shown = shownAddress(url);
  // The client reports every lost connection as an error; without a listener Node would end the process on it. Said
  // at most once a minute, with how many since.
  let errors = 0;
  let toldAt = Number.NEGATIVE_INFINITY;
  client.on('error', (error) => {
    errors += 1;
    if (Date.now() - toldAt < 60_000) return;
    options.log.warn('the connection to Redis failed; it is tried again', {
      server: shown,
      connection: options.name,
      times: errors,
      reason: error instanceof Error ? error.message : String(error),
    });
    errors = 0;
    toldAt = Date.now();
  });
  const waitMs = options.waitMs ?? 60_000;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`no answer from ${shown} within ${Math.round(waitMs / 1000)} s`)),
      waitMs,
    );
    timer.unref();
  });
  try {
    await Promise.race([client.connect(), late]);
  } catch (error) {
    client.destroy();
    throw new Error(`jukecord could not reach Redis at ${shown}: ${error instanceof Error ? error.message : error}`);
  } finally {
    clearTimeout(timer);
  }
  return client;
}

/** A Lua script, run by its hash and sent whole only when the server does not have it yet. */
export interface Script {
  readonly text: string;
  sha: string | null;
}

/** Runs a script on the server: by its hash, or whole the first time (and after the server forgot it on a restart). */
export async function runScript(
  client: RedisConnection,
  script: Script,
  keys: readonly string[],
  args: readonly (string | number)[],
): Promise<unknown> {
  const tail = [String(keys.length), ...keys, ...args.map(String)];
  if (script.sha) {
    try {
      return await client.sendCommand(['EVALSHA', script.sha, ...tail]);
    } catch (error) {
      // NOSCRIPT: the server does not have it (it restarted); sent whole below. Anything else is the call's failure.
      if (!(error instanceof Error) || !error.message.startsWith('NOSCRIPT')) throw error;
    }
  }
  const sha = await client.sendCommand(['SCRIPT', 'LOAD', script.text]);
  script.sha = typeof sha === 'string' ? sha : null;
  return client.sendCommand(['EVAL', script.text, ...tail]);
}

// Takes the lease when it is free, renews it when the owner holds it already: 1 when the owner holds it after.
const HOLD: Script = {
  text: `local held = redis.call('GET', KEYS[1])
if not held then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return 1
end
if held == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0`,
  sha: null,
};

// Gives the lease back, only when the owner holds it.
const RELEASE: Script = {
  text: `if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`,
  sha: null,
};

export class RedisTransport implements BusTransport {
  readonly kind = 'redis';
  private readonly sender: RedisConnection;
  private readonly listener: RedisConnection;
  private readonly changes = new Set<(up: boolean) => void>();
  private wasUp: boolean;
  private closed = false;

  private constructor(sender: RedisConnection, listener: RedisConnection) {
    this.sender = sender;
    this.listener = listener;
    this.wasUp = this.up;
    // Each connection says when it is lost and when it is back; the bus is up while both are.
    for (const client of [sender, listener]) {
      for (const event of ['ready', 'end', 'reconnecting', 'error']) client.on(event, () => this.changed());
    }
  }

  /** Connects both ways to the server at `url`, waiting for it up to `waitMs`. */
  static async open(url: string, options: { log: Logger; service: string; waitMs?: number }): Promise<RedisTransport> {
    const sender = await connectRedis(url, { ...options, name: `jukecord-${options.service}` });
    try {
      const listener = await connectRedis(url, { ...options, name: `jukecord-${options.service}-listen` });
      return new RedisTransport(sender, listener);
    } catch (error) {
      sender.destroy();
      throw error;
    }
  }

  get up(): boolean {
    return !this.closed && this.sender.isReady && this.listener.isReady;
  }

  publish(channel: string, message: string): Promise<number> {
    return this.sender.publish(channel, message);
  }

  async subscribe(channel: string, listener: (message: string) => void): Promise<() => Promise<void>> {
    await this.listener.subscribe(channel, listener);
    return async () => {
      // Closed meanwhile: the subscription went with the connection.
      if (this.closed) return;
      await this.listener.unsubscribe(channel, listener);
    };
  }

  async hold(name: string, owner: string, ttlMs: number): Promise<boolean> {
    return Number(await runScript(this.sender, HOLD, [name], [owner, Math.max(1, Math.round(ttlMs))])) === 1;
  }

  async release(name: string, owner: string): Promise<void> {
    await runScript(this.sender, RELEASE, [name], [owner]);
  }

  onChange(listener: (up: boolean) => void): () => void {
    this.changes.add(listener);
    return () => this.changes.delete(listener);
  }

  async ping(): Promise<boolean> {
    try {
      await this.sender.ping();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Closed gently (what was sent goes out), and at once if the server does not answer.
    await Promise.all(
      [this.sender, this.listener].map((client) =>
        client.close().catch(() => {
          client.destroy();
        }),
      ),
    );
  }

  // Tells the listeners when the bus goes down or comes back (each connection's events arrive one by one).
  private changed(): void {
    const up = this.up;
    if (up === this.wasUp || this.closed) return;
    this.wasUp = up;
    for (const listener of [...this.changes]) listener(up);
  }
}
