/**
 * The core's heartbeat, and its lease on the bus.
 *
 * Exactly one core may run: two would both take every command (each add made twice) and both log in to Discord with
 * one token. So a core first takes a lease on the bus, before it touches anything (the players, Discord), renews it
 * while it runs and gives it back last when it stops, once it has left Discord; a second core waits until the lease
 * is free (the first one stopped, or crashed and its lease ran out). A core that finds its lease taken by another
 * stops, and so does one that could not renew it for most of its time (the bus out of reach, or a connection gone
 * silent): by the time the lease runs out on the server, and another core may take it, this one has stepped down.
 * Its heartbeats begin once it answers commands (announce), so an edge that hears a core can use it.
 *
 * While it runs, the core says so every second, with which instance it is (a restarted core is another one: its
 * players and versions start afresh), how many times its bus came back (what it sent meanwhile was lost) and the
 * facts the edges show without asking (whether Discord is set up and connected, the bot's account, whether the core
 * has fallen behind). An edge that has heard nothing for a few seconds takes the core for lost; one that hears
 * another instance takes it for replaced, and one that hears the bus came back for the core takes it for resumed
 * (see roles/edge.ts).
 */
import type { Logger } from '../log.ts';
import { decode, encode } from './codec.ts';
import type { BusNames, BusTransport } from './transport.ts';

/**
 * How often the core says it runs, how long an edge waits before it takes it for lost, how long a lease lasts, and
 * how long a core goes on without renewing it before it steps down (the rest of the lease is its time to leave
 * Discord before another core may take it).
 */
export const BEAT_EVERY_MS = 1000;
export const CORE_LOST_AFTER_MS = 5000;
export const LEASE_MS = 20_000;
export const RENEW_DEADLINE_MS = 15_000;

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
  /** Heard when this core can no longer be sure it holds the lease (another took it, or it went unrenewed): it stops. */
  readonly lost: () => void;
  readonly everyMs?: number;
  readonly leaseMs?: number;
  /** How long the lease may go unrenewed before this core steps down (default RENEW_DEADLINE_MS, within the lease). */
  readonly renewDeadlineMs?: number;
  /** The steady clock the renewals are timed on (tests set it). */
  readonly now?: () => number;
  /** How long to wait between tries while another core holds the lease. */
  readonly retryMs?: number;
  /** Stops the wait for the lease (the core is stopping before it got it). */
  readonly signal?: AbortSignal;
}

/** The core's side: takes the lease and renews it until stopped, and beats once it is announced. */
export class CoreBeat {
  private readonly options: CoreBeatOptions;
  private readonly timer: NodeJS.Timeout;
  private readonly startedAt = Date.now();
  private readonly now: () => number;
  private readonly offChange: () => void;
  // Given back (or stepped down): nothing more is renewed or said.
  private stopped = false;
  // Said goodbye: no more heartbeats, the lease still renewed until it is given back.
  private quiet = false;
  private announced = false;
  private ticks = 0;
  private renewing = false;
  // When the lease was last held for sure (taken or renewed), on the steady clock.
  private heldAt: number;
  // How many times the bus came back after it was down: what this core sent meanwhile was lost, and the edges ask
  // again for what they show when they hear the number change.
  private epoch = 0;

  private constructor(options: CoreBeatOptions) {
    this.options = options;
    this.now = options.now ?? (() => performance.now());
    this.heldAt = this.now();
    this.timer = setInterval(() => this.tick(), options.everyMs ?? BEAT_EVERY_MS);
    this.timer.unref();
    let wasDown = false;
    this.offChange = options.transport.onChange((up) => {
      if (!up) {
        wasDown = true;
        return;
      }
      if (!wasDown) return;
      wasDown = false;
      this.epoch += 1;
      // At once, so the edges hear it before the next second's beat.
      if (this.announced) this.beat();
    });
  }

  /** Waits for the lease (as long as another core holds it), then keeps it; beats begin with announce(). */
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

  /** The core answers commands now: its heartbeats begin, and the edges take it for there. */
  announce(): void {
    this.announced = true;
    this.beat();
  }

  /**
   * Stops beating and says goodbye: the edges stop waiting for this core at once. The lease is still renewed, until it
   * is given back (release), once the core has left Discord.
   */
  async goodbye(): Promise<void> {
    if (this.quiet || this.stopped) return;
    this.quiet = true;
    const { transport, names, instance } = this.options;
    try {
      await transport.publish(names.beat, encode({ type: 'bye', instance }));
    } catch {
      // The bus is down: the edges take the core for lost after a few seconds.
    }
  }

