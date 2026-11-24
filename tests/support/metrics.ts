/**
 * Every metric jukecord declares, in one registry, made the way main.ts makes them (each part declares its own when it
 * is built): for the tests of the whole surface, and for the tests that every query of the dashboard and every alert
 * names a metric that exists.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Health } from '../../src/app/health.ts';
import { busEvents, reportingEdges, servedCommands } from '../../src/bus/metrics.ts';
import type { Players } from '../../src/core/players.ts';
import type { QueueService } from '../../src/core/queue.ts';
import { createLogger } from '../../src/log.ts';
import { MediaCache } from '../../src/media/cache.ts';
import type { Ffmpeg } from '../../src/media/ffmpeg.ts';
import { Media } from '../../src/media/preparer.ts';
import type { YtDlp } from '../../src/media/ytdlp.ts';
import { databaseReport } from '../../src/metrics/database.ts';
import { ToolWatch } from '../../src/metrics/media.ts';
import { MetricsRegistry } from '../../src/metrics/registry.ts';
import { diskMetrics, EventLoop, runtimeMetrics } from '../../src/metrics/runtime.ts';
import { describeService, discordMetrics, playerMetrics } from '../../src/metrics/service.ts';
import { busReport, sharedCacheReport } from '../../src/metrics/services.ts';
import { httpMetrics, liveMetrics } from '../../src/metrics/web.ts';
import type { TrackRepository } from '../../src/store/store.ts';
import { OPERATIONS } from '../../src/web/api.ts';

/** The registry with every family, and what to stop and remove afterwards. */
export interface EveryFamily {
  readonly registry: MetricsRegistry;
  close(): void;
}

/** Builds a registry with every family jukecord declares. */
export function everyFamily(): EveryFamily {
  const registry = new MetricsRegistry();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukecord-metrics-'));
  const log = createLogger({ level: 'error', sinks: [] });
  const loop = new EventLoop();
  runtimeMetrics(registry, loop);
  diskMetrics(registry, dir);
  describeService(registry, { version: '0.0.0', role: 'all', database: 'sqlite', bus: 'in-process', cache: 'memory' });
  // The players and queues of no server, and a bot that is connected.
  playerMetrics(registry, {
    players: { all: () => [] } as unknown as Players,
    queue: { version: () => 0, size: async () => 0 } as unknown as QueueService,
  });
  discordMetrics(registry, {
    connected: () => true,
    gateway: () => ({ state: 'ready', pingMs: 40 }),
    guilds: () => 1,
    voice: () => new Map([['ready', 1]]),
  });
  // The media cache and the preparer declare theirs when they are made; the programs' runs, the web server and the
  // live updates through the functions they call.
  const cache = new MediaCache({ dir: path.join(dir, 'cache'), maxBytes: 64 * 1024 ** 2, log, metrics: registry });
  new Media({
    cache,
    ytdlp: {} as YtDlp,
    ffmpeg: {} as Ffmpeg,
    tracks: {} as TrackRepository,
    log,
    timeoutMs: 60_000,
    metrics: registry,
  });
  new ToolWatch(registry);
  httpMetrics(registry);
  liveMetrics(registry);
  // What the database executors, the bus adapters and the shared cache's adapters report into, with a connection read.
  databaseReport(registry).connections(() => ({ busy: 0, idle: 1, waiting: 0 }));
  busReport(registry, OPERATIONS).command('skip', 0.01, 'ok');
  sharedCacheReport(registry).entries(() => 0);
  // A split jukecord's own: the commands its core ran, the events on its bus, the edges reporting.
  servedCommands(registry);
  busEvents(registry);
  reportingEdges(registry).set(2);
  // Readiness, by parts.
  new Health({ parts: [], discord: () => true, metrics: registry });
  return {
    registry,
    close: () => {
      loop.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
