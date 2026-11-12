/**
 * jukecord's entry point: reads the settings, opens the database and the cache, and starts the parts that are
 * configured (the Discord bot needs a token; without one jukecord runs browser-only).
 *
 * This file only connects parts; each of them is tested on its own. The order matters in two places: the players
 * are restored before the bot starts, so a slash command never meets a half-restored player, and on shutdown the
 * positions are saved before the database closes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Access } from './app/access.ts';
import { Actions, type Directory } from './app/actions.ts';
import { runDoctor } from './app/doctor.ts';
import { ConfigError, loadConfig } from './config.ts';
import { Bus } from './core/bus.ts';
import { systemClock } from './core/clock.ts';
import { Players } from './core/players.ts';
import { QueueService } from './core/queue.ts';
import { Bot } from './discord/bot.ts';
import { ConsoleSink, createLogger, FileSink } from './log.ts';
import { publicAddressesOnly } from './media/address.ts';
import { MediaCache } from './media/cache.ts';
import { startEgressGuard } from './media/egress.ts';
import { Ffmpeg } from './media/ffmpeg.ts';
import { Prefetcher } from './media/prefetch.ts';
import { Media } from './media/preparer.ts';
import { Resolver } from './media/resolver.ts';
import { Search } from './media/search.ts';
import { YtDlp } from './media/ytdlp.ts';
import { Store } from './store/store.ts';
import { VERSION } from './version.ts';
import { startWatchdog } from './watchdog.ts';
import { Auth, ensureHostToken } from './web/auth.ts';
import { Presenter } from './web/present.ts';
import { createWebServer, type WebServer } from './web/server.ts';

// The most tracks one playlist adds: enough for any party, small enough not to bury the queue.
const MAX_PLAYLIST = 500;

// The built panel, beside the source in a checkout and in the image (panel/dist, made by `npm run build`).
const PANEL_DIR = fileURLToPath(new URL('../panel/dist', import.meta.url));

// What a crash runs before exiting: saving the players' positions, once they exist (see main).
let crashCheckpoint: () => void = () => {};

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
      new ConsoleSink(),
      new FileSink({ dir: path.join(config.dataDir, 'logs'), maxBytes: config.log.maxBytes, files: config.log.files }),
    ],
  });
  for (const warning of config.warnings) log.warn(warning);
  log.info(`starting jukecord ${VERSION}`, {
    data: config.dataDir,
    discord: config.discord.token ? 'yes' : 'browser-only',
  });

  // A crash anywhere is logged with its stack before the process goes down; a stray rejected promise is logged and the
  // music goes on (each part already handles its own failures; this catches what slipped through).
  process.on('unhandledRejection', (reason) =>
    log.error('a promise was rejected and nobody handled it', { reason: String(reason) }),
  );
  process.on('uncaughtException', (error) => {
    log.error('jukecord stopped on an error it did not expect', { error });
    try {
      crashCheckpoint();
    } catch {
      // The positions could not be saved; the restart starts where the last save left them.
    }
    process.exit(1);
  });

  const store = Store.open(path.join(config.dataDir, 'jukecord.db'));
  // A listener that fails is logged with its server; the others still hear the change (see Bus).
  const bus = new Bus((event, guildId, error) => log.error('a listener failed', { event, guild: guildId, error }));
  const queue = new QueueService(store.queue, bus);
  const cache = new MediaCache({
    dir: path.join(config.dataDir, 'cache'),
    maxBytes: config.media.cacheMaxBytes,
    log: log.child('cache'),
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
  // yt-dlp runs YouTube's scripts with this very Node binary (the image has no other JavaScript runtime).
  const ytdlp = new YtDlp({
    proxy: egress?.url ?? null,
    cookies,
    binary: config.media.ytdlp,
    jsRuntime: `node:${process.execPath}`,
    timeoutMs: config.media.fetchTimeoutMs,
    maxPlaylist: MAX_PLAYLIST,
    cacheDir: path.join(config.dataDir, 'yt-dlp'),
  });
  const ffmpeg = new Ffmpeg(config.media.ffmpeg);
  const media = new Media({
    cache,
    ytdlp,
    ffmpeg,
    tracks: store.tracks,
    log: log.child('media'),
    timeoutMs: config.media.fetchTimeoutMs,
  });
  const players = new Players({
    queue,
    media,
    history: store.history,
    state: store.playerState,
    bus,
    clock: systemClock,
    log: log.child('player'),
    fetchTimeoutMs: config.media.fetchTimeoutMs,
  });
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
    recent: (source) => search?.recent(source) ?? null,
  });
  search = new Search({ ytdlp, slots: resolver, log: log.child('search') });
  const actions = new Actions({
    store,
    queue,
    players,
    resolver,
    log: log.child('actions'),
    startedAt: Date.now(),
    queueMax: config.queueMax,
    trackMaxMs: config.media.trackMaxMs,
    search,
  });

  const restored = players.restoreAll(store.tracks, store.playerState);
  if (restored > 0) log.info('restored what was playing before the restart, paused', { servers: restored });
  prefetcher.start();

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
      })
    : null;
  const directory = (): Directory | null => bot;
  if (bot) actions.setVoice(bot.voice, () => bot.ready(), bot);

  // Logins. Without a public address the panel is reached on this machine, which is also where Discord sends people
  // back to after logging in.
  // Without a public address: this machine, on the port the browser here uses (compose maps its own; see config).
  const publicUrl = config.publicUrl ?? `http://localhost:${config.publishedPort}`;
  const access = new Access({ settings: store.settings, directory });
  const { clientId, clientSecret } = config.discord;
  const auth = new Auth({
    store,
    hostToken: ensureHostToken(config.dataDir),
    secureCookies: publicUrl.startsWith('https://'),
    oauth: clientId && clientSecret ? { clientId, clientSecret, redirectUri: `${publicUrl}/auth/callback` } : null,
    log: log.child('auth'),
  });
  const web: WebServer = await createWebServer({
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
    log: log.child('web'),
    // Open panels at once (JUKECORD_LIVE_MAX); the caps per login and per address stay at their defaults.
    live: { total: config.liveMax },
    ready: () => store.db.isOpen,
    discordReady: () => bot?.ready() ?? false,
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
      discordMode: bot !== null,
      doctor: () =>
        runDoctor({
          config,
          store,
          cache,
          ytdlp,
          ffmpeg,
          discordReady: () => bot?.ready() ?? false,
          directory,
          discordLogin: auth.discordLogin,
        }),
    },
  });
  // Stopping: save where every server is, leave voice, close the database, in that order. Set up before the panel
  // and Discord start, so a stop during a slow Discord login still saves the positions.
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log.info('stopping', { signal });
    // Ten seconds to stop cleanly; a stuck network call must not keep a container from restarting.
    setTimeout(() => {
      log.error('stopping took longer than 10 s; exiting anyway');
      process.exit(1);
    }, 10_000).unref();
    prefetcher.stop();
    players.checkpointAll();
    // The panels are told first (they reconnect to the next jukecord), then Discord, then the database.
    void web
      .close()
      .catch(() => {})
      .then(() => bot?.stop())
      .then(() => egress?.close())
      .finally(() => {
        store.close();
        process.exit(0);
      });
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
  // A crash saves where every server is too, so a restart comes back there (best effort: the crash may be in that).
  crashCheckpoint = () => players.checkpointAll();

  await web.listen();
  log.info('the panel and the API are up', { listen: `${config.host}:${config.port}`, open: publicUrl });
  // A main thread that stops answering for half a minute ends the process, so the restart policy starts it again
  // (Docker restarts what exits, not what hangs).
  startWatchdog(30_000);

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
