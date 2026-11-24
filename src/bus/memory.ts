/**
 * The bus in this process's memory: services joined inside one process, the way tests run a core and its edges.
 *
 * A broker stands in for the Redis server; each transport it hands out is one service's connection to it. Messages
 * behave as they do on a server: they reach whoever listens when they are sent, in the order they were sent, a turn of
 * the event loop later (never inside the publisher's own call, which would hide mistakes of order that a network
 * shows), and they are gone if nobody listens. A test can cut one transport off and bring it back, as a lost
 * connection does.
 */
import type { BusTransport } from './transport.ts';

// One subscription: the transport it belongs to, and what it hears.
interface Subscription {
  readonly transport: MemoryTransport;
  readonly listener: (message: string) => void;
}

// A message on its way to one listener.
interface Delivery {
  readonly to: Subscription;
  readonly message: string;
}

export class MemoryBroker {
  // The subscriptions of each channel.
  private readonly channels = new Map<string, Set<Subscription>>();
  // The leases held: who holds each, and until when (on this broker's clock).
  private readonly leases = new Map<string, { owner: string; until: number }>();
  // Messages sent and not yet delivered, oldest first: one order for every channel, as one server has.
  private readonly pending: Delivery[] = [];
  private flushing = false;
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  /** A connection to this broker, for one service. */
  transport(): MemoryTransport {
    return new MemoryTransport(this);
  }

  /** @internal Sends a message to the channel's listeners whose transport is up; how many there were. */
  publish(channel: string, message: string): number {
    const receivers = [...(this.channels.get(channel) ?? [])].filter((subscription) => subscription.transport.up);
    for (const to of receivers) this.pending.push({ to, message });
    if (receivers.length > 0) this.schedule();
    return receivers.length;
  }

  /** @internal */
  subscribe(channel: string, subscription: Subscription): () => void {
    let set = this.channels.get(channel);
    if (!set) {
      set = new Set();
      this.channels.set(channel, set);
    }
    set.add(subscription);
    return () => {
      set.delete(subscription);
      if (set.size === 0) this.channels.delete(channel);
    };
  }

  /** @internal */
  hold(name: string, owner: string, ttlMs: number): boolean {
    const lease = this.leases.get(name);
    // Free, lapsed, or already this owner's: taken (or renewed) for another ttl.
    if (lease && lease.owner !== owner && lease.until > this.now()) return false;
    this.leases.set(name, { owner, until: this.now() + ttlMs });
    return true;
  }

  /** @internal */
  release(name: string, owner: string): void {
    if (this.leases.get(name)?.owner === owner) this.leases.delete(name);
  }

  /** @internal Forgets what was on its way to a transport that went down: a lost connection loses it too. */
  drop(transport: MemoryTransport): void {
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      if (this.pending[index]?.to.transport === transport) this.pending.splice(index, 1);
    }
  }

  // Delivers what is pending in one later turn, in order; what is sent meanwhile goes in the same run, after it.
  private schedule(): void {
    if (this.flushing) return;
    this.flushing = true;
    setImmediate(() => {
      this.flushing = false;
      while (this.pending.length > 0) {
        const delivery = this.pending.shift();
        if (!delivery?.to.transport.up) continue;
        try {
          delivery.to.listener(delivery.message);
        } catch (error) {
          // A listener that throws is a mistake in jukecord, told as an uncaught error (a test fails on it); the
          // messages after it are still delivered.
          process.nextTick(() => {
            throw error;
          });
        }
      }
    });
  }
}

export class MemoryTransport implements BusTransport {
  readonly kind = 'memory';
  private readonly broker: MemoryBroker;
  private connected = true;
  private closed = false;
  private readonly changes = new Set<(up: boolean) => void>();
  // The subscriptions this transport made, to drop them on close.
  private readonly ends = new Set<() => void>();

  constructor(broker: MemoryBroker) {
    this.broker = broker;
  }

  get up(): boolean {
    return this.connected && !this.closed;
  }

  async publish(channel: string, message: string): Promise<number> {
    this.usable();
    return this.broker.publish(channel, message);
  }

  async subscribe(channel: string, listener: (message: string) => void): Promise<() => Promise<void>> {
    if (this.closed) throw new Error('the bus is closed');
    const end = this.broker.subscribe(channel, { transport: this, listener });
    this.ends.add(end);
    return async () => {
      end();
      this.ends.delete(end);
    };
  }

  async hold(name: string, owner: string, ttlMs: number): Promise<boolean> {
    this.usable();
    return this.broker.hold(name, owner, ttlMs);
  }

  async release(name: string, owner: string): Promise<void> {
    this.usable();
    this.broker.release(name, owner);
  }

  onChange(listener: (up: boolean) => void): () => void {
    this.changes.add(listener);
    return () => this.changes.delete(listener);
  }

  async ping(): Promise<boolean> {
    return this.up;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const end of this.ends) end();
    this.ends.clear();
    this.broker.drop(this);
  }

  /** For tests: the connection is lost (false) or back (true), as a server going away and coming back looks. */
  setConnected(connected: boolean): void {
    if (this.connected === connected || this.closed) return;
    this.connected = connected;
    // What was on its way is lost with the connection.
    if (!connected) this.broker.drop(this);
    for (const listener of [...this.changes]) listener(connected);
  }

  // A call on a transport that is closed or cut off fails at once, as one on a lost connection does.
  private usable(): void {
    if (this.closed) throw new Error('the bus is closed');
    if (!this.connected) throw new Error('the bus is not connected');
  }
}
