/**
 * The web server: the API, the live updates, the audio for browsers, logging in, the health and metrics endpoints,
 * and the panel's files.
 *
 * The API's routes are registered from the operation table (src/web/api.ts); this file adds what every route shares:
 * who is calling, whether they may, the CSRF check for panel changes, turning errors into answers, and the security
 * headers. Nothing here knows about music; that all happens in the handlers and the actions behind them.
 */
import fs from 'node:fs';
import type { Socket } from 'node:net';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ActionError } from '../app/actions.ts';
import type { Bus } from '../core/bus.ts';
import { steadyNow } from '../core/clock.ts';
import type { Players } from '../core/players.ts';
import type { QueueService } from '../core/queue.ts';
import type { Track } from '../core/types.ts';
import type { Logger } from '../log.ts';
import { isPrivateAddress } from '../media/address.ts';
import { BusyError } from '../media/busy.ts';
import { MediaCache } from '../media/cache.ts';
import type { CoverFile, Covers } from '../media/covers.ts';
import { StoreError } from '../store/store.ts';
import { VERSION } from '../version.ts';
import { API, API_PREFIX, OPERATIONS, type OperationName, type OperationSpec, type Permission } from './api.ts';
import { addressKey, type Caller, CSRF_HEADER, SESSION_COOKIE } from './auth.ts';
import { DEFAULT_LIVE_LIMITS, EventHub, type LiveLimits } from './events.ts';
import { HANDLERS, type HandlerDeps, type HandlerInput } from './handlers.ts';
import { Buckets, CHANGES, COVERS, FETCHES, Pressure, type Rate, READS } from './limits.ts';
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
  /** The tracks' covers, served from the cache and fetched once (src/media/covers.ts). */
  readonly covers: Covers;
  readonly log: Logger;
  /** How many live connections there may be (in all, per login, per address); tests and the settings change it. */
  readonly live?: Partial<LiveLimits>;
  /** Whether jukecord can serve requests (for /readyz). */
  readonly ready: () => boolean;
  readonly discordReady: () => boolean;
  /** The rates changes are held to, and the clock they are counted on (tests set both). */
  readonly rates?: {
    readonly changes?: Rate;
    readonly fetches?: Rate;
    readonly reads?: Rate;
    readonly now?: () => number;
    /** Covers that are not cached yet, which jukecord fetches when asked. */
    readonly covers?: Rate;
  };
  /** Whether jukecord has fallen behind and sheds what can wait (tests set it; by default the event loop says). */
  readonly behind?: () => boolean;
  /**
   * How long a request may take to arrive, how long a connection may stand still, and how many connections there may
   * be (tests shorten and lower them).
   */
  readonly timeouts?: {
    readonly requestMs?: number;
    readonly headersMs?: number;
    readonly checkEveryMs?: number;
    readonly idleMs?: number;
    readonly maxConnections?: number;
    readonly maxConnectionsPerAddress?: number;
  };
}

export interface WebServer {
  readonly app: FastifyInstance;
  readonly hub: EventHub;
  /** Starts listening; returns the address. */
  listen(): Promise<string>;
  close(): Promise<void>;
}

// What the live connection's address may say: the server to show at once, and whether the browser takes gzip.
interface LiveQuery {
  guild?: string;
  gzip?: string;
}

// The HTTP status of each error code.
const STATUS: Readonly<Record<string, number>> = {
  invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  'not-found': 404,
  conflict: 409,
  'too-many': 429,
  'rate-limited': 429,
  unavailable: 503,
  busy: 503,
};

// The changes that start a fetch somebody waits for (yt-dlp and ffmpeg, at once): the tighter rate applies to them.
const FETCHING: ReadonlySet<OperationName> = new Set(['skip', 'play-now', 'jump', 'remove-current']);

// What a refusal says when jukecord sheds work it can do later, and when a login or an address sends changes faster
// than the rates allow.
const BUSY = 'jukecord is busy; try again in a moment';
const TOO_MANY_CHANGES = 'too many changes at once; try again in a moment';
const TOO_MANY_SKIPS = 'too many skips at once; try again in a moment';
const TOO_MANY_READS = 'too many requests at once; try again in a moment';

