/**
 * The events of the core, heard by every edge: the core's bus (core/bus.ts) carried over the network bus.
 *
 * The core's players, queues, voice side and actions announce their changes on its own bus as they do in one process;
 * the relay sends each of them on, in the order they were announced, and every edge's relay announces them on that
 * edge's own bus, where its live updates (web/events.ts) hear them exactly as they hear them in one process. The order
 * holds on the way: one connection sends everything the core says, and the server hands it on in the order it came.
 *
 * Besides the events, the live connections to end travel this way: a logout on one edge ends that session's
 * connections on every edge, and a revoked listening link ends its guests' wherever they are.
 *
 * What the bus loses while it is down is lost; an edge that was cut off ends its live connections when it is back
 * (see roles/edge.ts), so every panel asks for the whole state again.
 */
import type { Bus, BusEvents } from '../core/bus.ts';
import type { Logger } from '../log.ts';
import { type Counter, type Metrics, NO_METRICS } from '../metrics/registry.ts';
import { decode, encode } from './codec.ts';
import { busEvents } from './metrics.ts';
import type { BusNames, BusTransport } from './transport.ts';

/** The core's events that edges need: what their panels show. The rest are for the core's own parts. */
export const RELAYED = ['player', 'queue', 'voice', 'votes', 'sound'] as const satisfies readonly (keyof BusEvents)[];

type Relayed = (typeof RELAYED)[number];

/** Live connections to end on every edge: one session's (a logout), or a listening link's guests (a revoke). */
export type Ending =
  | { readonly what: 'session'; readonly sessionHash: string; readonly reason: string }
  | { readonly what: 'guests'; readonly linkId: number; readonly reason: string };

export interface RelayOptions {
  readonly transport: BusTransport;
  readonly names: BusNames;
  readonly log: Logger;
  readonly metrics?: Metrics;
}

// Counts what went out, what was lost and what was heard, by event (bus/metrics.ts).
function counter(metrics: Metrics | undefined): Counter {
  return busEvents(metrics ?? NO_METRICS);
}

/**
 * The core's side: every event of its own bus that edges need goes out on the network bus. An edge makes one without
 * a bus (null), for the endings it sends alone: its own bus carries the core's events, which must not go out again.
 */
export class EventSender {
  private readonly options: RelayOptions;
  private readonly events: Counter;
  private readonly off: (() => void)[] = [];
  // Events lost to a bus that is down, told at most once a minute.
  private lost = 0;
  private lostToldAt = Number.NEGATIVE_INFINITY;

  constructor(bus: Bus | null, options: RelayOptions) {
    this.options = options;
    this.events = counter(options.metrics);
    if (!bus) return;
    for (const name of RELAYED) {
      const listener = (payload: BusEvents[Relayed][0]) => this.send({ type: 'event', name, payload }, name);
      bus.on(name, listener);
      this.off.push(() => bus.off(name, listener));
    }
  }

  /** Ends live connections on every edge. */
  end(ending: Ending): void {
    this.send({ type: 'end', ...ending }, 'end');
  }

  /** Stops sending (the core is stopping). */
  stop(): void {
    for (const off of this.off.splice(0)) off();
  }

  // Sends one message; a bus that is down loses it, which is told in the log.
  private send(message: Record<string, unknown>, name: string): void {
    this.options.transport.publish(this.options.names.events, encode(message)).then(
      () => this.events.inc({ event: name, outcome: 'sent' }),
      () => {
        this.events.inc({ event: name, outcome: 'lost' });
        this.lost += 1;
        if (Date.now() - this.lostToldAt < 60_000) return;
        this.options.log.warn('events could not go out: the bus is down', { count: this.lost });
        this.lost = 0;
        this.lostToldAt = Date.now();
      },
    );
  }
}

/** An edge's side: what the core announces is announced on this edge's own bus; endings are handed to `ended`. */
export class EventReceiver {
  private readonly bus: Bus;
  private readonly options: RelayOptions & { readonly ended: (ending: Ending) => void };
  private readonly events: Counter;
  private stopListening: (() => Promise<void>) | null = null;
  private unreadToldAt = Number.NEGATIVE_INFINITY;

  private constructor(bus: Bus, options: RelayOptions & { readonly ended: (ending: Ending) => void }) {
    this.bus = bus;
    this.options = options;
    this.events = counter(options.metrics);
  }

  static async start(bus: Bus, options: RelayOptions & { ended: (ending: Ending) => void }): Promise<EventReceiver> {
    const receiver = new EventReceiver(bus, options);
    receiver.stopListening = await options.transport.subscribe(options.names.events, (text) => receiver.heard(text));
    return receiver;
  }

  async stop(): Promise<void> {
    await this.stopListening?.();
    this.stopListening = null;
  }

  private heard(text: string): void {
    const read = decode(text);
    if (!read.ok) {
      if (Date.now() - this.unreadToldAt >= 60_000) {
        this.unreadToldAt = Date.now();
        this.options.log.warn('an event on the bus could not be read', { why: read.why });
      }
      return;
    }
    const { message } = read;
    if (message.type === 'end') {
      if (message.what === 'session' && typeof message.sessionHash === 'string') {
        this.options.ended({ what: 'session', sessionHash: message.sessionHash, reason: String(message.reason) });
      } else if (message.what === 'guests' && typeof message.linkId === 'number') {
        this.options.ended({ what: 'guests', linkId: message.linkId, reason: String(message.reason) });
      }
      return;
    }
    const name = message.name as Relayed;
    const payload = message.payload as { guildId?: unknown } | undefined;
    // Only the events edges take, each about a server.
    if (message.type !== 'event' || !RELAYED.includes(name) || typeof payload?.guildId !== 'string') return;
    this.events.inc({ event: name, outcome: 'received' });
    // Announced as the core announced it: the payload is the same plain data (a snapshot, a version, an ID).
    (this.bus.emit as (event: Relayed, value: unknown) => boolean)(name, payload);
  }
}
