/**
 * Who listens in browsers, when the browsers are spread over several edges.
 *
 * Each edge counts the browsers it carries (web/events.ts) and tells the bus: at once when they change (a moment
 * later, so a crowd pressing "listen" together is one report), and all of it every few seconds as a heartbeat. The
 * core adds the edges' counts up, because it pauses a server nobody hears (app/rest.ts) and counts the people whose
 * votes to skip count (app/votes.ts); every edge adds up the others' too, so its panels show everyone listening, not
 * only the browsers on that edge. An edge that stops reporting (it stopped, or it was cut off) no longer counts once a
 * few heartbeats are missed; one that stops cleanly says so and stops counting at once. Whoever starts listening (a
 * core or an edge that just started) asks, and every edge says everything at once instead of at its next heartbeat.
 */
import type { Logger } from '../log.ts';
import type { Listener } from '../web/events.ts';
import { decode, encode } from './codec.ts';
import type { BusNames, BusTransport } from './transport.ts';

/** How often an edge says everything again, and how long a report counts after the last one. */
export const PRESENCE_EVERY_MS = 5000;
export const PRESENCE_EXPIRES_MS = 15_000;
// How long an edge gathers changes before it reports them: a crowd starting together is one message.
const GATHER_MS = 100;

/** Who listens to one server in one edge's browsers. */
export interface EdgeListeners {
  /** How many browsers play along. */
  readonly count: number;
  /** The people among them as panels show them (the first twenty), each with the key the hub counts them by. */
  readonly shown: readonly { readonly person: string; readonly who: Listener }[];
  /** The people whose votes to skip count (a guest's do not), by the same keys. */
  readonly people: readonly string[];
}

const NOBODY: EdgeListeners = { count: 0, shown: [], people: [] };

export interface PresenceReporterOptions {
  readonly transport: BusTransport;
  readonly names: BusNames;
  /** This edge's name (see serviceId). */
  readonly edge: string;
  /** Who listens to a server in this edge's browsers now. */
  readonly listeners: (guildId: string) => EdgeListeners;
  /** The servers with anyone listening in this edge's browsers now. */
  readonly guilds: () => readonly string[];
  readonly log: Logger;
  readonly everyMs?: number;
}

/** An edge's side: says who listens in its browsers, on every change, as a heartbeat, and when asked. */
export class PresenceReporter {
  private readonly options: PresenceReporterOptions;
  // The servers whose listeners changed since the last report.
  private readonly dirty = new Set<string>();
  private gathering: NodeJS.Timeout | null = null;
  private readonly heartbeat: NodeJS.Timeout;
  private readonly offChange: () => void;
  private stopListening: (() => Promise<void>) | null = null;
  private stopped = false;
  private failedToldAt = Number.NEGATIVE_INFINITY;

  private constructor(options: PresenceReporterOptions) {
    this.options = options;
    this.heartbeat = setInterval(() => this.reportAll(), options.everyMs ?? PRESENCE_EVERY_MS);
    this.heartbeat.unref();
    // Back after the bus was down: everything at once, since what was said meanwhile is lost.
    this.offChange = options.transport.onChange((up) => {
      if (up) this.reportAll();
    });
  }

  /** Starts reporting: everything at once, then on every change, at every heartbeat and whenever someone asks. */
  static async start(options: PresenceReporterOptions): Promise<PresenceReporter> {
    const reporter = new PresenceReporter(options);
    reporter.stopListening = await options.transport.subscribe(options.names.presence, (text) => {
      const read = decode(text);
      // Someone just started listening (a core, another edge): it hears everything now, not at the next heartbeat.
      if (read.ok && read.message.type === 'ask') reporter.reportAll();
    });
    reporter.reportAll();
    return reporter;
  }

  /** Who listens to a server here changed: reported in a moment, with whatever else changes meanwhile. */
  changed(guildId: string): void {
    if (this.stopped) return;
    this.dirty.add(guildId);
    if (this.gathering) return;
    this.gathering = setTimeout(() => {
      this.gathering = null;
      const guilds: Record<string, EdgeListeners> = {};
      for (const guild of this.dirty) guilds[guild] = this.options.listeners(guild);
      this.dirty.clear();
      this.send({ type: 'listeners', from: this.options.edge, full: false, guilds });
    }, GATHER_MS);
    this.gathering.unref();
  }

