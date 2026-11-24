/**
 * The core's heartbeat, and its lease on the bus.
 *
 * Exactly one core may run: two would both take every command (each add made twice) and both log in to Discord with
 * one token. So a core first takes a lease on the bus, renews it while it runs and gives it back when it stops; a
 * second core waits until the lease is free (the first one stopped, or crashed and its lease ran out), and a core that
 * finds its lease taken by another stops.
 *
 * While it runs, the core says so every second, with which instance it is (a restarted core is another one: its
 * players and versions start afresh) and the facts the edges show without asking (whether Discord is set up and
 * connected, the bot's account, whether the core has fallen behind). An edge that has heard nothing for a few
 * seconds takes the core for lost; one that hears another instance takes it for replaced (see roles/edge.ts).
 */
import type { Logger } from '../log.ts';
import { decode, encode } from './codec.ts';
import type { BusNames, BusTransport } from './transport.ts';

/** How often the core says it runs, how long an edge waits before it takes it for lost, and how long a lease lasts. */
export const BEAT_EVERY_MS = 1000;
export const CORE_LOST_AFTER_MS = 5000;
export const LEASE_MS = 10_000;

/** What the core tells the edges with every heartbeat. */
export interface CoreFacts {
  /** Whether the bot is set up at all (a token); browser-only mode otherwise. */
  readonly discordMode: boolean;
  /** Whether the bot is connected to Discord now. */
  readonly discordReady: boolean;
  /** The bot's own account, for the panel's header; null before it has logged in. */
  readonly self: { readonly id: string; readonly name: string; readonly avatar: string | null } | null;
  /** Whether the core has fallen behind and work that can wait should be turned away (see web/limits.ts). */
  readonly behind: boolean;
}

export interface CoreBeatOptions {
  readonly transport: BusTransport;
  readonly names: BusNames;
  /** This core's run (see serviceId). */
  readonly instance: string;
  /** jukecord's version, which the edges compare with their own. */
  readonly version: string;
  readonly facts: () => CoreFacts;
  readonly log: Logger;
  /** Heard when another core took the lease: this one must stop. */
  readonly lost: () => void;
  readonly everyMs?: number;
  readonly leaseMs?: number;
  /** How long to wait between tries while another core holds the lease. */
  readonly retryMs?: number;
  /** Stops the wait for the lease (the core is stopping before it got it). */
  readonly signal?: AbortSignal;
}

/** The core's side: takes the lease, then beats and renews it until stopped. */
export class CoreBeat {
  private readonly options: CoreBeatOptions;
  private readonly timer: NodeJS.Timeout;
  private readonly startedAt = Date.now();
  private stopped = false;
  private beats = 0;
  private renewing = false;

  private constructor(options: CoreBeatOptions) {
    this.options = options;
    this.timer = setInterval(() => this.beat(), options.everyMs ?? BEAT_EVERY_MS);
    this.timer.unref();
    this.beat();
  }

  /** Waits for the lease (as long as another core holds it), then starts beating. */
  static async start(options: CoreBeatOptions): Promise<CoreBeat> {
    const ttl = options.leaseMs ?? LEASE_MS;
    let toldAt = Number.NEGATIVE_INFINITY;
    for (;;) {
      options.signal?.throwIfAborted();
      let held = false;
      try {
        held = await options.transport.hold(options.names.coreLease, options.instance, ttl);
      } catch (error) {
        // The bus is down for a moment: asked again below.
        options.log.debug('could not ask for the core lease', { error });
      }
      if (held) break;
      // Said when the wait begins and every half minute after.
      if (Date.now() - toldAt >= 30_000) {
        toldAt = Date.now();
        options.log.warn('another core runs on this bus; this one waits until it stops (only one core may run)');
      }
      await new Promise((resolve) => setTimeout(resolve, options.retryMs ?? 2000).unref());
    }
    options.log.info('this is the core: it holds the lease on the bus');
    return new CoreBeat(options);
  }

