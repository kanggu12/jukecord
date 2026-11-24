/**
 * A split jukecord in one process, for tests: a core (the players, the actions, a fake Discord, fake media, its
 * commands, events, presence, internal port and health port) and edges (the real web server over the core), joined by
 * a bus (in memory; Redis or Valkey when JUKECORD_TEST_BUS_URL names one) and sharing one database, as services share
 * PostgreSQL, and one shared cache: one in memory, or on the bus's server, each service with its own connection to it
 * as the real ones have. Everything listens on 127.0.0.1 on ports the system picks.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Access } from '../../src/app/access.ts';
import { Actions } from '../../src/app/actions.ts';
import { cachePart, databasePart, Health } from '../../src/app/health.ts';
import { SkipVotes } from '../../src/app/votes.ts';
import type { AuthSettings } from '../../src/auth/settings.ts';
import { CoreBeat } from '../../src/bus/beat.ts';
import { serviceId } from '../../src/bus/commands.ts';
import type { BusTransport } from '../../src/bus/transport.ts';
import type { Cache } from '../../src/cache/cache.ts';
import { MemoryCache } from '../../src/cache/memory.ts';
import { openCache } from '../../src/cache/open.ts';
import { Bus } from '../../src/core/bus.ts';
import { GuildLanes } from '../../src/core/lanes.ts';
import { Players } from '../../src/core/players.ts';
import { QueueService } from '../../src/core/queue.ts';
import type { NewTrack } from '../../src/core/types.ts';
import { createLogger, MemorySink } from '../../src/log.ts';
import { MediaCache } from '../../src/media/cache.ts';
import { Covers } from '../../src/media/covers.ts';
import type { Resolver } from '../../src/media/resolver.ts';
import { MetricsRegistry } from '../../src/metrics/registry.ts';
import { playerMetrics } from '../../src/metrics/service.ts';
import { type CoreServices, startCoreServices } from '../../src/roles/core.ts';
import { type Edge, startEdge } from '../../src/roles/edge.ts';
import { transportPart } from '../../src/roles/health.ts';
import type { Store } from '../../src/store/store.ts';
import { Auth } from '../../src/web/auth.ts';
import { MediaFiles } from '../../src/web/files.ts';
import { COVERS, Limit } from '../../src/web/limits.ts';
import { Presenter } from '../../src/web/present.ts';
import { type TestBus, testLog } from './bus.ts';
import { FakeClock, FakeMedia } from './fakes.ts';
import { memoryStore } from './store.ts';
import { FakeDirectory, FakeVoice, HOST_TOKEN } from './web.ts';

/** The secret of every test core and its edges. */
export const SECRET = 'test-internal-secret-0123456789abcdef0123456789';

/** A test core: its parts, to look at and to drive, and its end. */
export interface TestCore {
  readonly instance: string;
  readonly services: CoreServices;
  readonly actions: Actions;
  readonly players: Players;
  readonly queue: QueueService;
  readonly bus: Bus;
  readonly cache: MediaCache;
  readonly media: FakeMedia;
  readonly directory: FakeDirectory;
  readonly logs: MemorySink;
  /** The internal port's address, which edges stream audio from. */
  readonly internalUrl: string;
  readonly healthUrl: string;
  /** Stops it, as a core stopping does (its goodbye first). */
  stop(): Promise<void>;
}

/** A test edge: its web server listening, its base address, and its end. */
export interface TestEdge {
  readonly edge: Edge;
  /** Its connection to the bus (a test may cut it, on the memory bus). */
  readonly transport: BusTransport;
  readonly url: string;
  readonly auth: Auth;
  /** Its shared cache: the one in memory, or its own connection to the bus's server. */
  readonly cache: Cache;
  readonly logs: MemorySink;
  stop(): Promise<void>;
}

export interface SplitOptions {
  /** What the resolver finds for each input. */
  readonly found?: Record<string, NewTrack[]>;
  /** Without Discord: browser-only mode (the one local server). */
  readonly browserOnly?: boolean;
  /** How long an edge waits for a silent core before it takes it for lost (tests shorten it). */
  readonly coreLostAfterMs?: number;
  /** Lower rates for the edges (one rate for every edge: they count together in the shared cache). */
  readonly rates?: { readonly changes?: { perSecond: number; burst: number } };
  /** The edges' login settings (OIDC, LDAP), which their self-check shows in place of the core's. */
  readonly logins?: AuthSettings;
}

