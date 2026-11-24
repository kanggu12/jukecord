/**
 * The core's own port (JUKECORD_PORT): its health and its numbers, and nothing a browser uses (the edges serve those).
 * And the parts of a split jukecord's readiness that one process does not have: the bus over a network, and for an
 * edge, the core's heartbeat.
 *
 * /healthz answers while the process runs; /readyz answers what one process's does (src/app/health.ts: each part's
 * state, the database, the bus and the shared cache deciding); /metrics has the core's numbers (the players, the
 * queues, the media cache, Discord, the commands it served and how many edges report) for a scraper beside it or one
 * that shows the metrics token, by the same rule as the panel's port (src/metrics/http.ts).
 */
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import Fastify, { type FastifyInstance } from 'fastify';
import { busPart, type Health, type HealthPart } from '../app/health.ts';
import type { BusTransport } from '../bus/transport.ts';
import { MetricsGate, negotiate } from '../metrics/http.ts';
import type { MetricsRegistry } from '../metrics/registry.ts';

// The metrics' text, compressed off the main thread for a scraper that takes gzip (Prometheus always does).
const gzipped = promisify(zlib.gzip);

/** The bus over a network as a part of readiness: up, and answering a ping. */
export function transportPart(transport: BusTransport): HealthPart {
  return busPart(transport.kind, async () => (transport.up && (await transport.ping()) ? 'ok' : 'down'));
}

/** An edge's core as a part of readiness: its heartbeat heard lately (an edge without a core has nothing to serve). */
export function corePart(seen: () => boolean): HealthPart {
  return { name: 'core', required: true, check: () => (seen() ? 'ok' : 'down') };
}

export interface HealthServerOptions {
  readonly host: string;
  readonly port: number;
  /** The core's parts, as one process checks them. */
  readonly health: Health;
  readonly registry: MetricsRegistry;
  /** The token that lets a scraper read /metrics from anywhere (JUKECORD_METRICS_TOKEN); none: the address rule. */
  readonly metricsToken: string | null;
}

export interface HealthServer {
  readonly app: FastifyInstance;
  /** The token a scraper of /metrics shows from now on (the settings' JUKECORD_METRICS_TOKEN applies at once). */
  setMetricsToken(token: string | null): void;
  listen(): Promise<string>;
  close(): Promise<void>;
}

export function createHealthServer(options: HealthServerOptions): HealthServer {
  const app = Fastify({ logger: false, bodyLimit: 1024 });
  const gate = new MetricsGate(options.metricsToken);
  app.get('/healthz', async (_request, reply) => reply.type('text/plain').send('ok\n'));
  app.get('/readyz', async (_request, reply) => {
    const readiness = await options.health.read();
    return reply
      .code(readiness.ready ? 200 : 503)
      .header('cache-control', 'no-store')
      .send(readiness);
  });
  app.get('/metrics', async (request, reply) => {
    // The connection's own address decides, not a forwarded one, as on the panel's port.
    const verdict = gate.verdict(request.socket.remoteAddress ?? '', request.headers);
    if (verdict === 'hidden') return reply.code(404).send({ error: { code: 'not-found', message: 'no such path' } });
    if (verdict === 'wrong-token') {
      return reply
        .code(401)
        .header('www-authenticate', 'Bearer')
        .send({ error: { code: 'unauthorized', message: 'the metrics token is not right' } });
    }
    // Prometheus asks for OpenMetrics first; anything else gets the text format.
    const exposition = negotiate(request.headers.accept);
    const text = await options.registry.scrape(exposition.format);
    reply.type(exposition.contentType).header('cache-control', 'no-store').header('vary', 'accept, accept-encoding');
    if (!/\bgzip\b/.test(String(request.headers['accept-encoding'] ?? ''))) return reply.send(text);
    return reply.header('content-encoding', 'gzip').send(await gzipped(text));
  });
  app.setNotFoundHandler(async (request, reply) =>
    reply.code(404).send({ error: { code: 'not-found', message: `no such address: ${request.url.split('?')[0]}` } }),
  );
  return {
    setMetricsToken: (token) => gate.setToken(token),
    app,
    listen: () => app.listen({ host: options.host, port: options.port }),
    close: () => app.close(),
  };
}
