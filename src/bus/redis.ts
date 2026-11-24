/**
 * The bus over Redis or Valkey: the services of a split jukecord, each in its own process, joined through one server.
 *
 * Two connections: one that sends (publish, the lease, the ping) and one that listens (a connection that subscribes
 * can do nothing else). Neither queues anything while it is down: a call then fails at once, so nothing that waits on
 * the bus hangs for the length of an outage; the callers above say "unavailable" instead. Both reconnect by themselves
 * (the client's own backoff, up to two seconds between tries) and the listening one subscribes again; the listeners
 * hear that the connection was lost and that it is back, because what was sent meanwhile is lost. A connection that
 * stays open while the server is gone (no answer to its pings) is ended and made again (WatchedConnection), and every
 * call has a time limit, so a silent server is an outage like any other within seconds.
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

// How long any call to the server may take before it fails: far more than a server beside jukecord takes (a
// millisecond or two), and short enough that a request counted on the shared cache never waits long on a silent one.
const CALL_LIMIT_MS = 2000;
// A ping this often on every connection; this many unanswered in a row and the connection is taken for dead.
const PING_EVERY_MS = 3000;
const SILENT_PINGS = 2;

// The events of a client that the adapters listen to, passed on from whichever client is the current one.
const EVENTS = ['ready', 'end', 'reconnecting', 'error', 'connect'] as const;

/** A call the server did not answer within its limit (the connection may have gone silent). */
export class RedisTimeout extends Error {
  override name = 'RedisTimeout';
}

// A call given up after `ms`: the client's own limit covers only a call still waiting to be written, not one written
// and never answered. What it settles to afterwards is ignored (the connection made again rejects it).
function limited<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RedisTimeout(`Redis did not answer within ${ms} ms`)), ms);
    timer.unref();
  });
  work.catch(() => {});
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * A connection that makes itself again when it goes silent. The client reconnects by itself when its socket closes,
 * but a server gone without closing it (its machine died, the network between was cut) leaves the socket open and
 * the client "ready" for as long as TCP takes to give up, a quarter of an hour, and a call written to it waits that
 * long: the client's own time limit covers only calls not written yet. So every call here has its limit, and a ping
 * every few seconds that goes unanswered twice in a row ends that client and starts a new one, which subscribes again
 * to every channel the old one listened to; meanwhile it is not ready, and every call fails at once.
 */
class WatchedConnection implements RedisConnection {
  private client: RedisConnection;
  private readonly make: () => RedisConnection;
  private readonly log: Logger;
  private readonly name: string;
  private readonly callLimitMs: number;
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  // What this connection listens to, by channel, to subscribe a new client to it all again.
  private readonly channels = new Map<string, Set<(message: string) => void>>();
  private readonly watch: NodeJS.Timeout;
  // Pings unanswered in a row, and whether one is on its way.
  private silent = 0;
  private probing = false;
  private replacing = false;
  private closed = false;

  constructor(make: () => RedisConnection, options: { log: Logger; name: string; timing?: RedisTiming }) {
    this.make = make;
    this.log = options.log;
    this.name = options.name;
    this.callLimitMs = options.timing?.callLimitMs ?? CALL_LIMIT_MS;
    this.client = this.attach(make());
    this.watch = setInterval(() => void this.probe(), options.timing?.pingEveryMs ?? PING_EVERY_MS);
    this.watch.unref();
  }

  get isReady(): boolean {
    return !this.replacing && !this.closed && this.client.isReady;
  }

  connect(): Promise<unknown> {
    return this.client.connect();
  }

  publish(channel: string, message: string): Promise<number> {
    return limited(this.client.publish(channel, message), this.callLimitMs);
  }

  async subscribe(channel: string, listener: (message: string) => void): Promise<unknown> {
    let set = this.channels.get(channel);
    if (!set) {
      set = new Set();
      this.channels.set(channel, set);
    }
    set.add(listener);
    // Being made again: the new client subscribes to it once it is connected.
    if (this.replacing) return undefined;
    try {
      return await limited(this.client.subscribe(channel, listener), this.callLimitMs);
    } catch (error) {
      set.delete(listener);
      if (set.size === 0) this.channels.delete(channel);
      throw error;
    }
  }

  async unsubscribe(channel: string, listener: (message: string) => void): Promise<unknown> {
    const set = this.channels.get(channel);
    set?.delete(listener);
    if (set?.size === 0) this.channels.delete(channel);
    if (this.replacing) return undefined;
    return limited(this.client.unsubscribe(channel, listener), this.callLimitMs);
  }

  sendCommand(args: string[]): Promise<unknown> {
    return limited(this.client.sendCommand(args), this.callLimitMs);
  }

  ping(): Promise<unknown> {
    return limited(this.client.ping(), this.callLimitMs);
  }

  async close(): Promise<unknown> {
    this.closed = true;
    clearInterval(this.watch);
    return limited(this.client.close(), this.callLimitMs);
  }

  destroy(): void {
    this.closed = true;
    clearInterval(this.watch);
    this.client.destroy();
  }

