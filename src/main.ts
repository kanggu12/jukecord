/**
 * jukecord's entry point: reads the settings, opens the database and the cache, and starts the parts that are
 * configured (the Discord bot needs a token; without one jukecord runs browser-only).
 *
 * One process is all of jukecord (JUKECORD_ROLE=all, the default). Split into services from the same image, the core
 * is everything but the web server, with what its edges need of it instead (roles/core.ts), and an edge is the web
 * server over the core (roles/edge.ts). Each role starts what it needs and nothing else.
 *
 * This file only connects parts; each of them is tested on its own. The order matters in three places: a core takes
 * its lease on the bus before anything that only one core may do, the players are restored before the bot starts,
 * so a slash command never meets a half-restored player, and on shutdown the positions are saved before the database
 * closes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Access } from './app/access.ts';
import { Actions, type Directory } from './app/actions.ts';
import { type AlertSink, Alerts, leftLoopAlert, restartedAlert, turnedAwayAlert } from './app/alerts.ts';
import { Autoplay } from './app/autoplay.ts';
import { BackupSchedule, makeBackup } from './app/backups.ts';
import { runDoctor } from './app/doctor.ts';
import { busPart, cachePart, databasePart, discordPart, Health, toolPart } from './app/health.ts';
import { Rest } from './app/rest.ts';
import { SkipVotes } from './app/votes.ts';
import { LoginChecks } from './auth/check.ts';
import { LdapLogin } from './auth/ldap.ts';
import { OidcLogin } from './auth/oidc.ts';
import { CoreBeat, type CoreFacts } from './bus/beat.ts';
import { serviceId } from './bus/commands.ts';
import { RedisTransport } from './bus/redis.ts';
import { type BusTransport, busNames } from './bus/transport.ts';
import type { Cache } from './cache/cache.ts';
import { openCache } from './cache/open.ts';
import { type Config, ConfigError, loadConfig } from './config.ts';
import { Bus } from './core/bus.ts';
import { systemClock } from './core/clock.ts';
import { GuildLanes, throwFromTimer } from './core/lanes.ts';
import { Players } from './core/players.ts';
import { QueueService } from './core/queue.ts';
import { Bot } from './discord/bot.ts';
import { ConsoleSink, createLogger, FileSink } from './log.ts';
import { publicAddressesOnly } from './media/address.ts';
import { BatchLookups } from './media/batch.ts';
import { MediaCache } from './media/cache.ts';
import { Covers } from './media/covers.ts';
import { startEgressGuard } from './media/egress.ts';
import { publicFetch } from './media/fetch.ts';
import { Ffmpeg } from './media/ffmpeg.ts';
import { Links } from './media/links.ts';
import { LrclibClient, Lyrics } from './media/lyrics.ts';
import { outbound } from './media/outbound.ts';
import { Prefetcher } from './media/prefetch.ts';
import { Media } from './media/preparer.ts';
import { Resolver } from './media/resolver.ts';
import { Search } from './media/search.ts';
import { YtDlp } from './media/ytdlp.ts';
import { databaseReport } from './metrics/database.ts';
import { ToolWatch } from './metrics/media.ts';
import { MetricsRegistry } from './metrics/registry.ts';
import { diskMetrics, EventLoop, runtimeMetrics } from './metrics/runtime.ts';
import { describeService, discordMetrics, playerMetrics } from './metrics/service.ts';
import { sharedCacheReport } from './metrics/services.ts';
import { type CoreServices, startCoreServices } from './roles/core.ts';
import { startEdge } from './roles/edge.ts';
import { transportPart } from './roles/health.ts';
import { describeAddress } from './store/address.ts';
import { ConnectionError } from './store/network.ts';
import { openStore } from './store/open.ts';
import type { Store } from './store/store.ts';
import { VERSION } from './version.ts';
import { startWatchdog, takeWatchdogMark } from './watchdog.ts';
import { Auth, ensureHostToken } from './web/auth.ts';
import { MediaFiles } from './web/files.ts';
import { COVERS, Limit } from './web/limits.ts';
import { readLogs } from './web/logs.ts';
import { Presenter } from './web/present.ts';
import { createWebServer, type WebServer } from './web/server.ts';

// The most tracks one playlist adds: enough for any party, small enough not to bury the queue.
const MAX_PLAYLIST = 500;

// The built panel, beside the source in a checkout and in the image (panel/dist, made by `npm run build`).
const PANEL_DIR = fileURLToPath(new URL('../panel/dist', import.meta.url));

// What a crash runs before exiting: saving the players' positions, once they exist (see main).
let crashCheckpoint: () => Promise<void> = async () => {};
// Set by the first unexpected error: the exit it makes is under way.
let crashing = false;

async function main(): Promise<number> {
  // Everything jukecord writes (the database, logins, logs, the cache) is for its own user only.
  process.umask(0o077);
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(process.env, process.cwd());
  } catch (error) {
    // Settings problems are printed as a list and the process exits with 2 (a usage error), before anything starts.
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    throw error;
  }

  const log = createLogger({
    level: config.log.level,
    sinks: [
      // Readable lines, or with JUKECORD_LOG_FORMAT=json the log file's JSON lines, for a log shipper.
      new ConsoleSink(config.log.format),
      new FileSink({ dir: path.join(config.dataDir, 'logs'), maxBytes: config.log.maxBytes, files: config.log.files }),
    ],
  });
  for (const warning of config.warnings) log.warn(warning);
  log.info(`starting jukecord ${VERSION}`, {
    data: config.dataDir,
    // Where the database is, never with its user or password.
    database: describeAddress(config.database.address),
    // An edge never logs in to Discord: the core does.
    discord: config.role === 'edge' ? 'at the core' : config.discord.token ? 'yes' : 'browser-only',
    ...(config.role !== 'all' ? { role: config.role } : {}),
  });

  // Every number jukecord reports, for /metrics. A number that cannot be read is said in the log once per reason (a
  // scrape every fifteen seconds would repeat it all day); the others are written all the same.
  const unreadable = new Set<string>();
  const registry = new MetricsRegistry({
    onError: (error) => {
      const reason = error instanceof Error ? error.message : String(error);
      if (unreadable.has(reason)) return;
      unreadable.add(reason);
      log.warn('could not read a number for the metrics', { error });
    },
  });
  // The event loop, watched once: for the metrics, and for the web server, which turns away what can wait while
  // jukecord is behind.
  const loop = new EventLoop();
  runtimeMetrics(registry, loop);
  diskMetrics(registry, config.dataDir);

  // A crash anywhere is logged with its stack before the process goes down; a stray rejected promise is logged and the
  // music goes on (each part already handles its own failures; this catches what slipped through).
  process.on('unhandledRejection', (reason) =>
    log.error('a promise was rejected and nobody handled it', { reason: String(reason) }),
  );
  process.on('uncaughtException', (error) => {
    log.error('jukecord stopped on an error it did not expect', { error });
    // Once: a second error while the positions are saved only adds its line to the log.
    if (crashing) return;
    crashing = true;
    // The positions are saved first. Saving takes each server's turn, after the change under way, so it may wait a
    // moment, two seconds at most; whether it worked or not, jukecord then exits (the restart starts where the last
    // save left them).
    const exit = () => process.exit(1);
    setTimeout(exit, 2000);
    crashCheckpoint().then(exit, exit);
  });

  // An edge is the web server over the core, with none of the parts below.
  if (config.role === 'edge') return runEdge(config, log, registry, loop);
  const core = config.role === 'core';
  // A core's bus, and its lease on it, before anything only one core may do (the players, Discord, the backups): a
  // second core waits here until the first has stopped (see bus/beat.ts).
  const names = busNames(config.bus.prefix);
  const instance = serviceId('core');
  // The facts every heartbeat carries, filled in once the bot and the web side exist below.
  let facts = (): CoreFacts => ({ discordMode: false, discordReady: false, self: null, behind: false });
  // Set when this core can no longer be sure it holds the lease: it stops (filled in once stopping is set up below).
  let lostLease = (): void => process.exit(1);
  let transport: BusTransport | null = null;
  let beat: CoreBeat | null = null;
  if (core) {
    const bus = await RedisTransport.open(config.bus.url ?? '', { log: log.child('bus'), service: instance });
    transport = bus;
    beat = await CoreBeat.start({
      transport: bus,
      names,
      instance,
      version: VERSION,
      facts: () => facts(),
      log: log.child('core'),
      lost: () => lostLease(),
    });
  }

  // The database JUKECORD_DATABASE_URL names (the data folder's SQLite file by default); a server is waited for while it
  // does not answer yet, up to a minute. One that cannot be reached, or refuses jukecord, is said in its words and
  // jukecord ends: there is nothing it can do without its database. Each statement is reported for the metrics.
  let store: Store;
  try {
    store = await openStore(config.database.address, {
      pool: config.database.pool,
      log: log.child('database'),
      report: databaseReport(registry),
    });
  } catch (error) {
    if (!(error instanceof ConnectionError)) throw error;
    log.error('jukecord cannot reach its database', { reason: error.message });
    // A core gives its lease back first: another core need not wait for it to run out.
    await beat?.release();
    await transport?.close();
    return 1;
  }
  if (config.database.address.kind !== 'sqlite') {
    log.info('the database is open', { server: `${store.sql.server.product} ${store.sql.server.version}` });
  }
  // The shared cache (src/cache): the rates, the login links and failed logins, the searches' and the links' short
  // answers. In this process's memory, all one process needs, unless JUKECORD_CACHE_URL names a Redis or Valkey server
  // (a core's is its bus's unless told otherwise); its reads are counted.
  const sharedCache: Cache = await openCache({
    url: config.cacheUrl,
    prefix: config.bus.prefix,
    log: log.child('cache'),
    service: core ? instance : 'all',
    report: sharedCacheReport(registry),
  });
  // Every server's lane: its changes take turns there, whichever part of jukecord makes them (see core/lanes.ts).
  const lanes = new GuildLanes();
  // Trouble said in the log and in each server's alerts channel (app/alerts.ts); the bot posts them once it exists.
  let alertSink: AlertSink | null = null;
  const alerts = new Alerts({
    settings: store.settings,
    sink: () => alertSink,
    log: log.child('alerts'),
    clock: systemClock,
  });
  // The watchdog ended the last run (its mark, src/watchdog.ts): said once, here and in the alerts channels (those
  // once the bot is there to post them, below).
  const watchdogMark = path.join(config.dataDir, 'watchdog.json');
  const lastRun = takeWatchdogMark(watchdogMark);
  if (lastRun) {
    log.warn('the watchdog ended the last run: its main thread had stopped answering', {
      stillSeconds: Math.round(lastRun.stillMs / 1000),
    });
  }
  // A listener that fails is logged with its server; the others still hear the change (see Bus).
  const bus = new Bus((event, guildId, error) => log.error('a listener failed', { event, guild: guildId, error }));
  const queue = new QueueService(store.queue, bus, lanes);
  const cache = new MediaCache({
    dir: path.join(config.dataDir, 'cache'),
    maxBytes: config.media.cacheMaxBytes,
    log: log.child('cache'),
    metrics: registry,
  });
  cache.init();
  // yt-dlp writes cookies back to the file it was given; it gets a private copy, so a read-only mounted secret works.
  let cookies: string | null = null;
  if (config.media.cookies) {
    cookies = path.join(config.dataDir, 'yt-dlp-cookies.txt');
    fs.copyFileSync(config.media.cookies, cookies);
    fs.chmodSync(cookies, 0o600);
  }
  // Every connection yt-dlp makes goes through the address guard, unless private addresses are allowed (egress.ts).
  const egress = config.media.allowPrivate ? null : await startEgressGuard({ log: log.child('egress') });
  // Every run of yt-dlp and ffmpeg is counted, and tells whether the program is there (/readyz says so).
  const tools = new ToolWatch(registry);
  // yt-dlp runs YouTube's scripts with this very Node binary (the image has no other JavaScript runtime).
  const ytdlp = new YtDlp({
    proxy: egress?.url ?? null,
    cookies,
    binary: config.media.ytdlp,
    jsRuntime: `node:${process.execPath}`,
    timeoutMs: config.media.fetchTimeoutMs,
    maxPlaylist: MAX_PLAYLIST,
    cacheDir: path.join(config.dataDir, 'yt-dlp'),
    tools,
  });
  const ffmpeg = new Ffmpeg(config.media.ffmpeg, tools);
  const media = new Media({
    cache,
    ytdlp,
    ffmpeg,
    tracks: store.tracks,
    log: log.child('media'),
    timeoutMs: config.media.fetchTimeoutMs,
    // How fetches go tells whether YouTube refuses this jukecord (its check for bots).
    watch: alerts,
    metrics: registry,
  });
  const players = new Players({
    queue,
    media,
    history: store.history,
    state: store.playerState,
    bus,
    clock: systemClock,
    log: log.child('player'),
    lanes,
    fetchTimeoutMs: config.media.fetchTimeoutMs,
    // A track taken out of a looping queue is told to its server's alerts channel too.
    onLeftLoop: (guildId, track, reason) => void alerts.raise(leftLoopAlert(guildId, track.title, track.id, reason)),
  });
  // The servers' players by state and their queues' lengths.
  playerMetrics(registry, { players, queue });
  const prefetcher = new Prefetcher({
    bus,
    players,
    queue,
    media,
    cache,
    clock: systemClock,
    log: log.child('prefetch'),
    count: config.media.prefetch,
  });
  // The search is made after the resolver, whose lookup slots it shares; the resolver asks it for picked results.
  let search: Search | null = null;
  // One check of addresses for everything that adds a track (a typed address, a playlist's entries, autoplay's picks).
  const checkAddress = config.media.allowPrivate ? null : publicAddressesOnly();
  const resolver = new Resolver({
    ytdlp,
    tracks: store.tracks,
    log: log.child('lookup'),
    ...(checkAddress ? { checkAddress } : {}),
    watch: alerts,
    // What YouTube says a recording is, kept for finding its lyrics.
    music: store.music,
    recent: async (source) => (await search?.recent(source)) ?? null,
  });
  search = new Search({ ytdlp, slots: resolver, log: log.child('search'), cache: sharedCache });
  // jukecord's own requests (Deezer, Spotify, Apple Music, a file attached in Discord): public addresses only.
  const fetchOut = publicFetch({ allowPrivate: config.media.allowPrivate });
  // Lookups that come in lists (an imported playlist, a link's tracks), three at a time across every list.
  const batch = new BatchLookups();
  const links = new Links({
    fetch: fetchOut,
    ytdlp,
    tracks: store.tracks,
    batch,
    log: log.child('links'),
    services: config.links.services,
    spotify: config.links.spotify,
    cache: sharedCache,
  });
  // A track when a queue runs out, for the servers that turn autoplay on.
  const autoplay = new Autoplay({
    bus,
    players,
    queue,
    store,
    lanes,
    slots: resolver,
    ytdlp,
    ...(checkAddress ? { checkAddress } : {}),
    clock: systemClock,
    log: log.child('autoplay'),
    trackMaxMs: config.media.trackMaxMs,
  });
  // The tracks' covers, fetched once into the cache by the same address rule as yt-dlp's (src/media/covers.ts).
  const covers = new Covers({ cache, log: log.child('covers'), allowPrivate: config.media.allowPrivate });
  // Lyrics from LRCLIB, unless turned off: its requests go through the same address guard as yt-dlp's, and say what
  // asks (LRCLIB wants a client's name, version and home).
  const lyrics = config.lyrics
    ? new Lyrics({
        lyrics: store.lyrics,
        music: store.music,
        lookup: new LrclibClient({
          get: outbound({ proxy: egress?.url ?? null }),
          userAgent: `jukecord/${VERSION} (https://github.com/kanggu12/jukecord)`,
        }),
        log: log.child('lyrics'),
      })
    : null;
  // Who listens in each server, for the votes to skip: the people in the bot's voice channel and the people listening
  // in browsers, filled in once the bot and the web server below are made.
  const audience = {
    voice: (_guildId: string): readonly string[] => [],
    browsers: (_guildId: string): readonly string[] => [],
  };
  const votes = new SkipVotes({
    players,
    bus,
    clock: systemClock,
    log: log.child('votes'),
    lanes,
    // Asked when a vote is cast or counted again, long after the actions below exist.
    applies: (guildId) => actions.voteSkipApplies(guildId),
    listening: (guildId) => new Set([...audience.voice(guildId), ...audience.browsers(guildId)]),
  });
  const actions = new Actions({
    store,
    queue,
    players,
    lanes,
    resolver,
    log: log.child('actions'),
    startedAt: Date.now(),
    queueMax: config.queueMax,
    trackMaxMs: config.media.trackMaxMs,
    lyrics,
    votes,
    bus,
    search,
    autoplay,
    ...(checkAddress ? { checkAddress } : {}),
    batch,
    links,
  });

  const restored = await players.restoreAll(store.tracks, store.playerState);
  if (restored > 0) log.info('restored what was playing before the restart, paused', { servers: restored });
  prefetcher.start();
  // After the restore: a restored player's queue is looked at when it plays on, not all at once at the start.
  autoplay.start();

  // The bot is made before the web server (whose logins ask it about members) and started after it, so the panel
  // answers while Discord connects.
  const bot = config.discord.token
    ? new Bot({
        token: config.discord.token,
        actions,
        players,
        bus,
        ffmpeg,
        settings: store.settings,
        discord: store.discord,
        users: store.users,
        voiceIdleMs: config.voice.idleMs,
        log: log.child('discord'),
        panelUrl: config.publicUrl,
        voiceChannels: store.voiceChannels,
        // Files attached to /playlist import, from Discord's public addresses (the address rule as yt-dlp's).
        fetch: fetchOut,
      })
    : null;
  const directory = (): Directory | null => bot;
  if (bot) actions.setVoice(bot.voice, () => bot.ready(), bot);
  // Discord's gateway and the voice connections; without a bot, only that it is not connected.
  discordMetrics(registry, {
    connected: () => bot?.ready() ?? false,
    gateway: () => bot?.gateway() ?? null,
    guilds: () => bot?.guilds().length ?? 0,
    voice: () => bot?.voice.states() ?? new Map(),
  });
  // Whether jukecord can serve, part by part (/readyz and the metrics): the parts it cannot serve without (a core's
  // bus by its own ping), and the ones it reports without depending on them (Discord, when there is a bot, and the
  // media programs).
  const health = new Health({
    parts: [
      databasePart(store),
      transport ? transportPart(transport) : busPart('in-process'),
      cachePart(sharedCache),
      ...(bot ? [discordPart(() => bot.gateway())] : []),
      toolPart('ffmpeg', tools, () => ffmpeg.about()),
      toolPart('yt-dlp', tools, () => ytdlp.version()),
    ],
    discord: () => bot?.ready() ?? false,
    metrics: registry,
  });
  // What runs: the version, this process's role (all of it, or a split jukecord's core) and its backends.
  describeService(registry, {
    version: VERSION,
    role: config.role,
    database: store.sql.dialect,
    bus: transport?.kind ?? 'in-process',
    cache: sharedCache.kind,
  });
  // The bot posts the alerts (it waits for Discord after a start); browser-only, the log alone says them.
  alertSink = bot;
  // The watchdog's restart, read at the start: raised now that the bot is there to post it (raised before, it found no
  // one to post it and was dropped).
  if (lastRun) void alerts.raise(restartedAlert(lastRun.stillMs));
  // A disk that runs low is said once (and again once it had room again).
  alerts.watchDisk(config.dataDir);
  if (bot) audience.voice = (guildId) => bot.voice.people(guildId);

  // Logins. Without a public address the panel is reached on this machine, which is also where Discord sends people
  // back to after logging in.
  // Without a public address: this machine, on the port the browser here uses (compose maps its own; see config).
  const publicUrl = config.publicUrl ?? `http://localhost:${config.publishedPort}`;
  const access = new Access({ settings: store.settings, directory });
  const { clientId, clientSecret } = config.discord;
  // The daily backups' schedule, made below; the self-check asks it for its last failure.
  let schedule: BackupSchedule | null = null;
  // The self-check, of this process's parts; `discordLogin` is whether the panel lets people log in with Discord.
  const doctor = (discordLogin: boolean) =>
    runDoctor({
      config,
      store,
      cache,
      ytdlp,
      ffmpeg,
      discordReady: () => bot?.ready() ?? false,
      directory,
      discordLogin,
      // Asked when doctor runs, long after the schedule below is made.
      backupFailure: () => schedule?.lastFailure() ?? null,
    });
  // One process: the panel, the API and the live updates here. A core: what its edges need of it instead.
  let web: WebServer | null = null;
  let services: CoreServices | null = null;
  // Aborted when a core stops: an MP3 copy for an edge's browsers stops with it.
  const stopped = new AbortController();
  if (beat && transport) {
    const files = new MediaFiles({
      players,
      queue,
      store,
      cache,
      mp3: (track, signal) => media.mp3(track, signal),
      covers,
      searched: (context, address) => actions.searched(context, address),
      // Covers fetched for the edges' browsers, counted where the edges count every other rate (the shared cache).
      coverRate: new Limit(sharedCache, 'covers', COVERS, log.child('web')),
      // Audio for the edges' browsers waits while the core is behind (the one watch of the event loop, above).
      behind: () => loop.behind,
      stopping: stopped.signal,
    });
    const secret = config.internal.secret ?? '';
    // What the heartbeats tell the edges from now on (the first goes out once the services below answer).
    facts = () => ({
      discordMode: bot !== null,
      discordReady: bot?.ready() ?? false,
      self: bot?.self() ?? null,
      behind: loop.behind,
    });
    services = await startCoreServices({
      transport,
      names,
      beat,
      bus,
      actions,
      access,
      cache,
      files,
      backup: () => makeBackup(store, path.join(config.dataDir, 'backups'), config.backups.keep),
      logs: (query) => readLogs(path.join(config.dataDir, 'logs'), query, config.log.files),
      doctor,
      // Connections an edge turned away at a cap are jukecord's trouble, told to the alerts channels.
      turnedAway: (away) => void alerts.raise(turnedAwayAlert(away)),
      health,
      behind: () => loop.behind,
      host: config.host,
      port: config.port,
      internal: { port: config.internal.port, secret },
      registry,
      metricsToken: config.metrics.token,
      log: log.child('core'),
    });
  } else {
    // Logging in through the host's identity provider (OIDC), when it is set up: the provider sends people back to the
    // public address, and after logging out there to the login page.
    const oidcSettings = config.auth.oidc;
    const oidc = oidcSettings
      ? new OidcLogin({
          settings: oidcSettings,
          redirectUri: `${publicUrl}/auth/sso/callback`,
          afterLogout: `${publicUrl}/login`,
          cache: sharedCache,
          log: log.child('sso'),
        })
      : null;
    // Logging in with an account of the host's directory (LDAP, Active Directory), when it is set up.
    const ldap = config.auth.ldap ? new LdapLogin({ settings: config.auth.ldap, log: log.child('directory') }) : null;
    const auth = new Auth({
      store,
      hostToken: ensureHostToken(config.dataDir),
      secureCookies: publicUrl.startsWith('https://'),
      oauth: clientId && clientSecret ? { clientId, clientSecret, redirectUri: `${publicUrl}/auth/callback` } : null,
      // The login links not used yet and the failed logins: on the shared cache (this process's memory by default).
      cache: sharedCache,
      oidc,
      ldap,
      log: log.child('auth'),
      // Every login counted by its way in and how it went (jukecord_logins_total).
      metrics: registry,
    });
    web = await createWebServer({
      host: config.host,
      port: config.port,
      publicUrl,
      trustProxy: config.trustProxy,
      panelDir: PANEL_DIR,
      bus,
      players,
      queue,
      cache,
      mp3: (track, signal) => media.mp3(track, signal),
      covers,
      log: log.child('web'),
      // Open panels at once (JUKECORD_LIVE_MAX); the caps per login and per address stay at their defaults.
      live: { total: config.liveMax },
      // Behind when the event loop is (the one watch above), so the web server keeps no watch of its own.
      behind: () => loop.behind,
      sharedCache,
      metrics: registry,
      metricsToken: config.metrics.token,
      health,
      // Connections turned away at a cap are jukecord's trouble, told to the alerts channels.
      turnedAway: (away) => void alerts.raise(turnedAwayAlert(away)),
      deps: {
        actions,
        access,
        auth,
        store,
        presenter: new Presenter(store.users),
        directory,
        publicUrl,
        logDir: path.join(config.dataDir, 'logs'),
        logFiles: config.log.files,
        backupDir: path.join(config.dataDir, 'backups'),
        backupKeep: config.backups.keep,
        loginSettings: config.auth,
        // The login settings' tests read the environment jukecord started with, under the values a test brings.
        loginChecks: new LoginChecks({
          env: process.env,
          cwd: process.cwd(),
          redirectUri: `${publicUrl}/auth/sso/callback`,
          afterLogout: `${publicUrl}/login`,
          log: log.child('auth-test'),
        }),
        discordMode: bot !== null,
        doctor: () => doctor(auth.discordLogin),
      },
    });
  }
  // Who listens in browsers: this process's live updates, or the edges' reports added up by the core.
  const hub = web?.hub ?? null;
  const listenersIn = (guildId: string): number =>
    hub ? hub.listeners(guildId).count : (services?.audience.count(guildId) ?? 0);
  // A playing server that nobody hears anywhere (the bot not in its voice channel, no browser playing along) pauses
  // after a while, instead of fetching and counting plays for nobody (JUKECORD_REST_AFTER).
  const rest = new Rest({
    bus,
    players,
    lanes,
    inVoice: (guildId) => (bot ? bot.voice.channel(guildId) !== null : false),
    listeners: listenersIn,
    clock: systemClock,
    afterMs: config.restAfterMs,
    log: log.child('rest'),
  });
  rest.start();

  // A backup every day at the host's time of day (JUKECORD_BACKUP_AT), when one is set.
  schedule = config.backups.at
    ? new BackupSchedule({
        store,
        dir: path.join(config.dataDir, 'backups'),
        keep: config.backups.keep,
        at: config.backups.at,
        clock: systemClock,
        log: log.child('backups'),
        alerts,
      })
    : null;
  schedule?.start();

  // A revoked listening link ends its guests' live connections at once, whichever way it was revoked (on every edge).
  actions.setEndGuests((linkId) => (hub ? hub.endGuests(linkId) : services?.endGuests(linkId)));
  audience.browsers = (guildId) => (hub ? hub.listeningPeople(guildId) : (services?.audience.people(guildId) ?? []));
  // Stopping: save where every server is, leave voice, close the database, in that order. Set up before the panel
  // and Discord start, so a stop during a slow Discord login still saves the positions.
  let stopping = false;
  const stop = (signal: string, code = 0): void => {
    if (stopping) return;
    stopping = true;
    log.info('stopping', { signal });
    // Ten seconds to stop cleanly; a stuck network call must not keep a container from restarting.
    setTimeout(() => {
      log.error('stopping took longer than 10 s; exiting anyway');
      process.exit(1);
    }, 10_000).unref();
    prefetcher.stop();
    // Covers being fetched stop with jukecord (each would end by its own time limit otherwise).
    covers.stop();
    // Leaving voice below is jukecord stopping, not nobody listening.
    rest.stop();
    alerts.stop();
    schedule?.stop();
    // Where every server is, saved first (each in its server's turn, after a change under way); a failure of that is
    // jukecord's own trouble, thrown as before. Then the panels are told (they reconnect to the next jukecord; a
    // core's edges hear its goodbye and tell theirs), then Discord, then the database.
    void players.checkpointAll().then(
      () =>
        (web ? web.close() : (services?.stop() ?? Promise.resolve()))
          .catch(() => {})
          .then(() => {
            stopped.abort();
          })
          .then(() => bot?.stop())
          .then(() => egress?.close())
          // A daily backup being written is let finish (within the ten seconds): cut off, it is no backup.
          .then(() => schedule?.idle())
          .finally(() => {
            // Closed once no transaction holds it, with the shared cache. A core gives its lease back last, once it
            // has left Discord and its database: a core waiting for the lease never meets this one there. Then out.
            void Promise.allSettled([store.close(), sharedCache.close()])
              .then(() => beat?.release())
              .catch(() => {})
              .then(() => transport?.close())
              .catch(() => {})
              .finally(() => process.exit(code));
          }),
      throwFromTimer,
    );
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
  // This core can no longer be sure it holds the lease (another took it, or the bus was out of reach for as long as
  // the lease lasts): it stops, and its restart policy starts it again, to wait for the lease.
  lostLease = () => stop('this core no longer holds its lease', 1);
  // A crash saves where every server is too, so a restart comes back there (best effort: the crash may be in that).
  crashCheckpoint = () => players.checkpointAll();

  if (web) {
    await web.listen();
    log.info('the panel and the API are up', { listen: `${config.host}:${config.port}`, open: publicUrl });
  }
  // A main thread that stops answering for half a minute ends the process, so the restart policy starts it again
  // (Docker restarts what exits, not what hangs).
  startWatchdog(30_000, watchdogMark);

  if (bot) {
    // A stop during the login ends the login too; that is the stop, not a failure to start.
    await bot.start().catch((error: unknown) => {
      if (!stopping) throw error;
    });
  } else {
    log.info('no Discord token (JUKECORD_DISCORD_TOKEN): running browser-only');
  }
  return 0;
}

/**
 * An edge: the panel, the API, the live updates, logins and the browsers' audio, over the core (roles/edge.ts). It
 * opens the database (logins are its rows), the shared cache (the rates, the login links and failed logins, the SSO
 * logins under way) and the bus, and nothing of the music. Its numbers are this process's own: the web server's,
 * the bus's, the shared cache's and the runtime's (the music's are the core's).
 */
