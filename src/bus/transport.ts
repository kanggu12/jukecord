/**
 * The bus port: how the services of a split jukecord (one core, any number of edges) hear each other.
 *
 * It carries text on named channels to whoever listens at the moment it is sent (publish and subscribe, as Redis has
 * them): nothing waits for a listener who is not there, and nothing is kept. On it the rest of src/bus/ builds the
 * traffic jukecord needs: the events the core announces to every edge (relay.ts), the commands an edge asks of the
 * core, each with its answer (commands.ts), who listens in which edge's browsers (presence.ts), and the core's
 * heartbeat (beat.ts). A lease lets one core at a time hold the bus.
 *
 * One process (JUKECORD_ROLE=all) uses none of this: its events go through core/bus.ts in memory, as they always did.
 * The memory adapter (memory.ts) joins services inside one process, for tests; the Redis adapter (redis.ts) joins
 * processes through Redis or Valkey.
 */

/** Which adapter carries the messages, for the startup line, the health check and the metrics. */
export type BusKind = 'memory' | 'redis';

export interface BusTransport {
  readonly kind: BusKind;
  /** Sends a message on a channel to everyone listening now; resolves to how many heard it (0: nobody listens). */
  publish(channel: string, message: string): Promise<number>;
  /** Hears every message on a channel, in the order they were sent, until the function it gives is called. */
  subscribe(channel: string, listener: (message: string) => void): Promise<() => Promise<void>>;
  /**
   * Takes a lease for `owner`, or renews the one it holds: true while `owner` holds `name`, which lapses `ttlMs` after
   * the last renewal unless it is given back first; false while someone else holds it.
   */
  hold(name: string, owner: string, ttlMs: number): Promise<boolean>;
  /** Gives back a lease `owner` holds; one that someone else holds stays theirs. */
  release(name: string, owner: string): Promise<void>;
  /** Whether messages go both ways now. */
  readonly up: boolean;
  /**
   * Hears every change of `up`: false when the connection to the server is lost, true when it is back with every
   * subscription in place again. What was sent meanwhile is lost, so whoever listens must catch up then.
   */
  onChange(listener: (up: boolean) => void): () => void;
  /** Whether the server answers now (a round trip, for the readiness check). */
  ping(): Promise<boolean>;
  /** Lets go of the connections; calls after it fail. */
  close(): Promise<void>;
}

/** The names jukecord uses on a bus, each under the prefix that keeps several jukecords on one server apart. */
export interface BusNames {
  /** What the core announces to every edge: the events, and the live connections to end. */
  readonly events: string;
  /** What edges ask of the core: commands, and the cancelling of commands nobody waits for any more. */
  readonly commands: string;
  /** Where one edge (or any caller) hears the answers to its commands. */
  replies(caller: string): string;
  /** The core's heartbeat: that it runs, which instance it is, and the facts edges show. */
  readonly beat: string;
  /** Who listens in the browsers of each edge. */
  readonly presence: string;
  /** The lease that one core at a time holds. */
  readonly coreLease: string;
}

/** The names under a prefix ("jukecord" unless JUKECORD_KEY_PREFIX says otherwise). */
export function busNames(prefix: string): BusNames {
  return {
    events: `${prefix}:events`,
    commands: `${prefix}:commands`,
    replies: (caller) => `${prefix}:replies:${caller}`,
    beat: `${prefix}:beat`,
    presence: `${prefix}:presence`,
    coreLease: `${prefix}:lease:core`,
  };
}
