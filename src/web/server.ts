/**
 * The web server: the API, the live updates, the audio for browsers, logging in, the health and metrics endpoints,
 * and the panel's files.
 *
 * The API's routes are registered from the operation table (src/web/api.ts); this file adds what every route shares:
 * who is calling, whether they may, the CSRF check for panel changes, turning errors into answers, and the security
 * headers. Nothing here knows about music; that all happens in the handlers and the actions behind them.
 */
import fs from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ActionError } from '../app/actions.ts';
import type { Bus } from '../core/bus.ts';
import type { Players } from '../core/players.ts';
import type { QueueService } from '../core/queue.ts';
import type { Track } from '../core/types.ts';
import type { Logger } from '../log.ts';
import { BusyError } from '../media/busy.ts';
import { MediaCache } from '../media/cache.ts';
import { StoreError } from '../store/store.ts';
import { VERSION } from '../version.ts';
import { API, API_PREFIX, OPERATIONS, type OperationName, type OperationSpec, type Permission } from './api.ts';
import { type Caller, CSRF_HEADER } from './auth.ts';
import { EventHub } from './events.ts';
import { HANDLERS, type HandlerDeps, type HandlerInput } from './handlers.ts';
import { openApiDocument } from './openapi.ts';

export interface WebServerOptions {
  readonly host: string;
  readonly port: number;
  /** Where people reach the panel, without a trailing slash (login links and Discord's way back are built on it). */
  readonly publicUrl: string;
  /** Whether to believe X-Forwarded-* headers (true, a hop count, or the proxies' addresses). */
  readonly trustProxy: boolean | number | string;
  /** The built panel (panel/dist), or null to serve only the API. */
  readonly panelDir: string | null;
  readonly deps: HandlerDeps;
  readonly bus: Bus;
  readonly players: Players;
  readonly queue: QueueService;
  readonly cache: MediaCache;
  /** Makes the MP3 copy of a cached track for browsers without Opus. */
  readonly mp3: (track: Track, signal: AbortSignal) => Promise<string | null>;
  readonly log: Logger;
  /** Whether jukecord can serve requests (for /readyz). */
  readonly ready: () => boolean;
  readonly discordReady: () => boolean;
}

export interface WebServer {
  readonly app: FastifyInstance;
  readonly hub: EventHub;
  /** Starts listening; returns the address. */
  listen(): Promise<string>;
  close(): Promise<void>;
}

// The HTTP status of each error code.
const STATUS: Readonly<Record<string, number>> = {
  invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  'not-found': 404,
  conflict: 409,
  'too-many': 429,
  unavailable: 503,
};

// The answer for an error, in the one shape every API error has.
function failure(reply: FastifyReply, code: string, message: string): FastifyReply {
  return reply.code(STATUS[code] ?? 500).send({ error: { code, message } });
}

// OpenAPI paths use {name}; Fastify uses :name.
function routePath(spec: OperationSpec): string {
  return `${API_PREFIX}${spec.path.replace(/\{(\w+)\}/g, ':$1')}`;
}

// A plain copy of a schema for Fastify (TypeBox keeps a hidden key that the validator need not see).
function plain<T>(schema: T | undefined): T | undefined {
  return schema === undefined ? undefined : (JSON.parse(JSON.stringify(schema)) as T);
}

// Whether a caller may call an operation with this access (the server's own rules come later, in the action).
function permission(access: Permission, caller: Caller | null): 'ok' | 'unauthorized' | 'forbidden' {
  if (access === 'public') return 'ok';
  if (!caller) return 'unauthorized';
  if (access === 'read') return 'ok';
  if (access === 'control') return caller.scope === 'read' ? 'forbidden' : 'ok';
  if (access === 'admin') return caller.scope === 'admin' ? 'ok' : 'forbidden';
  return caller.principal.kind === 'host' && caller.scope === 'admin' ? 'ok' : 'forbidden';
}