  /** Stops reporting and tells the others this edge counts no more (it is stopping). */
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.heartbeat);
    if (this.gathering) clearTimeout(this.gathering);
    this.offChange();
    await this.stopListening?.();
    this.stopListening = null;
    try {
      await this.options.transport.publish(
        this.options.names.presence,
        encode({ type: 'gone', from: this.options.edge }),
      );
    } catch {
      // The bus is down: the others stop counting this edge when its reports lapse.
    }
  }

  // Everything this edge has: every server with anyone listening (a server not named has nobody here).
  private reportAll(): void {
    if (this.stopped) return;
    const guilds: Record<string, EdgeListeners> = {};
    for (const guild of this.options.guilds()) {
      const listeners = this.options.listeners(guild);
      if (listeners.count > 0) guilds[guild] = listeners;
    }
    this.send({ type: 'listeners', from: this.options.edge, full: true, guilds });
  }

  private send(message: Record<string, unknown>): void {
    this.options.transport.publish(this.options.names.presence, encode(message)).catch((error: unknown) => {
      // Down for now: the next heartbeat after it is back says everything.
      if (Date.now() - this.failedToldAt < 60_000) return;
      this.failedToldAt = Date.now();
      this.options.log.debug('could not report who listens here', { error });
    });
  }
}

export interface PresenceOptions {
  readonly transport: BusTransport;
  readonly names: BusNames;
  /** Hears that who listens to a server may have changed (a sum, a person, a name shown). */
  readonly changed: (guildId: string) => void;
  /** This edge's own name, whose reports are left out (it counts its own browsers itself); none for the core. */
  readonly self?: string;
  readonly log: Logger;
  readonly expiresMs?: number;
  readonly now?: () => number;
}

// One edge's last word: when it came, and who listens there by server.
interface Reported {
  at: number;
  guilds: Map<string, EdgeListeners>;
}

/** Who listens in the browsers of every other edge, added up, from their reports. */
export class Presence {
  private readonly options: PresenceOptions;
  private readonly now: () => number;
  private readonly edges = new Map<string, Reported>();
  private readonly sweeper: NodeJS.Timeout;
  private readonly offChange: () => void;
  private stopListening: (() => Promise<void>) | null = null;
  // The servers whose listeners changed while it was starting: a report can come with the subscription's own answer,
  // before whoever started this has it in hand; they are told once it has.
  private held: Set<string> | null = new Set();

  private constructor(options: PresenceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    const expires = options.expiresMs ?? PRESENCE_EXPIRES_MS;
    // An edge whose reports stopped coming no longer counts (it stopped, or it was cut off from the bus).
    this.sweeper = setInterval(() => this.sweep(expires), Math.min(1000, expires / 3));
    this.sweeper.unref();
    // Back after this connection was down: the reports sent meanwhile were lost, so everyone is asked again.
    this.offChange = options.transport.onChange((up) => {
      if (up) this.ask();
    });
  }

  static async start(options: PresenceOptions): Promise<Presence> {
    const presence = new Presence(options);
    presence.stopListening = await options.transport.subscribe(options.names.presence, (text) => presence.heard(text));
    // Every edge says everything now, so this one does not count nobody until their next heartbeats.
    presence.ask();
    // What changed meanwhile is told a turn later, once the caller holds what this returns.
    setImmediate(() => {
      const held = presence.held ?? new Set<string>();
      presence.held = null;
      for (const guild of held) presence.options.changed(guild);
    });
    return presence;
  }

  /** Asks every edge for everything at once (after starting, and after the bus was down). */
  ask(): void {
    this.options.transport.publish(this.options.names.presence, encode({ type: 'ask' })).catch(() => {
      // The bus is down: the heartbeats after it is back say everything.
    });
  }

  /** How many browsers play along to a server, on every edge counted. */
  count(guildId: string): number {
    let count = 0;
    for (const edge of this.edges.values()) count += edge.guilds.get(guildId)?.count ?? 0;
    return count;
  }

