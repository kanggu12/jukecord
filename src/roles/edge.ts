/**
 * An edge of a split jukecord: the panel, the API, the live updates, logins and the browsers' audio, with the music
 * itself at the core.
 *
 * The web server is the one of one process (web/server.ts) over what the edge asks of the core instead of its own
 * parts: every action, the access rules and the host's jobs are commands over the bus (web/core.ts), the core's events
 * feed this edge's live updates, the audio and the covers are streamed from the core's internal port, and who listens
 * is reported to the core and added up with the other edges'. Logins stay here: sessions, tokens and listening links
 * are rows of the database every service shares.
 *
 * Nothing waits on a core that is gone. A core lost (its heartbeat silent, or its goodbye) or replaced (restarted)
 * refuses every command still waiting, and closes every live connection with 1012, so each panel reconnects and asks
 * for the whole state again; so does this edge's bus when it comes back after it was down, since it lost what it
 * carried meanwhile. A core back after it was lost, or whose own bus came back (resumed), has the panels ask again
 * too, without refusing the commands under way: it may be running them. A panel that connects while the core is away
 * hears "unavailable" for its server and asks again shortly.
 *
 * Its readiness is the database's, the bus's and the shared cache's, as one process's is, and the core's heartbeat:
 * an edge that hears no core has nothing to serve, so a front that asks /readyz sends it no browsers.
 */
import type { Principal } from '../app/access.ts';
import type { DoctorReport } from '../app/doctor.ts';
import { cachePart, databasePart, Health } from '../app/health.ts';
import type { LoginChecks } from '../auth/check.ts';
import { type AuthSettings, describeAuth } from '../auth/settings.ts';
import { type CoreChange, CoreWatch } from '../bus/beat.ts';
import { COMMAND_LIMIT_MS, CommandClient } from '../bus/commands.ts';
import { Presence, PresenceReporter } from '../bus/presence.ts';
import { EventReceiver, EventSender } from '../bus/relay.ts';
import type { BusNames, BusTransport } from '../bus/transport.ts';
import type { Cache } from '../cache/cache.ts';
import type { Bus } from '../core/bus.ts';
import type { Logger } from '../log.ts';
import type { MetricsRegistry } from '../metrics/registry.ts';
import { busReport } from '../metrics/services.ts';
import type { HostSettingsPort } from '../settings/service.ts';
import type { Store } from '../store/store.ts';
import { VERSION } from '../version.ts';
import type { Auth } from '../web/auth.ts';
import {
  type AccessPort,
  type ActionsPort,
  CORE_COMMANDS,
  type HostJobs,
  WEB_ACTIONS,
  type WebAction,
} from '../web/core.ts';
import type { LiveLimits } from '../web/events.ts';
import { RemoteFiles } from '../web/files.ts';
import type { LogLine, LogQuery } from '../web/logs.ts';
import type { Presenter } from '../web/present.ts';
import { createWebServer, type TurnedAway, type WebServer } from '../web/server.ts';
import { SIGNAL_AT } from './core.ts';
import { corePart, transportPart } from './health.ts';

/** How long a command may take: lookups on the sites take up to the fetch time limit, lists of them minutes. */
export function commandLimit(command: string, fetchTimeoutMs: number): number {
  // An address or words looked up, lyrics in LRCLIB's line, a voice channel joined.
  if (['actions.search', 'actions.lyrics', 'actions.join'].includes(command)) return fetchTimeoutMs + 30_000;
  // A link's or a playlist's tracks found one by one (a hundred at most, three at a time), a file imported, a backup
  // of a big database, the self-check (which asks yt-dlp and GitHub).
  if (['actions.add', 'actions.playNow', 'actions.playlistImport', 'core.backup', 'core.doctor'].includes(command))
    return 10 * 60_000;
  return COMMAND_LIMIT_MS;
}

/** The newest version of each server's queue this edge has heard of (its live updates keep the queue by version). */
export class QueueVersions {
  private readonly versions = new Map<string, number>();

  /** A version heard: from the core's event, or with a queue read from the core. */
  saw(guildId: string, version: number): void {
    if (version > (this.versions.get(guildId) ?? -1)) this.versions.set(guildId, version);
  }

  /** The newest heard, or -1 when none was (the queue is read then). */
  get(guildId: string): number {
    return this.versions.get(guildId) ?? -1;
  }

  /** Forgets every version: a new core counts from the start again. */
  clear(): void {
    this.versions.clear();
  }
}

/** The actions as commands to the core, answering what Actions answers. */
export function remoteActions(client: CommandClient, versions: QueueVersions): ActionsPort {
  const port: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const name of WEB_ACTIONS) {
    const at = SIGNAL_AT[name as WebAction];
    port[name] = async (...args: unknown[]) => {
      // A signal travels as a cancel when it aborts, not as an argument.
      const signal = at !== undefined && args[at] instanceof AbortSignal ? args[at] : undefined;
      const sent = at !== undefined ? args.slice(0, at) : args;
      const value = await client.call(`actions.${name}`, sent, signal ? { signal } : {});
      if (name === 'skipVoters') return new Set(Array.isArray(value) ? (value as string[]) : []);
      // A queue read says its version: kept, so the live updates know their copy is current.
      if (name === 'queue') {
        const queue = value as { version?: unknown };
        const context = args[0] as { guildId?: unknown } | undefined;
        if (typeof queue?.version === 'number' && typeof context?.guildId === 'string')
          versions.saw(context.guildId, queue.version);
      }
      return value;
    };
  }
  return port as unknown as ActionsPort;
}