  /** Stops beating, says goodbye (the edges stop waiting at once) and gives the lease back. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    const { transport, names, instance } = this.options;
    try {
      await transport.publish(names.beat, encode({ type: 'bye', instance }));
      await transport.release(names.coreLease, instance);
    } catch {
      // The bus is down: the edges take the core for lost after a few seconds, and the lease runs out by itself.
    }
  }

  private beat(): void {
    if (this.stopped) return;
    const { transport, names, instance, version } = this.options;
    const message = encode({ type: 'beat', instance, version, startedAt: this.startedAt, facts: this.options.facts() });
    transport.publish(names.beat, message).catch(() => {
      // The bus is down: the edges notice the silence; the beats go on when it is back.
    });
    // The lease is renewed every few beats, well within its time.
    this.beats += 1;
    const ttl = this.options.leaseMs ?? LEASE_MS;
    const every = Math.max(1, Math.floor(ttl / 3 / (this.options.everyMs ?? BEAT_EVERY_MS)));
    if (this.beats % every === 0) void this.renew(ttl);
  }

  // Renews the lease; another core holding it now means this one must stop (it lost the bus while it was down).
  private async renew(ttl: number): Promise<void> {
    if (this.renewing) return;
    this.renewing = true;
    try {
      const held = await this.options.transport.hold(this.options.names.coreLease, this.options.instance, ttl);
      if (!held && !this.stopped) {
        this.options.log.error('another core took the lease on the bus; this one stops');
        this.options.lost();
      }
    } catch {
      // Down for a moment: renewed at the next try (the lease outlasts a few missed ones).
    } finally {
      this.renewing = false;
    }
  }
}

/** What an edge hears about the core: found (the first time), lost (silent, or said goodbye), replaced (restarted). */
export type CoreChange = 'found' | 'lost' | 'replaced';

export interface CoreWatchOptions {
  readonly transport: BusTransport;
  readonly names: BusNames;
  /** This edge's version, to say when the core runs another. */
  readonly version: string;
  readonly changed: (change: CoreChange) => void;
  readonly log: Logger;
  readonly lostAfterMs?: number;
  readonly now?: () => number;
}

/** An edge's side: whether the core runs, which one, and its facts. */
export class CoreWatch {
  private readonly options: CoreWatchOptions;
  private readonly now: () => number;
  private readonly timer: NodeJS.Timeout;
  private current: { instance: string; at: number; facts: CoreFacts; version: string } | null = null;
  private stopListening: (() => Promise<void>) | null = null;
  private unreadToldAt = Number.NEGATIVE_INFINITY;
  private versionTold = '';

  private constructor(options: CoreWatchOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    const lostAfter = options.lostAfterMs ?? CORE_LOST_AFTER_MS;
    this.timer = setInterval(
      () => {
        if (this.current && this.now() - this.current.at > lostAfter) this.lose('it has said nothing for a while');
      },
      Math.min(1000, lostAfter / 2),
    );
    this.timer.unref();
  }

  static async start(options: CoreWatchOptions): Promise<CoreWatch> {
    const watch = new CoreWatch(options);
    watch.stopListening = await options.transport.subscribe(options.names.beat, (text) => watch.heard(text));
    return watch;
  }

  /** Whether the core's heartbeat came lately. */
  get seen(): boolean {
    return this.current !== null;
  }

  /** The core's facts from its last heartbeat, or null while no core is seen. */
  get facts(): CoreFacts | null {
    return this.current?.facts ?? null;
  }

  /** Which core runs (its instance), or null. */
  get instance(): string | null {
    return this.current?.instance ?? null;
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.stopListening?.();
    this.stopListening = null;
  }

  private heard(text: string): void {
    const read = decode(text);
    if (!read.ok) {
      // A core of another protocol is no core for this edge; said at most once a minute.
      if (Date.now() - this.unreadToldAt >= 60_000) {
        this.unreadToldAt = Date.now();
        this.options.log.error('the heartbeat on the bus could not be read', { why: read.why });
      }
      return;
    }
    const { message } = read;
    if (typeof message.instance !== 'string') return;
    if (message.type === 'bye') {
      if (this.current?.instance === message.instance) this.lose('it stopped');
      return;
    }
    if (message.type !== 'beat') return;
    const facts = factsOf(message.facts);
    const version = String(message.version ?? '');
    const before = this.current;
    this.current = { instance: message.instance, at: this.now(), facts, version };
    if (version !== this.options.version && this.versionTold !== version) {
      this.versionTold = version;
      this.options.log.warn('the core runs another version of jukecord than this edge', {
        core: version,
        edge: this.options.version,
      });
    }
    if (before === null) {
      this.options.log.info('the core is here', { core: message.instance });
      this.options.changed('found');
    } else if (before.instance !== message.instance) {
      this.options.log.info('another core runs now (the core restarted)', { core: message.instance });
      this.options.changed('replaced');
    }
  }

  private lose(why: string): void {
    if (!this.current) return;
    this.options.log.warn('the core is gone', { core: this.current.instance, why });
    this.current = null;
    this.options.changed('lost');
  }
}

// The facts as plain values, whatever a heartbeat held.
function factsOf(value: unknown): CoreFacts {
  const facts = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const self = facts.self as { id?: unknown; name?: unknown; avatar?: unknown } | null | undefined;
  return {
    discordMode: facts.discordMode === true,
    discordReady: facts.discordReady === true,
    self:
      self && typeof self.id === 'string' && typeof self.name === 'string'
        ? { id: self.id, name: self.name, avatar: typeof self.avatar === 'string' ? self.avatar : null }
        : null,
    behind: facts.behind === true,
  };
}
