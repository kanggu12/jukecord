/**
 * The core of a split jukecord, beside what it shares with one process (src/main.ts builds the players, the media,
 * the actions and the bot either way): what its edges need of it.
 *
 * - Commands: every action the API runs, the access rules, and the host's jobs on the core's folder (a backup, the
 *   log, the self-check) answer edges over the bus (bus/commands.ts). An action's context comes from the edge as it is.
 * - Events: what its players, queues and voice side announce goes to every edge (bus/relay.ts), and the live
 *   connections a revoked listening link ends are ended on every edge.
 * - Who listens: the edges' reports, added up (bus/presence.ts), are what its rest and its votes to skip count, told
 *   on its own bus as one process's live updates tell it.
 * - Its internal port: the audio and the covers of its media cache, for edges with the shared secret (internal.ts).
 * - Its own port: health and numbers only (health.ts), with how many edges report among them.
 * - Its heartbeat: once all of that answers, the edges hear it runs (bus/beat.ts; the lease was taken before anything
 *   else started). Stopping says goodbye first; the lease is given back by whoever stops the core, last (main.ts).
 */
import type { Access } from '../app/access.ts';
import { ActionError, type Actions } from '../app/actions.ts';
import type { DoctorReport } from '../app/doctor.ts';
import type { Health } from '../app/health.ts';
import type { CoreBeat } from '../bus/beat.ts';
import { type CommandHandler, CommandServer } from '../bus/commands.ts';
import { reportingEdges } from '../bus/metrics.ts';
import { Presence } from '../bus/presence.ts';
import { EventSender } from '../bus/relay.ts';
import type { BusNames, BusTransport } from '../bus/transport.ts';
import type { Bus } from '../core/bus.ts';
import type { Logger } from '../log.ts';
import type { MediaCache } from '../media/cache.ts';
import type { MetricsRegistry } from '../metrics/registry.ts';
import { settingsCommands } from '../settings/bus.ts';
import type { HostSettings, ServiceInfo } from '../settings/service.ts';
import { VERSION } from '../version.ts';
import { WEB_ACTIONS, type WebAction } from '../web/core.ts';
import type { Files } from '../web/files.ts';
import type { LogQuery } from '../web/logs.ts';
import type { TurnedAway } from '../web/server.ts';
import { createHealthServer, type HealthServer } from './health.ts';
import { createInternalServer, type InternalServer } from './internal.ts';

/**
 * Where an action takes the signal that aborts it when its caller goes away (an edge's browser that left): the
 * arguments before it travel, and the core puts its own signal there.
 */
export const SIGNAL_AT: Partial<Record<WebAction, number>> = { add: 3, playNow: 2, search: 3, playlistImport: 3 };

export interface CoreServicesOptions {
  readonly transport: BusTransport;
  readonly names: BusNames;
  /** The core's lease and heartbeat, taken before anything else started; announced once everything here answers. */
  readonly beat: CoreBeat;
  /** The core's own bus, whose events go to the edges and which hears who listens there. */
  readonly bus: Bus;
  readonly actions: Actions;
  readonly access: Access;
  /** The media cache, whose folder the internal port serves the audio from. */
  readonly cache: MediaCache;
  /** The audio and the covers of the core's media cache (MediaFiles), for the internal port. */
  readonly files: Files;
  /** The host's jobs: a backup, the log, the self-check (with whether the edge asking lets people log in with Discord). */
  readonly backup: () => Promise<{ readonly file: string; readonly bytes: number }>;
  readonly logs: (query: LogQuery) => unknown;
  readonly doctor: (discordLogin: boolean) => Promise<DoctorReport>;
  /** Connections an edge turned away at a cap, which are jukecord's trouble, told to the alerts channels. */
  readonly turnedAway: (away: TurnedAway) => void;
  /** The core's parts, as one process checks them, for its own port's /readyz. */
  readonly health: Health;
  /** Whether the core has fallen behind (audio for edges waits then, as one process's does). */
  readonly behind: () => boolean;
  readonly host: string;
  /** The core's own port, for health and figures. */
  readonly port: number;
  /** The internal port for edges, and the secret they carry. */
  readonly internal: { readonly port: number; readonly secret: string };
  /** Every number of the core, for its own port's /metrics; the commands served and the edges are counted there too. */
  readonly registry: MetricsRegistry;
  /** The token that lets a scraper read /metrics from anywhere (JUKECORD_METRICS_TOKEN). */
  readonly metricsToken: string | null;
  /** The host's settings, which the core keeps and its edges' pages read and change by commands. */
  readonly settings?: HostSettings;
  /** This core's run, as its heartbeat names it. */
  readonly instance?: string;
  readonly log: Logger;
}

export interface CoreServices {
  /** Where the internal port and the core's own port listen ("http://host:port"). */
  readonly internalAddress: string;
  readonly healthAddress: string;
  /** Who listens in the edges' browsers, added up: how many browsers, and the people whose votes count. */
  readonly audience: { count(guildId: string): number; people(guildId: string): readonly string[] };
  /** Ends a revoked listening link's guests' live connections on every edge. */
  endGuests(linkId: number): void;
  /** The token a scraper of the core's /metrics shows from now on (JUKECORD_METRICS_TOKEN applies at once). */
  setMetricsToken(token: string | null): void;
  /** The core and each edge reporting, with their versions, starts and readiness (the settings' Services). */
  list(): Promise<ServiceInfo[]>;
  /**
   * Stops answering edges: the goodbye first (they stop waiting at once), then everything else. The lease stays held
   * until the core's beat gives it back (main.ts does, once Discord is left).
   */
  stop(): Promise<void>;
}