  on(event: string, listener: (...args: unknown[]) => void): unknown {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return this;
  }

  // Passes a client's events on while it is the current one.
  private attach(client: RedisConnection): RedisConnection {
    for (const event of EVENTS) {
      client.on(event, (...args: unknown[]) => {
        if (client !== this.client) return;
        if (event === 'ready') this.silent = 0;
        this.emit(event, ...args);
      });
    }
    return client;
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  // One ping, within the call limit: twice unanswered in a row, the connection is made again. A connection the
  // client knows is lost (not ready) is the client's own to reconnect.
  private async probe(): Promise<void> {
    if (this.probing || this.replacing || this.closed || !this.client.isReady) return;
    this.probing = true;
    const client = this.client;
    try {
      await limited(client.ping(), this.callLimitMs);
      if (client === this.client) this.silent = 0;
    } catch {
      if (client !== this.client || this.closed || !client.isReady) return;
      this.silent += 1;
      if (this.silent >= SILENT_PINGS) this.replace();
    } finally {
      this.probing = false;
    }
  }

  // Ends the silent client and connects a new one, subscribed again to every channel.
  private replace(): void {
    if (this.replacing || this.closed) return;
    this.replacing = true;
    this.silent = 0;
    this.log.warn('the connection to Redis went silent; it is made again', { connection: this.name });
    const old = this.client;
    this.client = this.attach(this.make());
    old.destroy();
    // Down until the new one is connected and subscribed.
    this.emit('reconnecting');
    void this.reconnect(this.client);
  }

  private async reconnect(client: RedisConnection): Promise<void> {
    try {
      // The client tries until it connects (its own backoff, two seconds at most between tries).
      await client.connect();
      for (const [channel, set] of this.channels)
        for (const listener of set) await limited(client.subscribe(channel, listener), this.callLimitMs);
    } catch (error) {
      // Closed meanwhile, or silent again while it subscribed: a later ping makes it again.
      if (this.closed || client !== this.client) return;
      this.log.debug('the connection to Redis could not be made again yet', { connection: this.name, error });
    } finally {
      if (client === this.client) this.replacing = false;
    }
    if (client === this.client && !this.closed) this.emit('ready');
  }
}

/** How often a connection pings, and how long a call may take (tests shorten both). */
export interface RedisTiming {
  readonly pingEveryMs?: number;
  readonly callLimitMs?: number;
}

/** Opens a client connection to a Redis or Valkey server, waiting for it up to `waitMs` (60 s by default). */
export async function connectRedis(
  url: string,
  options: { log: Logger; name: string; waitMs?: number; timing?: RedisTiming },
): Promise<RedisConnection> {
  // Loaded here, not at the top: a single process (no bus, no Redis cache) never loads the client.
  const { createClient } = await import('@redis/client');
  const make = () =>
    createClient({
      url: redisAddress(url),
      // A call while the connection is down fails at once instead of waiting in a queue for the server to come back.
      disableOfflineQueue: true,
      // The server's view of who is connected (CLIENT LIST) names the service.
      name: options.name,
      // The client's own limit for a call not written yet (written ones are limited by WatchedConnection, which
      // pings too).
      commandOptions: { timeout: options.timing?.callLimitMs ?? CALL_LIMIT_MS },
      socket: { connectTimeout: 5000 },
    }) as unknown as RedisConnection;
  const client = new WatchedConnection(make, options);
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
      reason: error instanceof Error ? error.message || error.constructor.name : String(error),
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
  private readonly log: Logger;
  private readonly changes = new Set<(up: boolean) => void>();
  private wasUp: boolean;
  private closed = false;

  private constructor(sender: RedisConnection, listener: RedisConnection, log: Logger) {
    this.sender = sender;
    this.listener = listener;
    this.log = log;
    this.wasUp = this.up;
    // Each connection says when it is lost and when it is back; the bus is up while both are.
    for (const client of [sender, listener]) {
      for (const event of ['ready', 'end', 'reconnecting', 'error']) client.on(event, () => this.changed());
    }
  }

  /** Connects both ways to the server at `url`, waiting for it up to `waitMs`. */
  static async open(
    url: string,
    options: { log: Logger; service: string; waitMs?: number; timing?: RedisTiming },
  ): Promise<RedisTransport> {
    const sender = await connectRedis(url, { ...options, name: `jukecord-${options.service}` });
    try {
      const listener = await connectRedis(url, { ...options, name: `jukecord-${options.service}-listen` });
      return new RedisTransport(sender, listener, options.log);
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
    // A listener that throws is a mistake in jukecord, said in the log: it must not reach the client, whose reading of
    // the connection would break on it.
    const heard = (message: string) => {
      try {
        listener(message);
      } catch (error) {
        this.log.error('a listener on the bus failed', { channel, error });
      }
    };
    await this.listener.subscribe(channel, heard);
    return async () => {
      // Closed meanwhile: the subscription went with the connection.
      if (this.closed) return;
      await this.listener.unsubscribe(channel, heard);
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