export async function createWebServer(options: WebServerOptions): Promise<WebServer> {
  const { deps, log } = options;
  const { auth } = deps;
  // A hop count becomes "trust the nearest n proxies"; Fastify's types take that only as a function.
  const hops = options.trustProxy;
  const trustProxy =
    typeof hops === 'number' ? (_address: string, hop: number) => hop < hops : (hops as boolean | string);
  const app = Fastify({
    logger: false,
    trustProxy,
    // Requests are small JSON; a megabyte body is a mistake or an attack.
    bodyLimit: 64 * 1024,
    ajv: {
      // Unknown body fields are dropped (the schemas say additionalProperties: false); query strings become numbers.
      customOptions: { removeAdditional: true, coerceTypes: 'array', useDefaults: true, allErrors: false },
    },
  });
  const hub = new EventHub({
    bus: options.bus,
    actions: deps.actions,
    access: deps.access,
    presenter: deps.presenter,
    users: deps.store.users,
    log: log.child('events'),
    stillValid: (caller) => auth.stillValid(caller),
  });

  // Responses by status class, for /metrics.
  const responses = new Map<string, number>();
  app.addHook('onResponse', async (_request, reply) => {
    const group = `${Math.floor(reply.statusCode / 100)}xx`;
    responses.set(group, (responses.get(group) ?? 0) + 1);
  });

  // Security headers on everything; the content security policy on pages.
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header('x-frame-options', 'DENY');
    const type = String(reply.getHeader('content-type') ?? '');
    if (type.startsWith('text/html')) {
      // The WebSocket address is named outright: older Safari does not count ws: as 'self'.
      const host = String(request.headers.host ?? '').replace(/[^A-Za-z0-9.:[\]-]/g, '');
      const sockets = host ? ` ws://${host} wss://${host}` : '';
      reply.header(
        'content-security-policy',
        [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self'",
          // Thumbnails come from the sites tracks are on (YouTube, SoundCloud, ...) and avatars from Discord.
          "img-src 'self' data: https:",
          "media-src 'self' blob:",
          `connect-src 'self'${sockets}`,
          "font-src 'self'",
          "object-src 'none'",
          "base-uri 'none'",
          "frame-ancestors 'none'",
          "form-action 'self'",
        ].join('; '),
      );
    }
    // API answers change with every request; nothing between the browser and jukecord should keep them.
    if (request.url.startsWith(API_PREFIX) && !reply.getHeader('cache-control'))
      reply.header('cache-control', 'no-store');
    return payload;
  });

  // Every error becomes {"error":{"code","message"}} with the matching status; only unexpected ones are logged.
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ActionError) return failure(reply, error.code, error.message);
    if (error instanceof StoreError) return failure(reply, 'invalid', error.message);
    const fastifyError = error as { validation?: unknown; statusCode?: number; message: string };
    if (fastifyError.validation) return failure(reply, 'invalid', fastifyError.message);
    // Fastify's own refusals (bad JSON, body too large, wrong content type) carry a 4xx status.
    if (fastifyError.statusCode && fastifyError.statusCode >= 400 && fastifyError.statusCode < 500) {
      return reply.code(fastifyError.statusCode).send({ error: { code: 'invalid', message: fastifyError.message } });
    }
    log.error('a request failed', { method: request.method, url: request.url.split('?')[0], error });
    return reply
      .code(500)
      .send({ error: { code: 'internal', message: 'something went wrong in jukecord (see its log)' } });
  });

  await app.register(fastifyWebsocket, {
    options: {
      maxPayload: 4096,
      // Messages over 1 KiB go compressed to a browser that offers it: a queue of a thousand tracks is about 330 KiB as
      // JSON and 60 KiB compressed, sent to every listener whenever the queue changes. No zlib context is kept between
      // messages, so a connection holds no compression memory while it waits.
      perMessageDeflate: { threshold: 1024, serverNoContextTakeover: true, clientNoContextTakeover: true },
    },
  });
  // The panel's files when it is built; otherwise only sendFile (for the audio) is set up.
  const panelDir =
    options.panelDir && fs.existsSync(path.join(options.panelDir, 'index.html')) ? options.panelDir : null;
  await app.register(fastifyStatic, {
    root: panelDir ?? options.cache.dir,
    serve: panelDir !== null,
    prefix: '/',
    // Each file is a route; anything else falls through to the panel's page (see the not-found handler).
    wildcard: false,
    index: false,
    // Revalidated on every load (ETag), so a new version is seen at once without renaming files.
    cacheControl: false,
    // The build's .br and .gz copies, sent to a browser that takes them (scripts/build-panel.ts makes them).
    preCompressed: true,
    setHeaders: (reply) => reply.header('cache-control', 'no-cache'),
  });

  // Who is calling. A credential that does not work counts as a failed login for its address, and a dead session
  // cookie is removed so the browser stops sending it.
  const identify = (request: FastifyRequest, reply?: FastifyReply): Caller | null => {
    const caller = auth.identify({ authorization: request.headers.authorization, cookie: request.headers.cookie });
    if (!caller && (request.headers.authorization || request.headers.cookie?.includes('jukecord_session='))) {
      auth.limiter.fail(request.ip);
      if (reply && request.headers.cookie?.includes('jukecord_session='))
        reply.header('set-cookie', auth.endSession(null));
    }
    return caller;
  };

  // The API, one route per operation.
  for (const name of OPERATIONS) {
    const spec: OperationSpec = API[name];
    const handler = HANDLERS[name] as (input: HandlerInput<OperationSpec>) => unknown;
    app.route({
      method: spec.method,
      url: routePath(spec),
      schema: {
        ...(spec.params ? { params: plain(spec.params) } : {}),
        ...(spec.query ? { querystring: plain(spec.query) } : {}),
        ...(spec.body ? { body: plain(spec.body) } : {}),
        response: { 200: plain(spec.response) },
      },
      handler: async (request, reply) => {
        if (auth.limiter.blocked(request.ip))
          return failure(reply, 'too-many', 'too many failed logins; wait ten minutes');
        const caller = identify(request, reply);
        const verdict = permission(spec.access, caller);
        if (verdict === 'unauthorized') return failure(reply, 'unauthorized', 'log in first');
        if (verdict === 'forbidden') {
          return failure(
            reply,
            'forbidden',
            `this needs ${spec.access === 'host' ? 'the host' : `a ${spec.access} token`}`,
          );
        }
        // A panel change must carry the session's CSRF token (see src/web/auth.ts).
        if (
          caller &&
          spec.method !== 'GET' &&
          !auth.csrfOk(caller, request.headers[CSRF_HEADER] as string | undefined)
        ) {
          return failure(reply, 'forbidden', "the change came without the panel's CSRF token; reload the panel");
        }
        const params = (request.params ?? {}) as Record<string, unknown>;
        const context =
          typeof params.guild === 'string' && caller ? await deps.access.context(caller.principal, params.guild) : null;
        return handler({
          params: params as never,
          query: (request.query ?? {}) as never,
          body: (request.body ?? {}) as never,
          caller,
          context: context as never,
          deps,
        });
      },
    });
  }

  // The audio of a prepared track, for browsers playing along. Only a track that a server the caller can open is
  // playing or has queued: a login cannot walk the track numbers and make ffmpeg convert the whole cache. Range
  // requests let a browser seek without downloading it all.
  app.get<{ Params: { guild: string; track: string }; Querystring: { format?: string } }>(
    `${API_PREFIX}/guilds/:guild/tracks/:track/audio`,
    async (request, reply) => {
      // An address that failed too often is refused here too, before its credential is tried again.
      if (auth.limiter.blocked(request.ip))
        return failure(reply, 'too-many', 'too many failed logins; wait ten minutes');
      const caller = identify(request, reply);
      if (!caller) return failure(reply, 'unauthorized', 'log in first');
      const context = await deps.access.context(caller.principal, request.params.guild);
      const id = Number(request.params.track);
      const current = options.players.get(context.guildId).snapshot().track;
      const queued = current?.id === id || options.queue.list(context.guildId).some((item) => item.track.id === id);
      const track = Number.isInteger(id) && id > 0 && queued ? deps.store.tracks.get(id) : null;
      if (!track) return failure(reply, 'not-found', 'that track is not playing or queued in this server');
      const key = MediaCache.keyOf(track.source);
      if (!options.cache.has(key)) return failure(reply, 'conflict', 'the track is not prepared yet');
      let file = options.cache.opusPath(key);
      if (request.query.format === 'mp3') {
        // Shared by everyone asking at once and not tied to this request: a second browser may be waiting for it.
        let mp3: string | null;
        try {
          mp3 = await options.mp3(track, AbortSignal.timeout(120_000));
        } catch (error) {
          if (error instanceof BusyError) return failure(reply, 'unavailable', error.message);
          throw error;
        }
        if (!mp3) return failure(reply, 'conflict', 'the track is not prepared yet');
        file = mp3;
      }
      // A track's file does not change once made; the browser may keep it for a day.
      return reply.header('cache-control', 'private, max-age=86400').sendFile(path.basename(file), path.dirname(file));
    },
  );

  // Live updates. A browser's cookie is only accepted from the panel's own pages (another site could otherwise open
  // a connection with it).
  app.get<{ Querystring: { guild?: string } }>(`${API_PREFIX}/events`, { websocket: true }, (socket, request) => {
    // A blocked address is told to come back later (1013), which a panel takes as "reconnect after a wait".
    if (auth.limiter.blocked(request.ip)) {
      socket.close(1013, 'too many failed logins; wait ten minutes');
      return;
    }
    const caller = identify(request);
    if (!caller) {
      socket.close(4401, 'log in first');
      return;
    }
    if (caller.via === 'session' && !sameOrigin(request, options.publicUrl)) {
      socket.close(4403, 'connections come from the panel only');
      return;
    }
    hub.attach(socket, caller, typeof request.query.guild === 'string' ? request.query.guild : undefined);
  });

  // The OpenAPI document of the API.
  app.get(`${API_PREFIX}/openapi.json`, async () => openApiDocument(API_PREFIX));

  // Logging in with Discord: off to Discord, and back.
  app.get<{ Querystring: { next?: string } }>('/auth/login', async (request, reply) => {
    if (!auth.discordLogin) return reply.redirect('/login?error=no-discord-login');
    const started = auth.oauthStart(typeof request.query.next === 'string' ? request.query.next : '/');
    return reply.header('set-cookie', started.cookie).redirect(started.location);
  });
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/auth/callback',
    async (request, reply) => {
      reply.header('set-cookie', auth.clearOAuthCookie());
      const { code, state, error } = request.query;
      if (error || !code || !state) return reply.redirect('/login?error=cancelled');
      if (auth.limiter.blocked(request.ip)) return reply.redirect('/login?error=too-many');
      try {
        const { person, next } = await auth.oauthFinish(code, state, request.headers.cookie);
        deps.store.users.upsert(person);
        // Asked afresh at every login: someone refused a minute ago may have joined the server since.
        deps.access.forget(person.id);
        // Only people in a server the bot is in get in: the panel is for those servers.
        const guilds = await deps.access.guilds({ kind: 'user', userId: person.id });
        if (guilds.length === 0) return reply.redirect('/login?error=not-a-member');
        reply.header('set-cookie', [auth.clearOAuthCookie(), auth.startSession({ kind: 'user', userId: person.id })]);
        log.info('logged in with Discord', { user: person.name });
        return reply.redirect(next);
      } catch (failure) {
        // Just started and not connected to Discord yet: not the person's failure, and not counted as one.
        if (failure instanceof ActionError && failure.code === 'unavailable')
          return reply.redirect('/login?error=connecting');
        auth.limiter.fail(request.ip);
        log.info('a Discord login failed', { reason: failure instanceof Error ? failure.message : String(failure) });
        return reply.redirect('/login?error=failed');
      }
    },
  );
  // A one-time login link from `jukecord open`: the browser becomes the host.
  app.get<{ Params: { code: string } }>('/auth/link/:code', async (request, reply) => {
    if (auth.limiter.blocked(request.ip)) return reply.redirect('/login?error=too-many');
    if (!auth.useLink(request.params.code)) {
      auth.limiter.fail(request.ip);
      return reply.redirect('/login?error=link');
    }
    log.info('logged in with a login link');
    return reply.header('set-cookie', auth.startSession({ kind: 'host' })).redirect('/');
  });
  app.post('/auth/logout', async (request, reply) => {
    if (auth.limiter.blocked(request.ip)) return failure(reply, 'too-many', 'too many failed logins; wait ten minutes');
    const caller = identify(request);
    if (caller && !auth.csrfOk(caller, request.headers[CSRF_HEADER] as string | undefined)) {
      return failure(reply, 'forbidden', "the logout came without the panel's CSRF token");
    }
    if (caller?.principal.kind === 'user') deps.access.forget(caller.principal.userId);
    // This browser's live connection ends with its login.
    if (caller?.sessionHash) hub.end((other) => other.sessionHash === caller.sessionHash);
    return reply.header('set-cookie', auth.endSession(caller)).code(204).send();
  });

  // Health: alive (the process answers), ready (it can serve), and the figures for Prometheus.
  app.get('/healthz', async (_request, reply) => reply.type('text/plain').send('ok\n'));
  app.get('/readyz', async (_request, reply) => {
    const ready = options.ready();
    return reply.code(ready ? 200 : 503).send({ ready, discord: options.discordReady() });
  });
  app.get('/metrics', async (_request, reply) =>
    reply.type('text/plain; version=0.0.4').send(metrics(options, hub, responses)),
  );

  // Anything else: the panel's page for a browser asking for a page (the panel draws /stats, /login ... itself), a
  // JSON 404 for the rest.
  app.setNotFoundHandler(async (request, reply) => {
    const wantsPage = request.method === 'GET' && String(request.headers.accept ?? '').includes('text/html');
    if (wantsPage && !request.url.startsWith('/api/')) {
      if (panelDir) return reply.header('cache-control', 'no-cache').sendFile('index.html', panelDir);
      return reply
        .type('text/html; charset=utf-8')
        .send('<!doctype html><title>jukecord</title><p>The panel is not built here (npm run build).</p>');
    }
    return failure(reply, 'not-found', `no such address: ${request.method} ${request.url.split('?')[0]}`);
  });

  return {
    app,
    hub,
    listen: () => app.listen({ host: options.host, port: options.port }),
    close: async () => {
      hub.close();
      await app.close();
    },
  };
}