/** The commands the core answers: every action of the web layer, the access rules, and the host's jobs. */
export function coreCommands(options: {
  readonly actions: Actions;
  readonly access: Access;
  readonly backup: CoreServicesOptions['backup'];
  readonly logs: CoreServicesOptions['logs'];
  readonly doctor: CoreServicesOptions['doctor'];
  readonly turnedAway: CoreServicesOptions['turnedAway'];
  readonly settings?: HostSettings | undefined;
}): Map<string, CommandHandler> {
  const { actions, access } = options;
  const handlers = new Map<string, CommandHandler>();
  for (const name of WEB_ACTIONS) {
    const at = SIGNAL_AT[name];
    handlers.set(`actions.${name}`, async (args, signal) => {
      const given = [...args];
      // The core's own signal where the action takes one, the arguments before it as the edge sent them.
      if (at !== undefined) {
        given.length = at;
        given[at] = signal;
      }
      const run = actions[name] as (...values: unknown[]) => unknown;
      const value = await run.apply(actions, given);
      // A set travels as a list (JSON has no sets); the edge makes it a set again.
      return value instanceof Set ? [...value] : value;
    });
  }
  handlers.set('access.context', ([principal, guildId]) => {
    if (typeof guildId !== 'string' || typeof principal !== 'object' || principal === null)
      throw new ActionError('invalid', 'no login or server named');
    return access.context(principal as Parameters<Access['context']>[0], guildId);
  });
  handlers.set('access.guilds', ([principal]) => {
    if (typeof principal !== 'object' || principal === null) throw new ActionError('invalid', 'no login named');
    return access.guilds(principal as Parameters<Access['guilds']>[0]);
  });
  handlers.set('access.forget', ([userId]) => access.forget(typeof userId === 'string' ? userId : undefined));
  handlers.set('core.backup', () => options.backup());
  handlers.set('core.logs', ([query]) => options.logs(query as LogQuery));
  handlers.set('core.doctor', ([discordLogin]) => options.doctor(discordLogin === true));
  handlers.set('core.turned-away', ([away]) => {
    options.turnedAway(away as TurnedAway);
  });
  // The host's settings: the page's calls on an edge, answered by the core's settings service.
  if (options.settings) for (const [name, handler] of settingsCommands(options.settings)) handlers.set(name, handler);
  return handlers;
}

/** Starts what the edges need of the core, and then its heartbeat. */
export async function startCoreServices(options: CoreServicesOptions): Promise<CoreServices> {
  const { transport, names, bus, log } = options;
  const commands = await CommandServer.start({
    transport,
    names,
    handlers: coreCommands(options),
    log: log.child('commands'),
    metrics: options.registry,
  });
  const sender = new EventSender(bus, { transport, names, log: log.child('relay'), metrics: options.registry });
  // Who listens in the edges' browsers changed: the core's own parts hear it as one process's live updates tell it
  // (the votes recount, the rest looks again at whether the server is heard). Presence tells its changes only once it
  // has started, so this never meets it unmade.
  const presence: Presence = await Presence.start({
    transport,
    names,
    log: log.child('presence'),
    changed: (guildId) => {
      bus.emit('people', { guildId });
      bus.emit('listeners', { guildId, count: presence.count(guildId) });
    },
  });
  // How many edges report who listens in their browsers: every running edge does, every few seconds.
  const edges = reportingEdges(options.registry);
  options.registry.collect(() => edges.set(presence.edgeCount));
  let internal: InternalServer | null = null;
  let health: HealthServer | null = null;
  let internalAddress = '';
  let healthAddress = '';
  try {
    internal = await createInternalServer({
      host: options.host,
      port: options.internal.port,
      secret: options.internal.secret,
      files: options.files,
      cacheDir: options.cache.dir,
      behind: options.behind,
      log: log.child('internal'),
    });
    internalAddress = await internal.listen();
    health = createHealthServer({
      host: options.host,
      port: options.port,
      health: options.health,
      registry: options.registry,
      metricsToken: options.metricsToken,
    });
    healthAddress = await health.listen();
  } catch (error) {
    // A port taken: nothing half started is left behind.
    await Promise.allSettled([internal?.close(), health?.close(), commands.close(), presence.stop()]);
    sender.stop();
    throw error;
  }
  log.info('the core answers its edges', {
    internal: `${options.host}:${options.internal.port}`,
    health: `${options.host}:${options.port}`,
  });
  // Everything answers: the edges may hear the core now.
  options.beat.announce();
  // When this core started, for its line in the settings' Services.
  const startedAt = Date.now();
  return {
    internalAddress,
    healthAddress,
    setMetricsToken: (token) => health?.setMetricsToken(token),
    list: async () => {
      const ready = (await options.health.read()).ready;
      return [
        { role: 'core', name: options.instance ?? 'core', version: VERSION, startedAt, ready, seenAt: Date.now() },
        ...presence.reporting().map(
          (edge): ServiceInfo => ({
            role: 'edge',
            name: edge.name,
            version: edge.about?.version ?? '',
            startedAt: edge.about?.startedAt ?? null,
            ready: edge.about?.ready ?? null,
            seenAt: edge.at,
          }),
        ),
      ];
    },
    audience: { count: (guildId) => presence.count(guildId), people: (guildId) => presence.people(guildId) },
    endGuests: (linkId) => sender.end({ what: 'guests', linkId, reason: 'the listening link has ended' }),
    stop: async () => {
      // The goodbye first: the edges stop sending commands and tell their panels at once.
      await options.beat.goodbye();
      sender.stop();
      await Promise.allSettled([commands.close(), presence.stop(), internal?.close(), health?.close()]);
    },
  };
}