/** The pieces a split test shares: one database, one bus, one shared cache, the media cache's folder. */
export interface Split {
  readonly store: Store;
  readonly bus: TestBus;
  readonly shared: Cache;
  readonly dataDir: string;
  readonly options: SplitOptions;
  /** Starts a core (a second one waits for the first's lease, as a real one does). */
  core(): Promise<TestCore>;
  /** Starts an edge, listening, that streams from `core`'s internal port (with another secret, to test a mistake). */
  edge(core: TestCore, options?: { secret?: string }): Promise<TestEdge>;
  /** Stops everything still running and removes what the test made. */
  close(): Promise<void>;
}

/** A split jukecord's pieces on a test bus. */
export async function split(bus: TestBus, options: SplitOptions = {}): Promise<Split> {
  const clock = new FakeClock();
  const store = await memoryStore(() => clock.now());
  const shared = new MemoryCache();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-split-'));
  const running: (() => Promise<void>)[] = [];
  // Each service's shared cache: the one in memory, or a connection of its own to the bus's server, under the bus's
  // prefix (what one edge keeps there, another reads).
  const opened: Cache[] = [];
  const cacheFor = async (service: string): Promise<Cache> => {
    if (!bus.url) return shared;
    const cache = await openCache({ url: bus.url, prefix: bus.prefix, log: testLog().log, service, waitMs: 5000 });
    opened.push(cache);
    return cache;
  };
  // The media cache is the core's disk: one folder, which a restarted core finds again.
  const cacheDir = path.join(dataDir, 'cache');

  const core = async (): Promise<TestCore> => {
    const logs = new MemorySink();
    const log = createLogger({ level: 'debug', sinks: [logs] });
    const instance = serviceId('core');
    const transport: BusTransport = await bus.connect(`core-${instance}`);
    const coreCache = await cacheFor(instance);
    const beat = await CoreBeat.start({
      transport,
      names: bus.names,
      instance,
      version: 'test',
      facts: () => ({
        discordMode: !options.browserOnly,
        discordReady: !options.browserOnly,
        self: null,
        behind: false,
      }),
      log,
      lost: () => {},
      retryMs: 50,
    });
    const local = new Bus();
    const lanes = new GuildLanes();
    const queue = new QueueService(store.queue, local, lanes);
    const media = new FakeMedia();
    const players = new Players({
      queue,
      media,
      history: store.history,
      state: store.playerState,
      bus: local,
      clock,
      log,
      lanes,
      fetchTimeoutMs: 60_000,
    });
    const found = options.found ?? {};
    const resolver = {
      resolve: async (input: string) => {
        const tracks = found[input];
        if (!tracks) throw new Error(`nothing to add for "${input}"`);
        const stored = [];
        for (const track of tracks) stored.push(await store.tracks.upsert(track));
        return stored;
      },
    } as unknown as Resolver;
    const directory = new FakeDirectory();
    const voice = new FakeVoice();
    // The core's numbers, as its own port's /metrics shows them (the players and queues, as main.ts declares them).
    const registry = new MetricsRegistry();
    let browsers: (guildId: string) => readonly string[] = () => [];
    const votes = new SkipVotes({
      players,
      bus: local,
      clock,
      log,
      lanes,
      applies: (guildId) => actions.voteSkipApplies(guildId),
      listening: (guildId) => new Set([...voice.people(guildId), ...browsers(guildId)]),
    });
    const actions = new Actions({
      store,
      queue,
      players,
      lanes,
      resolver,
      log,
      startedAt: clock.now(),
      votes,
      bus: local,
    });
    if (!options.browserOnly) actions.setVoice(voice, () => true, directory);
    const access = new Access({ settings: store.settings, directory: () => (options.browserOnly ? null : directory) });
    const cache = new MediaCache({ dir: cacheDir, maxBytes: 1024 ** 3, log });
    cache.init();
    playerMetrics(registry, { players, queue });
    const covers = new Covers({ cache, log, fetch: async () => Promise.reject(new Error('no pictures in tests')) });
    const stopping = new AbortController();
    const files = new MediaFiles({
      players,
      queue,
      store,
      cache,
      mp3: async () => null,
      covers,
      searched: (context, address) => actions.searched(context, address),
      coverRate: new Limit(coreCache, 'covers', COVERS),
      behind: () => false,
      stopping: stopping.signal,
    });
    const services = await startCoreServices({
      transport,
      names: bus.names,
      beat,
      bus: local,
      actions,
      access,
      cache,
      files,
      backup: async () => ({ file: path.join(dataDir, 'backups', 'test.db'), bytes: 1 }),
      logs: () => [
        { time: '2026-11-11T00:00:00.000Z', level: 'info', component: 'core', msg: 'from the core', fields: {} },
      ],
      // A core's own settings, its login settings off (a split's core has none).
      doctor: async (discordLogin) => ({
        ok: true,
        checks: [{ name: 'core', status: 'ok', detail: `asked with discordLogin=${discordLogin}` }],
        settings: { 'data directory': dataDir, 'sso (oidc)': 'off', 'directory (ldap)': 'off', role: 'core' },
      }),
      turnedAway: () => {},
      health: new Health({
        parts: [databasePart(store), transportPart(transport), cachePart(coreCache)],
        discord: () => !options.browserOnly,
      }),
      behind: () => false,
      host: '127.0.0.1',
      port: 0,
      internal: { port: 0, secret: SECRET },
      registry,
      metricsToken: null,
      log,
    });
    actions.setEndGuests((linkId) => services.endGuests(linkId));
    browsers = (guildId) => services.audience.people(guildId);
    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      stopping.abort();
      await services.stop();
      await transport.close();
    };
    running.push(stop);
    return {
      instance,
      services,
      actions,
      players,
      queue,
      bus: local,
      cache,
      media,
      directory,
      logs,
      internalUrl: services.internalAddress,
      healthUrl: services.healthAddress,
      stop,
    };
  };

  const edge = async (to: TestCore, given: { secret?: string } = {}): Promise<TestEdge> => {
    const logs = new MemorySink();
    const log = createLogger({ level: 'debug', sinks: [logs] });
    const name = serviceId('edge');
    const transport = await bus.connect(`edge-${name}`);
    const cache = await cacheFor(name);
    // Its logins: the database's rows, and the login links and failed logins on the shared cache, as a real edge's.
    const auth = new Auth({ store, hostToken: HOST_TOKEN, secureCookies: false, oauth: null, cache, log });
    const made = await startEdge({
      name,
      transport,
      names: bus.names,
      bus: new Bus(),
      store,
      auth,
      presenter: new Presenter(store.users),
      sharedCache: cache,
      registry: new MetricsRegistry(),
      coreUrl: to.internalUrl,
      secret: given.secret ?? SECRET,
      fetchTimeoutMs: 60_000,
      web: {
        host: '127.0.0.1',
        port: 0,
        publicUrl: 'http://localhost:8795',
        trustProxy: false,
        panelDir: null,
        logDir: path.join(dataDir, 'logs'),
        logFiles: 5,
        backupDir: path.join(dataDir, 'backups'),
        backupKeep: 7,
        ...(options.rates ? { rates: options.rates } : {}),
        ...(options.logins ? { loginSettings: options.logins } : {}),
        // Never behind: a busy test machine must not make changes fail at random (as tests/support/web.ts does).
        behind: () => false,
      },
      log,
      ...(options.coreLostAfterMs !== undefined ? { coreLostAfterMs: options.coreLostAfterMs } : {}),
    });
    const url = await made.web.listen();
    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      await made.web.close();
      await made.stop();
      await transport.close();
    };
    running.push(stop);
    return { edge: made, transport, url, auth, cache, logs, stop };
  };

  return {
    store,
    bus,
    shared,
    dataDir,
    options,
    core,
    edge,
    close: async () => {
      for (const stop of running.reverse()) await stop().catch(() => {});
      await bus.close();
      await store.close();
      await shared.close();
      await Promise.allSettled(opened.map((cache) => cache.close()));
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