// HTTP/1.1 lets a client send requests one after another without waiting for the answers (pipelining). Browsers never
// do. A client that sends many in one go and reads nothing had each one answered, and each answer held in memory for a
// reader that never came: a few connections of small requests filled the heap. More than this many answers under way
// on one connection closes it.
const PIPELINED_MAX = 16;

// The answer for an error, in the one shape every API error has.
function failure(reply: FastifyReply, code: string, message: string): FastifyReply {
  return reply.code(STATUS[code] ?? 500).send({ error: { code, message } });
}

// A refusal that says when to try again (Retry-After, in whole seconds).
function later(reply: FastifyReply, code: string, message: string, ms: number): FastifyReply {
  return failure(reply.header('retry-after', String(Math.max(1, Math.ceil(ms / 1000)))), code, message);
}

// The key a caller's changes are counted under: its session, or its API token.
function loginKey(caller: Caller): string {
  return caller.sessionHash ? `session ${caller.sessionHash}` : `token ${caller.tokenId ?? 'host'}`;
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
  const timeouts = options.timeouts ?? {};
  const app = Fastify({
    logger: false,
    trustProxy,
    // Requests are small JSON; a megabyte body is a mistake or an attack.
    bodyLimit: 64 * 1024,
    // A request must have arrived whole within 30 s, its headers within 15 s, or it is answered 408 and its connection
    // closed: a client that sends slowly (or never finishes) held its connection and its memory for good before. Only
    // the request is timed: sending the answer is not (audio to a phone on a slow line takes as long as it takes),
    // nor is a WebSocket once upgraded (tests/integration/server-limits.test.ts shows both).
    requestTimeout: timeouts.requestMs ?? 30_000,
    // A connection on which nothing has moved either way for two minutes is closed: an answer whose reader stopped
    // taking it (a client that reads the headers of a long audio answer, then nothing) held its connection for good,
    // and enough of them would take every place under the cap below. A reader that is slow but reads keeps it; a
    // browser that paused its audio asks again with a Range request when it plays on. A WebSocket is not timed this
    // way: the ws library clears the timeout when it takes the connection over, and the hub pings it every 30 s.
    connectionTimeout: timeouts.idleMs ?? 120_000,
    http: {
      headersTimeout: timeouts.headersMs ?? 15_000,
      // How often Node looks for requests over their time; the default (30 s) would let one run a minute.
      connectionsCheckingInterval: timeouts.checkEveryMs ?? 5_000,
    },
    ajv: {
      // Unknown body fields are dropped (the schemas say additionalProperties: false); query strings become numbers.
      customOptions: { removeAdditional: true, coerceTypes: 'array', useDefaults: true, allErrors: false },
    },
  });
  // At most this many connections at once, of every kind (requests, audio, WebSockets): one more is closed as it
  // arrives. Live connections have their own, lower cap (see events.ts), so the rest always has room.
  app.server.maxConnections = timeouts.maxConnections ?? 4096;
  // A connection turned away at that cap: the idle ones (kept open between requests) are closed, so the next one finds
  // room, and the log says so at most once a minute.
  let turnedAway = 0;
  let turnedAwayToldAt = Number.NEGATIVE_INFINITY;
  app.server.on('drop', () => {
    app.server.closeIdleConnections();
    turnedAway += 1;
    if (steadyNow() - turnedAwayToldAt < 60_000) return;
    log.warn('turned connections away at the cap, and closed the idle ones', {
      count: turnedAway,
      cap: app.server.maxConnections,
    });
    turnedAway = 0;
    turnedAwayToldAt = steadyNow();
  });
  // And at most this many from one address (an IPv6 address counts by its /56, as the other limits do): one client with
  // ordinary keep-alive connections could otherwise hold every place under the cap above, the health checks' too.
  // Behind a trusted proxy every connection comes from the proxy, so the proxy is where to limit them.
  const trusting = hops !== false && hops !== 0 && hops !== '';
  if (!trusting) {
    const perAddressMax = timeouts.maxConnectionsPerAddress ?? 256;
    const fromAddress = new Map<string, number>();
    // Before the HTTP server's own listener, so a connection over the cap gets no parser at all.
    app.server.prependListener('connection', (socket: Socket) => {
      const key = addressKey(socket.remoteAddress);
      const count = (fromAddress.get(key) ?? 0) + 1;
      if (count > perAddressMax) {
        socket.destroy();
        return;
      }
      fromAddress.set(key, count);
      socket.once('close', () => {
        const left = (fromAddress.get(key) ?? 1) - 1;
        if (left > 0) fromAddress.set(key, left);
        else fromAddress.delete(key);
      });
    });
  }
  const hub = new EventHub({
    bus: options.bus,
    actions: deps.actions,
    access: deps.access,
    presenter: deps.presenter,
    users: deps.store.users,
    log: log.child('events'),
    // The queue's change counter, read without the queue: the hub keeps each server's queue message per version.
    queueVersion: (guildId) => options.queue.version(guildId),
    stillValid: (caller) => auth.stillValid(caller),
    limits: { ...DEFAULT_LIVE_LIMITS, ...options.live },
  });

  // Aborted when the server closes: work shared by several requests (an MP3 copy) stops with jukecord, not with one
  // of the requests.
  const stopping = new AbortController();
  // The rates of changes, per login and per address, and whether the event loop has fallen behind.
  const clock = options.rates?.now ?? Date.now;
  const changes = new Buckets(options.rates?.changes ?? CHANGES, { now: clock });
  const fetches = new Buckets(options.rates?.fetches ?? FETCHES, { now: clock });
  const reads = new Buckets(options.rates?.reads ?? READS, { now: clock });
  // Covers asked for that jukecord must fetch first (a cached one costs what a file of the panel costs, and is free).
  const coverFetches = new Buckets(options.rates?.covers ?? COVERS, { now: clock });
  const pressure = options.behind ? null : new Pressure();
  const behind = options.behind ?? (() => pressure?.behind ?? false);

  // Answers under way on each connection (see PIPELINED_MAX). An upgrade to a WebSocket leaves its count at one, and
  // the connection then carries no more requests.
  const underWay = new WeakMap<Socket, number>();
  app.addHook('onRequest', async (request, reply) => {
    const socket = request.raw.socket;
    const count = (underWay.get(socket) ?? 0) + 1;
    if (count > PIPELINED_MAX) {
      // Nothing is sent: the connection goes, with what it asked for.
      reply.hijack();
      socket.destroy();
      return;
    }
    underWay.set(socket, count);
    reply.raw.once('close', () => underWay.set(socket, (underWay.get(socket) ?? 1) - 1));
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
          // Covers come from jukecord itself; people's avatars and the servers' icons from Discord.
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
      // No compression per connection: it kept zlib's state for every open panel (about a quarter of a MiB each) and
      // compressed a thousand-track queue again for each one, about 3 ms of a processor per panel per change, which
      // 200 panels at three changes a second used up. A big message is compressed once instead and the same bytes go
      // to every panel that can decompress them (see events.ts).
      perMessageDeflate: false,
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
    cacheControl: false,
    // The build's .br and .gz copies, sent to a browser that takes them (scripts/build-panel.ts makes them).
    preCompressed: true,
    // The font's pieces carry their content's hash in their names, so a browser keeps them for a year; everything else
    // is revalidated on every load (ETag), so a new version is seen at once. A route that set its own (the audio,
    // through sendFile) keeps it.
    setHeaders: (reply, file) => {
      if (reply.getHeader('cache-control')) return;
      reply.header('cache-control', /[\\/]fonts[\\/]/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });

  // Who is calling. A credential that does not work counts as a failed login for its address, and a dead session
  // cookie is removed so the browser stops sending it. An address that failed too often is refused (`blocked`) only
  // for such a credential: one that works still gets in, so a household behind one address is not locked out for ten
  // minutes by a browser with a stale cookie or by someone guessing. Guessing gains nothing from that: every secret is
  // 32 random bytes, and a wrong one is answered the same way as before.
  const identify = (request: FastifyRequest, reply?: FastifyReply): { caller: Caller | null; blocked: boolean } => {
    const caller = auth.identify({ authorization: request.headers.authorization, cookie: request.headers.cookie });
    const session = request.headers.cookie?.includes(`${SESSION_COOKIE}=`) ?? false;
    // A request without any credential is not a failed login (a public page, or a "log in first").
    if (caller || (!request.headers.authorization && !session)) return { caller, blocked: false };
    // Asked before this failure counts, as before: the attempt after the twentieth is the first one refused.
    const blocked = auth.limiter.blocked(request.ip);
    auth.limiter.fail(request.ip);
    if (reply && session) reply.header('set-cookie', auth.endSession(null));
    return { caller: null, blocked };
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
        const { caller, blocked } = identify(request, reply);
        if (blocked) return failure(reply, 'too-many', 'too many failed logins; wait ten minutes');
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
        // A change from anyone but the host waits while jukecord is behind, and is held to the rates: one token from
        // its login's bucket and one from its address's (and from the tighter buckets for a change that starts a
        // fetch). Nothing is taken from any bucket unless every one has a token, so a refusal costs nothing.
        // A change the actions then refuse (no DJ role, an item gone) gives its address's token back: the others behind
        // that address (a household, an office) are not held back by one person's refusals; that person's login still is.
        let giveBack: (() => void) | null = null;
        if (spec.method !== 'GET' && caller && caller.principal.kind !== 'host') {
          if (behind()) return later(reply, 'busy', BUSY, 2000);
          const keys = [`login ${loginKey(caller)}`, `address ${addressKey(request.ip)}`];
          const fetching = FETCHING.has(name);
          const forFetch = fetching ? fetches.wait(keys) : 0;
          const wait = Math.max(changes.wait(keys), forFetch);
          if (wait > 0) return later(reply, 'rate-limited', forFetch > 0 ? TOO_MANY_SKIPS : TOO_MANY_CHANGES, wait);
          changes.take(keys);
          if (fetching) fetches.take(keys);
          const address = keys.slice(1);
          giveBack = () => {
            changes.give(address);
            if (fetching) fetches.give(address);
          };
        }
        // A read from anyone but the host is held to the wider rate of reads, by its login and its address (without a
        // login, by its address alone).
        if (spec.method === 'GET' && caller?.principal.kind !== 'host') {
          const keys = [...(caller ? [`login ${loginKey(caller)}`] : []), `address ${addressKey(request.ip)}`];
          const wait = reads.wait(keys);
          if (wait > 0) return later(reply, 'rate-limited', TOO_MANY_READS, wait);
          reads.take(keys);
        }
        const params = (request.params ?? {}) as Record<string, unknown>;
        try {
          const context =
            typeof params.guild === 'string' && caller
              ? await deps.access.context(caller.principal, params.guild)
              : null;
          return await handler({
            params: params as never,
            query: (request.query ?? {}) as never,
            body: (request.body ?? {}) as never,
            caller,
            context: context as never,
            deps,
          });
        } catch (error) {
          if (error instanceof ActionError || error instanceof StoreError) giveBack?.();
          throw error;
        }
      },
    });
  }

  // The audio of a prepared track, for browsers playing along. Only a track that a server the caller can open is
  // playing or has queued: a login cannot walk the track numbers and make ffmpeg convert the whole cache. Range
  // requests let a browser seek without downloading it all.
  app.get<{ Params: { guild: string; track: string }; Querystring: { format?: string } }>(
    `${API_PREFIX}/guilds/:guild/tracks/:track/audio`,
    async (request, reply) => {
      // Sending audio is the heaviest thing jukecord does for a browser; while it is behind, the browser asks again in
      // a moment (the panel does not take this for a format it cannot play).
      if (behind()) return later(reply, 'busy', BUSY, 2000);
      // An address that failed too often is refused here too, for a credential that does not work.
      const { caller, blocked } = identify(request, reply);
      if (blocked) return failure(reply, 'too-many', 'too many failed logins; wait ten minutes');
      if (!caller) return failure(reply, 'unauthorized', 'log in first');
      const context = await deps.access.context(caller.principal, request.params.guild);
      const id = Number(request.params.track);
      const valid = Number.isSafeInteger(id) && id > 0;
      const current = options.players.get(context.guildId).snapshot().track;
      // Asked of the index, not by reading the queue: a browser seeking sends a Range request each time.
      const queued = valid && (current?.id === id || options.queue.contains(context.guildId, id));
      const track = queued ? deps.store.tracks.get(id) : null;
      if (!track) return failure(reply, 'not-found', 'that track is not playing or queued in this server');
      const key = MediaCache.keyOf(track.source);
      if (!options.cache.has(key)) return failure(reply, 'conflict', 'the track is not prepared yet');
      let file = options.cache.opusPath(key);
      if (request.query.format === 'mp3') {
        // Shared by everyone asking at once and not tied to this request: a second browser may be waiting for it. It
        // ends at its own time limit, which grows with the track (see Media.mp3), or when jukecord stops.
        let mp3: string | null;
        try {
          mp3 = await options.mp3(track, stopping.signal);
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

  // A track's cover, from jukecord itself (src/media/covers.ts): only for a track the server shows somewhere (playing,
  // queued, in its history or in one of its playlists), to a login that can open that server. A cached cover is sent
  // as a file; one not cached yet is fetched once, within the cover rate of the login and its address, and not while
  // jukecord is behind.
  app.get<{ Params: { guild: string; track: string } }>(
    `${API_PREFIX}/guilds/:guild/tracks/:track/cover`,
    async (request, reply) => {
      const { caller, blocked } = identify(request, reply);
      if (blocked) return failure(reply, 'too-many', 'too many failed logins; wait ten minutes');
      if (!caller) return failure(reply, 'unauthorized', 'log in first');
      const context = await deps.access.context(caller.principal, request.params.guild);
      const id = Number(request.params.track);
      const valid = Number.isSafeInteger(id) && id > 0;
      // Each question is one lookup by an index, cheapest first: the player, the queue, the history, the playlists.
      const shown =
        valid &&
        (options.players.get(context.guildId).snapshot().track?.id === id ||
          options.queue.contains(context.guildId, id) ||
          deps.store.history.has(context.guildId, id) ||
          deps.store.playlists.has(context.guildId, id));
      const track = shown ? deps.store.tracks.get(id) : null;
      if (!track) return failure(reply, 'not-found', 'that track is not in this server');
      // A track without a picture, or one whose picture cannot be had: the browser need not ask again for an hour,
      // which is as long as jukecord remembers the failure.
      const none = () =>
        failure(reply.header('cache-control', 'private, max-age=3600'), 'not-found', 'that track has no cover');
      if (!track.thumbnail) return none();
      let cover: CoverFile | null = options.covers.cached(track);
      if (!cover) {
        if (behind()) return later(reply, 'busy', BUSY, 2000);
        // The host is not held to a rate, as for every other request.
        if (caller.principal.kind !== 'host') {
          const keys = [`login ${loginKey(caller)}`, `address ${addressKey(request.ip)}`];
          const wait = coverFetches.wait(keys);
          if (wait > 0) return later(reply, 'rate-limited', TOO_MANY_READS, wait);
          coverFetches.take(keys);
        }
        try {
          cover = await options.covers.get(track);
        } catch (error) {
          if (error instanceof BusyError) return later(reply, 'busy', error.message, 2000);
          throw error;
        }
        if (!cover) return none();
      }
      // A track's cover does not change once fetched; the browser may keep it for a day, then ask whether it did.
      return reply
        .header('cache-control', 'private, max-age=86400')
        .sendFile(path.basename(cover.path), path.dirname(cover.path));
    },
  );

  // Live updates. A browser's cookie is only accepted from the panel's own pages (another site could otherwise open
  // a connection with it).
  app.get<{ Querystring: LiveQuery }>(`${API_PREFIX}/events`, { websocket: true }, (socket, request) => {
    // A blocked address with a credential that does not work is told to come back later (1013), which a panel takes as
    // "reconnect after a wait"; one that works gets in.
    const { caller, blocked } = identify(request);
    if (blocked) {
      socket.close(1013, 'too many failed logins; wait ten minutes');
      return;
    }
    if (!caller) {
      socket.close(4401, 'log in first');
      return;
    }
    if (caller.via === 'session' && !sameOrigin(request, options.publicUrl)) {
      socket.close(4403, 'connections come from the panel only');
      return;
    }
    hub.attach(socket, caller, {
      guild: typeof request.query.guild === 'string' ? request.query.guild : undefined,
      // gzip=1: the panel can decompress (it has DecompressionStream), so big messages may come as gzip frames.
      gzip: request.query.gzip === '1',
      // For the cap per address: the browser's address (behind a trusted proxy, the one it forwarded).
      address: request.ip,
    });
  });

  // The OpenAPI document of the API, made once: it is the same for every request, and anyone may ask for it (made
  // afresh it cost 3.5 ms of the event loop and 80 KB each time).
  let openApi: Buffer | null = null;
  app.get(`${API_PREFIX}/openapi.json`, async (_request, reply) => {
    openApi ??= Buffer.from(JSON.stringify(openApiDocument(API_PREFIX)));
    return reply.type('application/json; charset=utf-8').send(openApi);
  });

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
      // Refused before Discord is asked: whether this login works is only known from Discord's answer, and a blocked
      // address must not be able to make jukecord ask Discord over and over (Discord limits how often it may).
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
    // A link that works logs in even from a blocked address (it was made by the host a moment ago); one that does not
    // counts as a failure, and from a blocked address says so.
    if (!auth.useLink(request.params.code)) {
      const blocked = auth.limiter.blocked(request.ip);
      auth.limiter.fail(request.ip);
      return reply.redirect(blocked ? '/login?error=too-many' : '/login?error=link');
    }
    log.info('logged in with a login link');
    return reply.header('set-cookie', auth.startSession({ kind: 'host' })).redirect('/');
  });
  app.post('/auth/logout', async (request, reply) => {
    const { caller, blocked } = identify(request);
    if (blocked) return failure(reply, 'too-many', 'too many failed logins; wait ten minutes');
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
  // Metrics are for a scraper beside jukecord (on the same machine, in the same cluster or network), not for the
  // internet: a request that came through the reverse proxy (it carries X-Forwarded-For, or the standard Forwarded)
  // or from a public address gets the 404 any unknown path gets, so the version and the counts are not handed to
  // everyone.
  app.get('/metrics', async (request, reply) => {
    const peer = request.socket.remoteAddress ?? '';
    const forwarded = request.headers['x-forwarded-for'] !== undefined || request.headers.forwarded !== undefined;
    if (forwarded || !isPrivateAddress(peer)) {
      return reply.code(404).send({ error: { code: 'not-found', message: 'no such path' } });
    }
    return reply.type('text/plain; version=0.0.4').send(metrics(options, hub, responses, pressure));
  });

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
      pressure?.stop();
      stopping.abort();
      // Fastify closes the idle connections and waits for the answers under way. Audio to a browser lasts as long as
      // the browser takes to read it (a paused <audio> reads nothing for minutes), and jukecord gives its whole stop ten
      // seconds: what is still under way after two is cut.
      const cut = setTimeout(() => app.server.closeAllConnections(), 2000);
      cut.unref();
      try {
        await app.close();
      } finally {
        clearTimeout(cut);
      }
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
function metrics(
  options: WebServerOptions,
  hub: EventHub,
  responses: Map<string, number>,
  pressure: Pressure | null,
): string {
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
  gauge('jukecord_cache_covers', "Tracks' covers in the media cache.", [['', options.cache.coverCount()]]);
  gauge('jukecord_panel_connections', 'Open live connections from panels.', [['', counts.connections]]);
  gauge('jukecord_browser_listeners', 'Browsers playing along.', [['', counts.listening]]);
  // How far behind the event loop is: above 0.2 s, audio (for everyone) and changes from anyone but the host are
  // turned away.
  if (pressure) {
    gauge('jukecord_event_loop_delay_seconds', "The 99th percentile of the event loop's delay over the last second.", [
      ['', Math.round(pressure.delayMs) / 1000],
    ]);
  }
  lines.push('# HELP jukecord_http_responses_total Answers given, by status class.');
  lines.push('# TYPE jukecord_http_responses_total counter');
  for (const [group, count] of [...responses.entries()].sort())
    lines.push(`jukecord_http_responses_total{class="${group}"} ${count}`);
  return `${lines.join('\n')}\n`;
}

/** The operation names the server answers (for tests). */
export const SERVED: readonly OperationName[] = OPERATIONS;