/** The access rules as commands to the core, which asks Discord (and remembers its answers for a minute). */
export function remoteAccess(client: CommandClient, log: Logger): AccessPort {
  return {
    context: (principal, guildId) => client.call('access.context', [principal, guildId]),
    guilds: (principal: Principal) => client.call('access.guilds', [principal]),
    forget: (userId) => {
      client.call('access.forget', [userId]).catch((error: unknown) => {
        log.debug('could not tell the core to forget a membership', { error });
      });
    },
  };
}

export interface EdgeOptions {
  /** This edge's run (see serviceId): its name on the bus. */
  readonly name: string;
  readonly transport: BusTransport;
  readonly names: BusNames;
  /** This edge's own bus, which the core's events are announced on (its live updates listen there). */
  readonly bus: Bus;
  readonly store: Store;
  readonly auth: Auth;
  readonly presenter: Presenter;
  /** The shared cache, where the rates are counted with the other edges. */
  readonly sharedCache: Cache;
  readonly registry: MetricsRegistry;
  /** Where the core's internal port is, and the secret it takes. */
  readonly coreUrl: string;
  readonly secret: string;
  readonly fetchTimeoutMs: number;
  readonly web: {
    readonly host: string;
    readonly port: number;
    readonly publicUrl: string;
    readonly trustProxy: boolean | number | string;
    readonly panelDir: string | null;
    readonly live?: Partial<LiveLimits>;
    readonly logDir: string;
    readonly logFiles: number;
    readonly backupDir: string;
    readonly backupKeep: number;
    /** The rates and their clock, as one process's server takes them (tests lower them). */
    readonly rates?: Parameters<typeof createWebServer>[0]['rates'];
    /** Whether this edge has fallen behind (tests say never; by default its event loop says). */
    readonly behind?: () => boolean;
    /** The token that lets a scraper read /metrics from anywhere (JUKECORD_METRICS_TOKEN). */
    readonly metricsToken?: string | null;
    /** The settings of logging in through the host's identity provider and directory, and their tests. */
    readonly loginSettings?: AuthSettings;
    readonly loginChecks?: LoginChecks | null;
    /** The host's settings for the page, the API and the CLI: the core's, over the bus (src/settings/bus.ts). */
    readonly settings?: (client: CommandClient) => HostSettingsPort;
  };
  readonly log: Logger;
  /** How long the core may say nothing before it is taken for lost (default from bus/beat.ts). */
  readonly coreLostAfterMs?: number;
}

export interface Edge {
  readonly web: WebServer;
  readonly watch: CoreWatch;
  readonly client: CommandClient;
  /** Stops reporting and listening (the web server is closed by whoever started it). */
  stop(): Promise<void>;
}

