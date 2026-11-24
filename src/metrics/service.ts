/**
 * What jukecord is and what it does now: its version and backends, the servers' players and queues, and Discord (the
 * gateway and the voice connections). Read when the metrics are written, from the parts that know.
 */
import type { Players } from '../core/players.ts';
import type { QueueService } from '../core/queue.ts';
import type { Metrics } from './registry.ts';

/** What `jukecord_info` says: the version, the role this process plays, and the backends it uses. */
export interface ServiceInfo {
  readonly version: string;
  /** all (one process), core or edge. */
  readonly role: string;
  /** sqlite, postgres or mysql. */
  readonly database: string;
  /** in-process or redis. */
  readonly bus: string;
  /** The shared cache: memory or redis. */
  readonly cache: string;
}

/** Declares `jukecord_info`, a series of 1 whose labels say what runs. */
export function describeService(metrics: Metrics, info: ServiceInfo): void {
  metrics
    .gauge('jukecord_info', 'The running jukecord: its version, its role, and the backends it uses.', [
      'version',
      'role',
      'database',
      'bus',
      'cache',
    ])
    .set(1, { ...info });
}

// The states a player can be in, each named in the metrics even when no player is in it.
const STATUSES = ['idle', 'loading', 'playing', 'paused'] as const;

// How long a queue's length read from the database is trusted while its version stays the same: the version moves
// with every change made through the queue service, and this bounds what a change made around it could leave stale.
const QUEUE_LENGTH_TRUSTED_MS = 60_000;

/**
 * Declares the players by state and the queues' lengths (in all, and the longest). A queue's length takes a question
 * to the database, so it is asked before the metrics are written, and only of a queue that changed since it was last
 * asked (its version says so) or a minute ago.
 */
export function playerMetrics(metrics: Metrics, source: { players: Players; queue: QueueService }): void {
  const players = metrics.gauge('jukecord_players', 'Players by state: idle, loading, playing, paused.', ['status']);
  const queued = metrics.gauge('jukecord_queue_tracks', 'Tracks waiting in all queues.');
  const longest = metrics.gauge('jukecord_queue_longest_tracks', 'Tracks waiting in the longest queue.');
  // Each server's queue length, the version it was read at, and when.
  const lengths = new Map<string, { version: number; length: number; at: number }>();
  metrics.collect(() => {
    const counts = new Map<string, number>(STATUSES.map((status) => [status, 0]));
    for (const player of source.players.all()) {
      const status = player.snapshot().status;
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }
    for (const [status, count] of counts) players.set(count, { status });
  });
  metrics.gather(async () => {
    let total = 0;
    let most = 0;
    const now = performance.now();
    const present = new Set<string>();
    for (const player of source.players.all()) {
      const guildId = player.guildId;
      present.add(guildId);
      const version = source.queue.version(guildId);
      let known = lengths.get(guildId);
      if (!known || known.version !== version || now - known.at > QUEUE_LENGTH_TRUSTED_MS) {
        known = { version, length: await source.queue.size(guildId), at: now };
        lengths.set(guildId, known);
      }
      total += known.length;
      most = Math.max(most, known.length);
    }
    // The servers that have no player any more are let go.
    for (const guildId of lengths.keys()) if (!present.has(guildId)) lengths.delete(guildId);
    queued.set(total);
    longest.set(most);
  });
}

/** The gateway's states, as discord.js names them, each named in the metrics (1 for the one it is in). */
export const GATEWAY_STATES = [
  'ready',
  'connecting',
  'reconnecting',
  'idle',
  'nearly',
  'disconnected',
  'waiting-for-guilds',
  'identifying',
  'resuming',
] as const;

/** A voice connection's states, as @discordjs/voice names them. */
export const VOICE_STATES = ['signalling', 'connecting', 'ready', 'disconnected', 'destroyed'] as const;

/** Where Discord's numbers come from: the bot, when there is one. */
export interface DiscordSource {
  /** Whether the bot is logged in and receiving events (false without a bot: browser-only). */
  connected(): boolean;
  /** The gateway's state and its last heartbeat's round trip in milliseconds (-1 before one); null without a bot. */
  gateway(): { readonly state: (typeof GATEWAY_STATES)[number]; readonly pingMs: number } | null;
  /** How many servers the bot is in. */
  guilds(): number;
  /** The bot's voice connections, by state. */
  voice(): ReadonlyMap<string, number>;
}

/**
 * Declares Discord's families. Without a bot only `jukecord_discord_connected` (0) is written, as 0.3 did: the gateway's
 * series are absent, so an alert on them never fires for a jukecord that runs browser-only.
 */
export function discordMetrics(metrics: Metrics, source: DiscordSource): void {
  const connected = metrics.gauge('jukecord_discord_connected', 'Whether the bot is connected to Discord.');
  const state = metrics.gauge(
    'jukecord_discord_gateway_state',
    "The Discord gateway's state: 1 for the state it is in, 0 for the others (absent without a bot).",
    ['state'],
  );
  const latency = metrics.gauge(
    'jukecord_discord_gateway_latency_seconds',
    "The round trip of the Discord gateway's last heartbeat.",
  );
  const guilds = metrics.gauge('jukecord_discord_guilds', 'Discord servers the bot is in.');
  const voice = metrics.gauge('jukecord_voice_connections', "The bot's voice connections, by state.", ['state']);
  metrics.collect(() => {
    connected.set(source.connected() ? 1 : 0);
    const gateway = source.gateway();
    if (!gateway) return;
    for (const name of GATEWAY_STATES) state.set(name === gateway.state ? 1 : 0, { state: name });
    // No heartbeat yet: no round trip to tell, rather than a made-up one.
    if (gateway.pingMs >= 0) latency.set(gateway.pingMs / 1000);
    guilds.set(source.guilds());
    const states = source.voice();
    for (const name of VOICE_STATES) voice.set(states.get(name) ?? 0, { state: name });
  });
}
