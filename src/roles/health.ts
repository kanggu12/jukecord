/**
 * The core's own port (JUKECORD_PORT): its health and its figures, and nothing a browser uses (the edges serve those).
 *
 * /healthz answers while the process runs; /readyz answers 200 while the core has its database and its bus, 503 with
 * the part that is missing otherwise; /metrics has the players, the queues and the media cache, what the core counts
 * of the bus and the shared cache, and how many edges report, for a scraper beside it: as on the panel's port, a
 * request that came through a proxy or from a public address gets the 404 any unknown path gets.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import type { Players } from '../core/players.ts';
import type { QueueService } from '../core/queue.ts';
import { isPrivateAddress } from '../media/address.ts';
import type { MediaCache } from '../media/cache.ts';
import type { MetricsRegistry } from '../metrics/registry.ts';
import { VERSION } from '../version.ts';
import { mediaMetrics, type ReadyParts } from '../web/server.ts';

export interface HealthServerOptions {
  readonly host: string;
  readonly port: number;
  /** The parts the core needs, each "ok" or what is missing (the database, the bus). */
  readonly parts: () => Promise<ReadyParts>;
  readonly discordReady: () => boolean;
  readonly players: Players;
  readonly queue: QueueService;
  readonly cache: MediaCache;
  readonly registry: MetricsRegistry;
  /** How many edges report who listens there. */
  readonly edges: () => number;
}

export interface HealthServer {
  readonly app: FastifyInstance;
  listen(): Promise<string>;
  close(): Promise<void>;
}

export function createHealthServer(options: HealthServerOptions): HealthServer {
  const app = Fastify({ logger: false, bodyLimit: 1024 });
  app.get('/healthz', async (_request, reply) => reply.type('text/plain').send('ok\n'));
  app.get('/readyz', async (_request, reply) => {
    const parts = await options.parts();
    const ready = Object.values(parts).every((state) => state === 'ok');
    return reply.code(ready ? 200 : 503).send({ ready, discord: options.discordReady(), parts: { ...parts } });
  });
  app.get('/metrics', async (request, reply) => {
    const peer = request.socket.remoteAddress ?? '';
    const forwarded = request.headers['x-forwarded-for'] !== undefined || request.headers.forwarded !== undefined;
    if (forwarded || !isPrivateAddress(peer)) {
      return reply.code(404).send({ error: { code: 'not-found', message: 'no such path' } });
    }
    const lines = [
      '# HELP jukecord_info The running version.',
      '# TYPE jukecord_info gauge',
      `jukecord_info{version="${VERSION}"} 1`,
      '# HELP jukecord_discord_connected Whether the bot is connected to Discord.',
      '# TYPE jukecord_discord_connected gauge',
      `jukecord_discord_connected ${options.discordReady() ? 1 : 0}`,
      ...(await mediaMetrics(options.players, options.queue, options.cache)),
      '# HELP jukecord_edges Edges that report who listens in their browsers.',
      '# TYPE jukecord_edges gauge',
      `jukecord_edges ${options.edges()}`,
      options.registry.render().trimEnd(),
    ];
    return reply.type('text/plain; version=0.0.4').send(`${lines.join('\n')}\n`);
  });
  app.setNotFoundHandler(async (request, reply) =>
    reply.code(404).send({ error: { code: 'not-found', message: `no such address: ${request.url.split('?')[0]}` } }),
  );
  return {
    app,
    listen: () => app.listen({ host: options.host, port: options.port }),
    close: () => app.close(),
  };
}
