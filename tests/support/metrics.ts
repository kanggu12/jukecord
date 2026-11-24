/**
 * Every metric jukecord declares, in one registry, made the way main.ts makes them (each part declares its own when it
 * is built): for the tests of the whole surface, and for the tests that every query of the dashboard and every alert
 * names a metric that exists.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Players } from '../../src/core/players.ts';
import type { QueueService } from '../../src/core/queue.ts';
import { createLogger } from '../../src/log.ts';
import { MediaCache } from '../../src/media/cache.ts';
import type { Ffmpeg } from '../../src/media/ffmpeg.ts';
import { Media } from '../../src/media/preparer.ts';
import type { YtDlp } from '../../src/media/ytdlp.ts';
import { ToolWatch } from '../../src/metrics/media.ts';
import { MetricsRegistry } from '../../src/metrics/registry.ts';
import { diskMetrics, EventLoop, runtimeMetrics } from '../../src/metrics/runtime.ts';
import { describeService, discordMetrics, playerMetrics } from '../../src/metrics/service.ts';
import { httpMetrics, liveMetrics } from '../../src/metrics/web.ts';
import type { TrackRepository } from '../../src/store/store.ts';

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
  return {
    registry,
    close: () => {
      loop.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
