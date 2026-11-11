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
import { Actions } from './app/actions.ts';
import { ConfigError, loadConfig } from './config.ts';
import { Bus } from './core/bus.ts';
import { systemClock } from './core/clock.ts';
import { Players } from './core/players.ts';
import { QueueService } from './core/queue.ts';
import { Bot } from './discord/bot.ts';
import { ConsoleSink, createLogger, FileSink } from './log.ts';
import { MediaCache } from './media/cache.ts';
import { Ffmpeg } from './media/ffmpeg.ts';
import { Prefetcher } from './media/prefetch.ts';
import { Media } from './media/preparer.ts';
import { Resolver } from './media/resolver.ts';
import { YtDlp } from './media/ytdlp.ts';
import { Store } from './store/store.ts';
import { VERSION } from './version.ts';

// The most tracks one playlist adds: enough for any party, small enough not to bury the queue.
const MAX_PLAYLIST = 500;

async function main(): Promise<number> {
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
    process.exit(1);
  });

  const store = Store.open(path.join(config.dataDir, 'jukecord.db'));
  const bus = new Bus();
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
  // yt-dlp runs YouTube's scripts with this very Node binary (the image has no other JavaScript runtime).
  const ytdlp = new YtDlp({
    cookies,
    binary: config.media.ytdlp,
    jsRuntime: `node:${process.execPath}`,
    timeoutMs: config.media.fetchTimeoutMs,
    maxPlaylist: MAX_PLAYLIST,
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
  const resolver = new Resolver({ ytdlp, tracks: store.tracks, log: log.child('lookup') });
  const actions = new Actions({
    store,
    queue,
    players,
    resolver,
    log: log.child('actions'),
    startedAt: Date.now(),
    queueMax: config.queueMax,
    trackMaxMs: config.media.trackMaxMs,
  });

  const restored = players.restoreAll(store.tracks, store.playerState);
  if (restored > 0) log.info('restored what was playing before the restart, paused', { servers: restored });
  prefetcher.start();

  let bot: Bot | null = null;
  if (config.discord.token) {
    bot = new Bot({
      token: config.discord.token,
      actions,
      players,
      bus,
      ffmpeg,
      settings: store.settings,
      discord: store.discord,
      voiceIdleMs: config.voice.idleMs,
      log: log.child('discord'),
      panelUrl: config.publicUrl,
    });
    const running = bot;
    actions.setVoice(running.voice, () => running.ready());
    await running.start();
  } else {
    log.info('no Discord token (JUKECORD_DISCORD_TOKEN): running browser-only');
  }

  // Stopping: save where every server is, leave voice, close the database, in that order.
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
    void (bot?.stop() ?? Promise.resolve()).finally(() => {
      store.close();
      process.exit(0);
    });
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
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