  /** Gives the lease back: another core may take it at once. Nothing more is renewed or said. */
  async release(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.quiet = true;
    clearInterval(this.timer);
    this.offChange();
    const { transport, names, instance } = this.options;
    try {
      await transport.release(names.coreLease, instance);
    } catch {
      // The bus is down: the lease runs out by itself.
    }
  }

  /** Says goodbye and gives the lease back at once (a core that had nothing to leave first). */
  async stop(): Promise<void> {
    await this.goodbye();
    await this.release();
  }

  // Every second: a heartbeat once announced, the lease renewed every few seconds well within its time, and a step
  // down when it has gone unrenewed for most of it.
  private tick(): void {
    if (this.stopped) return;
    if (this.announced && !this.quiet) this.beat();
    this.ticks += 1;
    const ttl = this.options.leaseMs ?? LEASE_MS;
    const every = Math.max(1, Math.floor(ttl / 5 / (this.options.everyMs ?? BEAT_EVERY_MS)));
    if (this.ticks % every === 0) void this.renew(ttl);
    const deadline = this.options.renewDeadlineMs ?? Math.min(RENEW_DEADLINE_MS, (ttl * 2) / 3);
    if (this.now() - this.heldAt > deadline) {
      this.stopped = true;
      clearInterval(this.timer);
      this.offChange();
      this.options.log.error(
        'the core could not renew its lease on the bus in time; it steps down, as another core may take the lease now',
        { seconds: Math.round(deadline / 1000) },
      );
      this.options.lost();
    }
  }

  private beat(): void {
    if (this.stopped || this.quiet) return;
    const { transport, names, instance, version } = this.options;
    const message = encode({
      type: 'beat',
      instance,
      version,
      startedAt: this.startedAt,
      epoch: this.epoch,
      facts: this.options.facts(),
    });
    transport.publish(names.beat, message).catch(() => {
      // The bus is down: the edges notice the silence; the beats go on when it is back.
    });
  }

  // Renews the lease; another core holding it now means this one must stop (it lost the bus while it was down).
  private async renew(ttl: number): Promise<void> {
    if (this.renewing) return;
    this.renewing = true;
    // Timed from before the question: the server's lease runs from when it renewed, at or after this moment.
    const asked = this.now();
    try {
      const held = await this.options.transport.hold(this.options.names.coreLease, this.options.instance, ttl);
      if (this.stopped) return;
      if (held) {
        this.heldAt = asked;
        return;
      }
      this.stopped = true;
      clearInterval(this.timer);
      this.offChange();
      this.options.log.error('another core took the lease on the bus; this one stops');
      this.options.lost();
    } catch {
      // Down for a moment: renewed at the next try (the lease outlasts a few missed ones; see tick).
    } finally {
      this.renewing = false;
    }
  }
}

/**
 * What an edge hears about the core: found (the first time it hears one), lost (silent, or said goodbye), back (one is
 * heard again after it was lost), replaced (another instance took over from the one heard: a restart), resumed (the
 * same one, whose bus came back: what it sent meanwhile was lost).
 */
export type CoreChange = 'found' | 'lost' | 'back' | 'replaced' | 'resumed';

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
  private current: { instance: string; at: number; facts: CoreFacts; version: string; epoch: number } | null = null;
  // Whether a core was heard since this edge started (a core heard after it was lost is back, not found).
  private everSeen = false;
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
    const epoch = typeof message.epoch === 'number' ? message.epoch : 0;
    const before = this.current;
    this.current = { instance: message.instance, at: this.now(), facts, version, epoch };
    if (version !== this.options.version && this.versionTold !== version) {
      this.versionTold = version;
      this.options.log.warn('the core runs another version of jukecord than this edge', {
        core: version,
        edge: this.options.version,
      });
    }
    if (before === null) {
      const back = this.everSeen;
      this.everSeen = true;
      this.options.log.info(back ? 'the core is back' : 'the core is here', { core: message.instance });
      this.options.changed(back ? 'back' : 'found');
    } else if (before.instance !== message.instance) {
      this.options.log.info('another core runs now (the core restarted)', { core: message.instance });
      this.options.changed('replaced');
    } else if (before.epoch !== epoch) {
      this.options.log.info("the core's bus came back; what it sent meanwhile was lost", { core: message.instance });
      this.options.changed('resumed');
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