/** Starts an edge's parts and its web server (not listening yet). */
export async function startEdge(options: EdgeOptions): Promise<Edge> {
  const { transport, names, bus, log } = options;
  // When this edge started, for the core's list of its services.
  const startedAt = Date.now();
  const client = await CommandClient.start({
    transport,
    names,
    caller: options.name,
    log: log.child('commands'),
    report: busReport(options.registry, CORE_COMMANDS),
    limitMs: (command) => commandLimit(command, options.fetchTimeoutMs),
  });
  const versions = new QueueVersions();
  // The web server, once made (the parts below are started first and hear it late).
  let web: WebServer | null = null;
  // A change of the core, or this edge's bus back after it was down: versions forgotten and every panel told to
  // reconnect and ask again; and the waiting commands refused when the core they went to is gone (lost, replaced) or
  // their answers were lost with this edge's connection.
  const restart = (why: string, refuse: boolean) => {
    if (refuse) client.failAll();
    versions.clear();
    web?.hub.restartAll();
    log.info('the live connections were told to reconnect', { why });
  };
  const watch = await CoreWatch.start({
    transport,
    names,
    version: VERSION,
    log: log.child('core'),
    ...(options.coreLostAfterMs !== undefined ? { lostAfterMs: options.coreLostAfterMs } : {}),
    changed: (change: CoreChange) => {
      // The first core this edge hears: what its panels asked meanwhile it answered already (or they ask again).
      if (change === 'found') return;
      restart(`the core was ${change}`, change === 'lost' || change === 'replaced');
    },
  });
  let wasDown = false;
  const offChange = transport.onChange((up) => {
    if (!up) {
      wasDown = true;
      // Answers on their way are lost with the connection: nothing waits for them.
      client.failAll();
      return;
    }
    if (wasDown) restart('the bus is back', true);
    wasDown = false;
  });
  // The core's events, announced on this edge's bus; the endings it and the other edges send, ended here.
  const receiver = await EventReceiver.start(bus, {
    transport,
    names,
    log: log.child('relay'),
    metrics: options.registry,
    ended: (ending) => web?.hub.ended(ending),
  });
  // What this edge ends that the others must end too (a logout here) goes out the same way; nothing else does.
  const sender = new EventSender(null, { transport, names, log: log.child('relay'), metrics: options.registry });
  bus.on('queue', ({ guildId, version }) => versions.saw(guildId, version));
  // Who listens on the other edges, for this edge's panels.
  const elsewhere = await Presence.start({
    transport,
    names,
    self: options.name,
    log: log.child('presence'),
    changed: (guildId) => web?.hub.elsewhereChanged(guildId),
  });
  const actions = remoteActions(client, versions);
  const access = remoteAccess(client, log);
  const host: HostJobs = {
    backup: () => client.call('core.backup', []),
    logs: (query: LogQuery) => client.call<LogLine[]>('core.logs', [query]),
  };
  const files = new RemoteFiles({ coreUrl: options.coreUrl, secret: options.secret, log: log.child('files') });
  const facts = () => watch.facts;
  const { web: settings } = options;
  // Whether this edge can serve, part by part: its database, its bus and its shared cache, as one process's, and
  // the core (its heartbeat). Whether Discord is connected is the core's word.
  const health = new Health({
    parts: [
      databasePart(options.store),
      transportPart(transport),
      cachePart(options.sharedCache),
      corePart(() => watch.seen),
    ],
    discord: () => facts()?.discordReady ?? false,
    metrics: options.registry,
  });
  web = await createWebServer({
    host: settings.host,
    port: settings.port,
    publicUrl: settings.publicUrl,
    trustProxy: settings.trustProxy,
    panelDir: settings.panelDir,
    bus,
    log: log.child('web'),
    ...(settings.live ? { live: settings.live } : {}),
    ...(settings.rates ? { rates: settings.rates } : {}),
    ...(settings.behind ? { behind: settings.behind } : {}),
    sharedCache: options.sharedCache,
    metrics: options.registry,
    ...(settings.metricsToken !== undefined ? { metricsToken: settings.metricsToken } : {}),
    health,
    // Connections turned away at a cap are jukecord's trouble, told to the alerts channels by the core.
    turnedAway: (away: TurnedAway) => {
      client.call('core.turned-away', [away]).catch(() => {});
    },
    edge: {
      files,
      queueVersion: (guildId) => versions.get(guildId),
      elsewhere,
      endings: (ending) => sender.end(ending),
      behind: () => facts()?.behind ?? false,
    },
    deps: {
      actions,
      access,
      auth: options.auth,
      store: options.store,
      presenter: options.presenter,
      // The bot's account, from the core's heartbeat.
      directory: () => {
        const self = facts()?.self ?? null;
        return self ? { self: () => self } : null;
      },
      publicUrl: settings.publicUrl,
      logDir: settings.logDir,
      logFiles: settings.logFiles,
      backupDir: settings.backupDir,
      backupKeep: settings.backupKeep,
      // Whether the bot is set up: the core says, with every heartbeat.
      get discordMode() {
        return facts()?.discordMode ?? false;
      },
      // The core's self-check, with this edge's login settings in place of the core's: logins happen here (a split's
      // core has none of its own to show).
      doctor: async () => {
        const report = await client.call<DoctorReport>('core.doctor', [options.auth.discordLogin]);
        if (!settings.loginSettings) return report;
        const theirs = Object.entries(report.settings).filter(([key]) => !/^(sso|directory) /.test(key));
        return { ...report, settings: { ...Object.fromEntries(theirs), ...describeAuth(settings.loginSettings) } };
      },
      host,
      ...(settings.loginSettings ? { loginSettings: settings.loginSettings } : {}),
      ...(settings.loginChecks !== undefined ? { loginChecks: settings.loginChecks } : {}),
      ...(settings.settings ? { settings: settings.settings(client) } : {}),
    },
  });
  const hub = web.hub;
  // Who listens in this edge's browsers, for the core and the other edges: on every change, and as a heartbeat.
  const reporter = await PresenceReporter.start({
    transport,
    names,
    edge: options.name,
    listeners: (guildId) => hub.ownListeners(guildId),
    guilds: () => hub.listenedGuilds(),
    // What this edge is, for the core's list of its services (the host's settings show it): ready while it hears its
    // core over a bus that is up (read here, not through the readiness check, whose answer is kept for a second).
    about: () => ({ version: VERSION, startedAt, ready: transport.up && watch.seen }),
    log: log.child('presence'),
  });
  bus.on('listeners', ({ guildId }) => reporter.changed(guildId));
  return {
    web,
    watch,
    client,
    stop: async () => {
      offChange();
      await Promise.allSettled([reporter.stop(), elsewhere.stop(), receiver.stop(), watch.stop(), client.close()]);
      files.close();
    },
  };
}