  /** The people whose votes to skip count in a server, each once, on every edge counted. */
  people(guildId: string): string[] {
    const people = new Set<string>();
    for (const edge of this.edges.values())
      for (const person of edge.guilds.get(guildId)?.people ?? []) people.add(person);
    return [...people];
  }

  /** The people listening to a server as panels show them, each once, the first twenty. */
  shown(guildId: string, most = 20): { person: string; who: Listener }[] {
    const shown = new Map<string, Listener>();
    for (const edge of this.edges.values()) {
      for (const entry of edge.guilds.get(guildId)?.shown ?? []) {
        if (shown.size >= most) break;
        if (!shown.has(entry.person)) shown.set(entry.person, entry.who);
      }
    }
    return [...shown].map(([person, who]) => ({ person, who }));
  }

  /** How many edges report now. */
  get edgeCount(): number {
    return this.edges.size;
  }

  async stop(): Promise<void> {
    clearInterval(this.sweeper);
    this.offChange();
    await this.stopListening?.();
    this.stopListening = null;
  }

  private heard(text: string): void {
    const read = decode(text);
    if (!read.ok) return;
    const { message } = read;
    const from = message.from;
    if (typeof from !== 'string' || from === this.options.self) return;
    if (message.type === 'gone') {
      const gone = this.edges.get(from);
      this.edges.delete(from);
      for (const guild of gone?.guilds.keys() ?? []) this.tell(guild);
      return;
    }
    if (message.type !== 'listeners' || typeof message.guilds !== 'object' || message.guilds === null) return;
    const before = this.edges.get(from);
    const edge: Reported = before ?? { at: this.now(), guilds: new Map() };
    edge.at = this.now();
    this.edges.set(from, edge);
    const told = new Map<string, EdgeListeners>();
    for (const [guild, value] of Object.entries(message.guilds as Record<string, unknown>))
      told.set(guild, listenersOf(value));
    // A full report names every server with anyone listening there: the ones it leaves out have nobody now.
    const touched = new Set(told.keys());
    if (message.full === true) for (const guild of edge.guilds.keys()) touched.add(guild);
    for (const guild of touched) {
      const now = told.get(guild) ?? NOBODY;
      const was = edge.guilds.get(guild) ?? NOBODY;
      if (now.count > 0) edge.guilds.set(guild, now);
      else edge.guilds.delete(guild);
      // Told only when something counted or shown is different: the heartbeat's repeats are not changes.
      if (!same(was, now)) this.tell(guild);
    }
  }

  // Lets go of the edges whose last report is older than the expiry.
  private sweep(expires: number): void {
    const now = this.now();
    for (const [name, edge] of this.edges) {
      if (now - edge.at <= expires) continue;
      this.edges.delete(name);
      this.options.log.info('an edge stopped reporting who listens there; its browsers no longer count', {
        edge: name,
      });
      for (const guild of edge.guilds.keys()) this.tell(guild);
    }
  }

  // Tells that who listens to a server changed: at once, or once started (see held).
  private tell(guildId: string): void {
    if (this.held) this.held.add(guildId);
    else this.options.changed(guildId);
  }
}

// A report's entry as plain values, whatever the message held.
function listenersOf(value: unknown): EdgeListeners {
  const entry = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const count = typeof entry.count === 'number' && entry.count > 0 ? Math.floor(entry.count) : 0;
  const shown = Array.isArray(entry.shown)
    ? entry.shown.filter(
        (item): item is { person: string; who: Listener } =>
          typeof item === 'object' && item !== null && typeof (item as { person?: unknown }).person === 'string',
      )
    : [];
  const people = Array.isArray(entry.people)
    ? entry.people.filter((item): item is string => typeof item === 'string')
    : [];
  return { count, shown, people };
}

// Whether two reports of one server say the same.
function same(a: EdgeListeners, b: EdgeListeners): boolean {
  return a.count === b.count && JSON.stringify([a.shown, a.people]) === JSON.stringify([b.shown, b.people]);
}
