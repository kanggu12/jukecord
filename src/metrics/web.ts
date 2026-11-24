/**
 * The web server's numbers: every answer by its route's template and its status class, how long it took, and the live
 * connections (the panels' WebSockets) with what was sent on them.
 *
 * Routes are labelled by their template (`/api/v1/guilds/:guild/queue`), never by the address asked for, so a server,
 * a track or a typo in an address cannot make a series of its own: the panel's files and pages count as `static`, and
 * an address no route has as `unmatched`.
 */
import type { Counter, Gauge, Histogram, Metrics } from './registry.ts';

// The methods a label may name; any other counts as "other" (a client may send any word as its method).
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
// Where jukecord's own routes are: the API, logging in, and the health and metrics endpoints.
const OWN_ROUTE = /^\/(?:api\/|auth\/|healthz$|readyz$|metrics$)/;

/** The method as a label: one of the few HTTP has, or "other". */
export function methodLabel(method: string): string {
  return METHODS.has(method) ? method : 'other';
}

/**
 * The route as a label: its template for jukecord's own routes, `static` for the panel's files (each is a route of its
 * own, named by a file name that changes with every build) and for its pages, `unmatched` for an address nothing has.
 */
export function routeLabel(template: string | undefined, status: number): string {
  if (template !== undefined) return OWN_ROUTE.test(template) ? template : 'static';
  // No route matched: the not-found handler answered, with the panel's page for a browser (200) or a 404.
  return status === 404 ? 'unmatched' : 'static';
}

/** The class of a status as a label: 2xx, 3xx, 4xx, 5xx. */
export function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

/** What the web server counts for every answer. */
export interface HttpMetrics {
  /** How long each answer took, by method, route and status class. */
  readonly duration: Histogram;
  /** Answers by status class (the name 0.3 gave it, kept). */
  readonly responses: Counter;
}

/** Declares the web server's families. */
export function httpMetrics(metrics: Metrics): HttpMetrics {
  return {
    duration: metrics.histogram(
      'jukecord_http_request_duration_seconds',
      "How long jukecord took to answer, from the request's arrival to its answer's end, by method, route and status class.",
      ['method', 'route', 'class'],
    ),
    responses: metrics.counter('jukecord_http_responses_total', 'Answers given, by status class.', ['class']),
  };
}

/** What the live updates count. */
export interface LiveMetrics {
  /** Messages sent, by frame: text (JSON) or binary (gzip). */
  readonly messages: Counter;
  /** Bytes sent in those messages. */
  readonly bytes: Counter;
  /** Open live connections, and of those the browsers playing along. */
  readonly connections: Gauge;
  readonly listeners: Gauge;
}

/** Declares the live updates' families. */
export function liveMetrics(metrics: Metrics): LiveMetrics {
  return {
    messages: metrics.counter(
      'jukecord_panel_messages_total',
      'Messages sent on live connections, by frame: text (JSON) or binary (gzip).',
      ['frame'],
    ),
    bytes: metrics.counter('jukecord_panel_sent_bytes_total', 'Bytes sent in messages on live connections.'),
    connections: metrics.gauge('jukecord_panel_connections', 'Open live connections from panels.'),
    listeners: metrics.gauge('jukecord_browser_listeners', 'Browsers playing along.'),
  };
}