// Whether a request comes from the panel's own origin: the address it was sent to, or the public address.
function sameOrigin(request: FastifyRequest, publicUrl: string): boolean {
  const origin = request.headers.origin;
  // Programs do not send Origin; browsers always do on WebSocket. No Origin means no browser, so no cookie risk.
  if (!origin) return true;
  const here = `${request.protocol}://${request.headers.host ?? ''}`;
  return origin === here || origin === new URL(publicUrl).origin;
}

// The Prometheus text: what is playing, queues, the cache, the panels, and the answers given.
function metrics(options: WebServerOptions, hub: EventHub, responses: Map<string, number>): string {
  const lines: string[] = [];
  const gauge = (name: string, help: string, values: [string, number][]) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const [labels, value] of values) lines.push(`${name}${labels} ${value}`);
  };
  const players = options.players.all();
  const byStatus = new Map<string, number>([
    ['idle', 0],
    ['loading', 0],
    ['playing', 0],
    ['paused', 0],
  ]);
  let queued = 0;
  for (const player of players) {
    const status = player.snapshot().status;
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
    queued += options.queue.size(player.guildId);
  }
  const counts = hub.counts();
  gauge('jukecord_info', 'The running version.', [[`{version="${VERSION}"}`, 1]]);
  gauge('jukecord_discord_connected', 'Whether the bot is connected to Discord.', [
    ['', options.discordReady() ? 1 : 0],
  ]);
  gauge(
    'jukecord_players',
    'Players by state.',
    [...byStatus.entries()].map(([status, count]) => [`{status="${status}"}`, count]),
  );
  gauge('jukecord_queue_tracks', 'Tracks waiting in all queues.', [['', queued]]);
  gauge('jukecord_cache_bytes', 'Bytes in the media cache.', [['', options.cache.size()]]);
  gauge('jukecord_cache_tracks', 'Tracks in the media cache.', [['', options.cache.count()]]);
  gauge('jukecord_panel_connections', 'Open live connections from panels.', [['', counts.connections]]);
  gauge('jukecord_browser_listeners', 'Browsers playing along.', [['', counts.listening]]);
  lines.push('# HELP jukecord_http_responses_total Answers given, by status class.');
  lines.push('# TYPE jukecord_http_responses_total counter');
  for (const [group, count] of [...responses.entries()].sort())
    lines.push(`jukecord_http_responses_total{class="${group}"} ${count}`);
  return `${lines.join('\n')}\n`;
}

/** The operation names the server answers (for tests). */
export const SERVED: readonly OperationName[] = OPERATIONS;