async function runEdge(
  config: Config,
  log: ReturnType<typeof createLogger>,
  registry: MetricsRegistry,
  loop: EventLoop,
): Promise<number> {
  const name = serviceId('edge');
  const transport = await RedisTransport.open(config.bus.url ?? '', { log: log.child('bus'), service: name });
  // The database every service shares, opened as one process opens it (see main).
  let store: Store;
  try {
    store = await openStore(config.database.address, {
      pool: config.database.pool,
      log: log.child('database'),
      report: databaseReport(registry),
    });
  } catch (error) {
    if (!(error instanceof ConnectionError)) throw error;
    log.error('jukecord cannot reach its database', { reason: error.message });
    await transport.close();
    return 1;
  }
  // The shared cache, on the bus's server unless JUKECORD_CACHE_URL says otherwise: what the edges count and keep
  // together, so a login link made on one edge works on another and a login through SSO started on one ends on another.
  const sharedCache = await openCache({
    url: config.cacheUrl,
    prefix: config.bus.prefix,
    log: log.child('cache'),
    service: name,
    report: sharedCacheReport(registry),
  });
  // This edge's own bus: the core's events are announced on it, and its live updates hear them there.
  const bus = new Bus((event, guildId, error) => log.error('a listener failed', { event, guild: guildId, error }));
  const publicUrl = config.publicUrl ?? `http://localhost:${config.publishedPort}`;
  const { clientId, clientSecret } = config.discord;
  // Logging in through the host's identity provider and directory happens where the browser is: here. The provider
  // sends people back to the public address, which may be any edge.
  const oidcSettings = config.auth.oidc;
  const oidc = oidcSettings
    ? new OidcLogin({
        settings: oidcSettings,
        redirectUri: `${publicUrl}/auth/sso/callback`,
        afterLogout: `${publicUrl}/login`,
        cache: sharedCache,
        log: log.child('sso'),
      })
    : null;
  const ldap = config.auth.ldap ? new LdapLogin({ settings: config.auth.ldap, log: log.child('directory') }) : null;
  // Logins are this edge's: sessions, tokens and listening links are rows every edge reads, and the login links and
  // failed logins are on the shared cache. The host token is this edge's own (its data folder), for the jukecord
  // command run beside it.
  const auth = new Auth({
    store,
    hostToken: ensureHostToken(config.dataDir),
    secureCookies: publicUrl.startsWith('https://'),
    oauth: clientId && clientSecret ? { clientId, clientSecret, redirectUri: `${publicUrl}/auth/callback` } : null,
    cache: sharedCache,
    oidc,
    ldap,
    log: log.child('auth'),
    // Every login counted by its way in and how it went (jukecord_logins_total).
    metrics: registry,
  });
  const edge = await startEdge({
    name,
    transport,
    names: busNames(config.bus.prefix),
    bus,
    store,
    auth,
    presenter: new Presenter(store.users),
    sharedCache,
    registry,
    coreUrl: config.internal.coreUrl ?? '',
    secret: config.internal.secret ?? '',
    fetchTimeoutMs: config.media.fetchTimeoutMs,
    web: {
      host: config.host,
      port: config.port,
      publicUrl,
      trustProxy: config.trustProxy,
      panelDir: PANEL_DIR,
      // Open panels at once on this edge (JUKECORD_LIVE_MAX counts per edge).
      live: { total: config.liveMax },
      logDir: path.join(config.dataDir, 'logs'),
      logFiles: config.log.files,
      backupDir: path.join(config.dataDir, 'backups'),
      backupKeep: config.backups.keep,
      // Behind when this edge's event loop is (the one watch, in main).
      behind: () => loop.behind,
      metricsToken: config.metrics.token,
      loginSettings: config.auth,
      // The login settings' tests run here, where logging in happens, with the environment this edge started with.
      loginChecks: new LoginChecks({
        env: process.env,
        cwd: process.cwd(),
        redirectUri: `${publicUrl}/auth/sso/callback`,
        afterLogout: `${publicUrl}/login`,
        log: log.child('auth-test'),
      }),
    },
    log,
  });
  // What runs: the version, an edge, and its backends.
  describeService(registry, {
    version: VERSION,
    role: 'edge',
    database: store.sql.dialect,
    bus: transport.kind,
    cache: sharedCache.kind,
  });
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log.info('stopping', { signal });
    // Ten seconds to stop cleanly, as one process has.
    setTimeout(() => {
      log.error('stopping took longer than 10 s; exiting anyway');
      process.exit(1);
    }, 10_000).unref();
    // The panels first (they reconnect to another edge), then the bus, then the database and the shared cache.
    void edge.web
      .close()
      .catch(() => {})
      .then(() => edge.stop())
      .finally(() => {
        void Promise.allSettled([transport.close(), store.close(), sharedCache.close()]).finally(() => process.exit(0));
      });
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
  await edge.web.listen();
  log.info('the panel and the API are up (an edge)', {
    listen: `${config.host}:${config.port}`,
    open: publicUrl,
    core: config.internal.coreUrl,
  });
  // A main thread that stops answering for half a minute ends this edge too, so its restart policy starts it again.
  startWatchdog(30_000, path.join(config.dataDir, 'watchdog.json'));
  return 0;
}

main().then(
  (code) => {
    if (code !== 0) process.exit(code);
  },
  (error: unknown) => {
    process.stderr.write(
      `jukecord could not start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  },
);
