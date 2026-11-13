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
import { ActionError, likesOwner } from '../app/actions.ts';
import type { Bus } from '../core/bus.ts';
import { steadyNow } from '../core/clock.ts';
import type { Players } from '../core/players.ts';
import type { QueueService } from '../core/queue.ts';
import type { Track } from '../core/types.ts';
import type { Logger } from '../log.ts';
import { isPrivateAddress } from '../media/address.ts';
import { BusyError } from '../media/busy.ts';
import { MediaCache } from '../media/cache.ts';
import type { CoverFile, Covers, Pictured } from '../media/covers.ts';
import { StoreError } from '../store/store.ts';
import { VERSION } from '../version.ts';
import { API, API_PREFIX, OPERATIONS, type OperationName, type OperationSpec, type Permission } from './api.ts';
import { addressKey, type Caller, CSRF_HEADER, SESSION_COOKIE } from './auth.ts';
import { DEFAULT_LIVE_LIMITS, EventHub, type LiveLimits } from './events.ts';
import { HANDLERS, type HandlerDeps, type HandlerInput } from './handlers.ts';
import { Buckets, CHANGES, COVERS, FETCHES, Pressure, type Rate, READS, SEARCHES } from './limits.ts';
import { openApiDocument } from './openapi.ts';
import { type FieldSchema, misfit } from './schemas.ts';

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
  /**
   * Hears, at most once a minute per cap, that connections were turned away at one: every connection's, one
   * address's, or the live connections' (for app/alerts.ts).
   */
  readonly turnedAway?: (cap: TurnedAway) => void;
  readonly discordReady: () => boolean;
  /** The rates changes are held to, and the clock they are counted on (tests set both). */
  readonly rates?: {
    readonly changes?: Rate;
    readonly fetches?: Rate;
    readonly reads?: Rate;
    readonly searches?: Rate;
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
    /** The same from one address when proxies are trusted: a reverse proxy carries many browsers (default 2048). */
    readonly maxConnectionsPerProxy?: number;
    /** How long an audio request waits for an MP3 copy being made before it is told to ask again (default 5 s). */
    readonly mp3WaitMs?: number;
  };
}

/** Connections turned away at a cap since the log last said so: which cap, how many, the cap, and the address. */
export interface TurnedAway {
  readonly cap: 'connections' | 'address' | 'live';
  readonly count: number;
  readonly limit: number;
  readonly address?: string;
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

// What a guest of a listening link may ask for: the player and the queue of its server and the lyrics of what plays,
// who it is and which server it opens, and the status. Anything else is refused before it is looked at, whatever its
// access would allow a login; the audio and the live updates check the guest's server on their own.
const GUEST_MAY: ReadonlySet<OperationName> = new Set(['now-playing', 'queue', 'lyrics', 'me', 'guilds', 'status']);
const GUEST_ONLY = 'a guest of a listening link can only listen';

// What a refusal says when jukecord sheds work it can do later, and when a login or an address sends changes faster
// than the rates allow.
const BUSY = 'jukecord is busy; try again in a moment';
const TOO_MANY_CHANGES = 'too many changes at once; try again in a moment';
const TOO_MANY_SKIPS = 'too many skips at once; try again in a moment';
const TOO_MANY_READS = 'too many requests at once; try again in a moment';
// What an audio request is told while the MP3 copy it asked for is still being made.
const MAKING_MP3 = 'jukecord is making the MP3 copy of this track; try again in a moment';
const TOO_MANY_SEARCHES = 'too many searches at once; try again in a moment';

// HTTP/1.1 lets a client send requests one after another without waiting for the answers (pipelining). Browsers never
// do; undici with pipelining and benchmark tools do. A client that sends many in one go and reads nothing had each one
// answered, and each answer held in memory for a reader that never came: a few connections of small requests filled
// the heap. So at most this many answers are made at a time on one connection; the requests after them wait their turn
// without being made, up to PIPELINED_HELD more, and the ones past that are refused at once (a small 429 each, after
// which Node stops reading the connection until its answers are taken). Closing the connection instead lost every
// answer, the first sixteen too, without a word in the log.
const PIPELINED_MAX = 16;
const PIPELINED_HELD = 112;

// Waits for `promise` at most `ms`: its value when it settled in time, `undefined` when the time ran out first (the
// promise goes on; whoever made it keeps it). A rejection in time is passed on.
async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  // The wait itself: a timer that ends in `undefined`, and that must not keep a stopping process alive.
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    timer.unref();
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    // Settled first: the timer has nothing left to do.
    clearTimeout(timer);
  }
}

// A request that does not fit its operation's schema, as Fastify reports it: where (the query, the path, the body) and
// the validator's findings, the first of which is the one that counts.
interface Unfit {
  readonly validationContext?: string;
  readonly validation?: readonly {
    readonly keyword: string;
    readonly instancePath: string;
    readonly params: Record<string, unknown>;
    readonly message?: string;
  }[];
  readonly message: string;
}

// What such a request is told: the field and what it may be ("level is debug, info, warn or error", "limit is 1 to
// 200"), read from the operation's own schema. The validator's words named its path, once for every choice.
function unfit(error: Unfit, request: FastifyRequest): string {
  const first = error.validation?.[0];
  if (!first) return error.message;
  if (first.keyword === 'required') return `${String(first.params.missingProperty)} is missing`;
  const where = error.validationContext === 'querystring' ? 'querystring' : (error.validationContext ?? 'body');
  const name = first.instancePath.split('/').find(Boolean) ?? '';
  const schema = (
    request.routeOptions.schema as Record<string, { properties?: Record<string, FieldSchema> }> | undefined
  )?.[where];
  const field = schema?.properties?.[name];
  const part = (where === 'querystring' ? request.query : where === 'params' ? request.params : request.body) as
    | Record<string, unknown>
    | undefined;
  const problem = misfit(field, part?.[name]);
  if (problem) return `${name} ${problem}`;
  // A pattern (an ID): what the field's description says it is.
  if (field?.description) return `${name} is ${field.description.charAt(0).toLowerCase()}${field.description.slice(1)}`;
  return `${name} ${first.message ?? 'is not right'}`;
}

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
// What a refusal by permission says: the host for what only it may do; what a friend's login may not do, as a friend
// logs in with a link and has no token to change; otherwise the token it takes ("an admin token", "a control token").
function forbiddenFor(access: Permission, caller: Caller): string {
  if (access === 'host') return 'this needs the host';
  if (caller.principal.kind === 'friend') {
    return access === 'admin'
      ? "a friend cannot change the server's settings or tokens"
      : 'a friend who may only look and listen cannot change the music';
  }
  return `this needs ${access === 'admin' ? 'an' : 'a'} ${access} token`;
}

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
    options.turnedAway?.({ cap: 'connections', count: turnedAway, limit: app.server.maxConnections });
    turnedAway = 0;
    turnedAwayToldAt = steadyNow();
  });
  // And at most this many from one address (an IPv6 address counts by its /56, as the other limits do): one client with
  // ordinary keep-alive connections could otherwise hold every place under the cap above, the health checks' too.
  // Behind a trusted proxy every connection comes from the proxy, which carries every browser: it may take all but a
  // sixteenth of the places (3,840 of 4,096), and the rest stay for the others (the platform's health checks, a direct
  // client, a second proxy). Half of them, as first tried, halved what a deployment behind an ingress could take.
  // Without the trust a proxy on the same machine, or Docker's own (inside a container a client of the host comes from
  // the bridge's gateway), puts every browser on one address's share; the log says so, with the setting that changes
  // it.
  const trusting = hops !== false && hops !== 0 && hops !== '';
  const perAddressMax = trusting
    ? (timeouts.maxConnectionsPerProxy ?? app.server.maxConnections - Math.floor(app.server.maxConnections / 16))
    : (timeouts.maxConnectionsPerAddress ?? 256);
  const fromAddress = new Map<string, number>();
  // Connections turned away at that cap since the log last said so, and when that was.
  let refusedHere = 0;
  let refusedHereToldAt = Number.NEGATIVE_INFINITY;
  // Before the HTTP server's own listener, so a connection over the cap gets no parser at all.
  app.server.prependListener('connection', (socket: Socket) => {
    const key = addressKey(socket.remoteAddress);
    const count = (fromAddress.get(key) ?? 0) + 1;
    if (count > perAddressMax) {
      socket.destroy();
      // Said at most once a minute, as the cap above says it, with the address and how many.
      refusedHere += 1;
      if (steadyNow() - refusedHereToldAt >= 60_000) {
        options.turnedAway?.({ cap: 'address', count: refusedHere, limit: perAddressMax, address: key });
        log.warn('turned connections away from one address at its cap', {
          count: refusedHere,
          cap: perAddressMax,
          address: key,
          ...(trusting
            ? {}
            : {
                hint: 'behind a reverse proxy, set JUKECORD_TRUST_PROXY: each browser then counts by its own address, and the proxy gets a higher cap',
              }),
        });
        refusedHere = 0;
        refusedHereToldAt = steadyNow();
      }
      return;
    }
    fromAddress.set(key, count);
    socket.once('close', () => {
      const left = (fromAddress.get(key) ?? 1) - 1;
      if (left > 0) fromAddress.set(key, left);
      else fromAddress.delete(key);
    });
  });
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
    // Only the cap of every live connection is jukecord's trouble; one login's or one address's is that person's.
    ...(options.turnedAway
      ? {
          refused: (count: number, limit: number) => options.turnedAway?.({ cap: 'live', count, limit }),
        }
      : {}),
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
  const searches = new Buckets(options.rates?.searches ?? SEARCHES, { now: clock });
  const pressure = options.behind ? null : new Pressure();
  const behind = options.behind ?? (() => pressure?.behind ?? false);

  // Answers under way on each connection, and the requests waiting for a place among them (see PIPELINED_MAX). An
  // upgrade to a WebSocket keeps its place, and the connection then carries no more requests.
  interface Line {
    underWay: number;
    readonly held: ((go: boolean) => void)[];
  }
  const lines = new WeakMap<Socket, Line>();
  // Requests refused past what a connection holds, since the log last said so, and when that was.
  let refusedPipelined = 0;
  let refusedPipelinedToldAt = Number.NEGATIVE_INFINITY;
  app.addHook('onRequest', async (request, reply) => {
    const socket = request.raw.socket;
    let line = lines.get(socket);
    if (!line) {
      const made: Line = { underWay: 0, held: [] };
      lines.set(socket, made);
      // A connection that closes lets go of the requests it held: nobody is left to answer.
      socket.once('close', () => {
        for (const release of made.held.splice(0)) release(false);
      });
      line = made;
    }
    // Every place taken, or others already waiting (a newer request does not pass them): this one waits too.
    if (line.underWay >= PIPELINED_MAX || line.held.length > 0) {
      if (line.held.length >= PIPELINED_HELD) {
        // Said in the log at most once a minute, with how many since it last said so.
        refusedPipelined += 1;
        if (steadyNow() - refusedPipelinedToldAt >= 60_000) {
          log.warn('refused requests sent one after another on one connection, past what it holds at once', {
            count: refusedPipelined,
            cap: PIPELINED_MAX + PIPELINED_HELD,
          });
          refusedPipelined = 0;
          refusedPipelinedToldAt = steadyNow();
        }
        return later(reply, 'rate-limited', TOO_MANY_READS, 1000);
      }
      const held = line.held;
      const go = await new Promise<boolean>((resolve) => held.push(resolve));
      // The connection closed while it waited: nothing is made for it.
      if (!go) {
        reply.hijack();
        return;
      }
      // Otherwise it has the place of the answer that went out (handed on below), and the count stays as it is.
    } else {
      line.underWay += 1;
    }
    const own = line;
    // An answer out: its place goes to the request waiting longest, or is free again.
    reply.raw.once('close', () => {
      const next = own.held.shift();
      if (next) next(true);
      else own.underWay -= 1;
    });
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
          // Covers and search results' pictures come from jukecord itself; people's avatars and the servers' icons
          // from Discord's own address, and nothing from anywhere else.
          "img-src 'self' data: https://cdn.discordapp.com",
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
    // A refusal of a busy moment says when to ask again (Retry-After), as the server's own busy answers do.
    if (error instanceof ActionError) {
      if (error.retryAfterMs !== null) return later(reply, error.code, error.message, error.retryAfterMs);
      return failure(reply, error.code, error.message);
    }
    if (error instanceof StoreError) return failure(reply, 'invalid', error.message);
    const fastifyError = error as { validation?: unknown; statusCode?: number; message: string };
    if (fastifyError.validation) return failure(reply, 'invalid', unfit(fastifyError as Unfit, request));
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
      // An operation that takes a file may take more than the usual 64 KiB.
      ...(spec.bodyLimit ? { bodyLimit: spec.bodyLimit } : {}),
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
        if (caller?.principal.kind === 'guest' && !GUEST_MAY.has(name)) return failure(reply, 'forbidden', GUEST_ONLY);
        if (verdict === 'forbidden' && caller) return failure(reply, 'forbidden', forbiddenFor(spec.access, caller));
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
        // A refusal after a lookup on the site (a search that found nothing) cost a lookup, and keeps it spent: a person
        // with several logins or tokens behind one address otherwise had no brake from the address at all.
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
        // A read from anyone but the host is held to the wider rate of reads: a logged-in one by the person behind it
        // alone, whatever login or token they use; one without a login by its address. Many people share an address
        // (a household, an office, Docker's bridge, a proxy not trusted): counted by it, fifteen panels opening at
        // once behind one were refused, and a refused /me shows the panel's start-failed page.
        if (spec.method === 'GET' && caller?.principal.kind !== 'host') {
          const keys = caller
            ? [caller.principal.kind === 'user' ? `person ${caller.principal.userId}` : `login ${loginKey(caller)}`]
            : [`address ${addressKey(request.ip)}`];
          // A search, which starts yt-dlp, is held to its own rate as well, by the same keys (both must have a token).
          const searching = name === 'search';
          const forSearch = searching ? searches.wait(keys) : 0;
          const wait = Math.max(reads.wait(keys), forSearch);
          if (wait > 0) return later(reply, 'rate-limited', forSearch > 0 ? TOO_MANY_SEARCHES : TOO_MANY_READS, wait);
          reads.take(keys);
          if (searching) searches.take(keys);
        }
        const params = (request.params ?? {}) as Record<string, unknown>;
        // Aborted when the caller goes away before its answer is sent (a search whose words were typed over), so the
        // work it started can stop.
        const gone = new AbortController();
        reply.raw.once('close', () => {
          if (!reply.raw.writableFinished) gone.abort();
        });
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
            signal: gone.signal,
          });
        } catch (error) {
          if ((error instanceof ActionError && !error.spent) || error instanceof StoreError) giveBack?.();
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
        const making = options.mp3(track, stopping.signal);
        // A copy that fails after every request stopped waiting for it is Media's to log, not an unhandled rejection.
        making.catch(() => {});
        // The request waits a few seconds, which covers the copy of an ordinary song. A long track takes longer (an
        // hour of audio took most of a minute under two processors), and a request waiting on it moves nothing on its
        // connection, which the idle limit then cut with no answer at all: it is told to ask again instead (503 with
        // Retry-After, which the panel takes as "not now"), and the copy goes on meanwhile.
        let mp3: string | null | undefined;
        try {
          mp3 = await within(making, timeouts.mp3WaitMs ?? 5000);
        } catch (error) {
          if (error instanceof BusyError) return later(reply, 'unavailable', error.message, 2000);
          throw error;
        }
        if (mp3 === undefined) return later(reply, 'unavailable', MAKING_MP3, 2000);
        if (!mp3) return failure(reply, 'conflict', 'the track is not prepared yet');
        file = mp3;
      }
      // A track's file does not change once made; the browser may keep it for a day.
      return reply.header('cache-control', 'private, max-age=86400').sendFile(path.basename(file), path.dirname(file));
    },
  );

  // Sends a cover from the cache, or fetches it once first (src/media/covers.ts): within the cover rate of the login and
  // its address, and not while jukecord is behind. A picture that cannot be had, or none at all, answers `missing`,
  // which the browser need not ask again for an hour: as long as jukecord remembers the failure.
  const sendCover = async (
    request: FastifyRequest,
    reply: FastifyReply,
    caller: Caller,
    pictured: Pictured,
    missing: string,
  ): Promise<FastifyReply> => {
    const none = () => failure(reply.header('cache-control', 'private, max-age=3600'), 'not-found', missing);
    if (!pictured.thumbnail) return none();
    let cover: CoverFile | null = options.covers.cached(pictured);
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
        cover = await options.covers.get(pictured);
      } catch (error) {
        if (error instanceof BusyError) return later(reply, 'busy', error.message, 2000);
        throw error;
      }
      if (!cover) return none();
    }
    // A cover does not change once fetched; the browser may keep it for a day, then ask whether it did.
    return reply
      .header('cache-control', 'private, max-age=86400')
      .sendFile(path.basename(cover.path), path.dirname(cover.path));
  };

  // A track's cover, from jukecord itself: only for a track the server shows somewhere (playing, queued, in its
  // history or in one of its playlists), to a login that can open that server.
  app.get<{ Params: { guild: string; track: string } }>(
    `${API_PREFIX}/guilds/:guild/tracks/:track/cover`,
    async (request, reply) => {
      const { caller, blocked } = identify(request, reply);
      if (blocked) return failure(reply, 'too-many', 'too many failed logins; wait ten minutes');
      if (!caller) return failure(reply, 'unauthorized', 'log in first');
      const context = await deps.access.context(caller.principal, request.params.guild);
      const id = Number(request.params.track);
      const valid = Number.isSafeInteger(id) && id > 0;
      // Each question is one lookup by an index, cheapest first: the player, the queue, the history, the playlists, and
      // this login's likes (a login's own in every server it opens, so its liked list shows them here too; a guest has
      // none).
      const shown =
        valid &&
        (options.players.get(context.guildId).snapshot().track?.id === id ||
          options.queue.contains(context.guildId, id) ||
          deps.store.history.has(context.guildId, id) ||
          deps.store.playlists.has(context.guildId, id) ||
          (caller.principal.kind !== 'guest' && deps.store.likes.has(likesOwner(context), id)));
      const track = shown ? deps.store.tracks.get(id) : null;
      if (!track) return failure(reply, 'not-found', 'that track is not in this server');
      return sendCover(request, reply, caller, track, 'that track has no cover');
    },
  );

  // The picture of a search's result before it is added (the add field's list), from jukecord as a track's cover is,
  // so the browser does not ask the image host either: only for an address a search found in the last half hour, to
  // people who may search. It is kept by the same key as the track the result becomes, so adding it fetches nothing.
  app.get<{ Params: { guild: string }; Querystring: { url?: unknown } }>(
    `${API_PREFIX}/guilds/:guild/search/cover`,
    async (request, reply) => {
      const { caller, blocked } = identify(request, reply);
      if (blocked) return failure(reply, 'too-many', 'too many failed logins; wait ten minutes');
      // Held to what the search itself needs, as the operations are: whoever cannot search has no result to see.
      const verdict = permission(API.search.access, caller);
      if (!caller || verdict === 'unauthorized') return failure(reply, 'unauthorized', 'log in first');
      // A guest cannot search (the operations hold guests to GUEST_MAY, and the search is not one of them).
      if (caller.principal.kind === 'guest') return failure(reply, 'forbidden', GUEST_ONLY);
      if (verdict === 'forbidden') return failure(reply, 'forbidden', forbiddenFor(API.search.access, caller));
      const context = await deps.access.context(caller.principal, request.params.guild);
      const address = typeof request.query.url === 'string' ? request.query.url : '';
      const found = deps.actions.searched(context, address);
      if (!found) return failure(reply, 'not-found', 'no search found that address lately');
      return sendCover(request, reply, caller, found, 'that search result has no picture');
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
  // A one-time login link from `jukecord open`: the browser becomes the host, or the host's friend with the view or
  // control the link was made for.
  app.get<{ Params: { code: string } }>('/auth/link/:code', async (request, reply) => {
    // A link that works logs in even from a blocked address (it was made by the host a moment ago); one that does not
    // counts as a failure, and from a blocked address says so.
    const scope = auth.useLink(request.params.code);
    if (scope === null) {
      const blocked = auth.limiter.blocked(request.ip);
      auth.limiter.fail(request.ip);
      return reply.redirect(blocked ? '/login?error=too-many' : '/login?error=link');
    }
    log.info(scope === 'admin' ? 'logged in with a login link' : 'a friend logged in with a login link', { scope });
    return reply.header('set-cookie', auth.startLinkSession(scope)).redirect('/');
  });
  // A listening link: /listen#<code> is the panel's own page, which sends the code here (the part after "#" never
  // reaches a server, so no log or proxy sees it). The browser comes in as a guest of the link, unless it is logged
  // in already. Only from the panel's own pages: another site cannot make a browser its guest.
  app.post<{ Body: { code?: unknown } }>('/auth/listen', async (request, reply) => {
    if (!sameOrigin(request, options.publicUrl)) {
      return failure(reply, 'forbidden', 'connections come from the panel only');
    }
    const code = typeof request.body?.code === 'string' ? request.body.code : '';
    const { caller } = identify(request);
    const used = auth.useListenLink(code, caller);
    if (used.kind === 'invalid') {
      // A code that does not work is a failed login like any other (a guess at the codes is held back).
      const blocked = auth.limiter.blocked(request.ip);
      auth.limiter.fail(request.ip);
      return blocked
        ? failure(reply, 'too-many', 'too many failed logins; wait ten minutes')
        : failure(reply, 'not-found', 'this listening link has ended or does not exist');
    }
    if (used.kind === 'full') return failure(reply, 'conflict', 'this listening link has as many guests as it allows');
    if (used.kind === 'already') return reply.send({ ok: true });
    log.info('a guest came in with a listening link', { link: used.linkId, guild: used.guildId });
    return reply.header('set-cookie', used.cookie).send({ ok: true });
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
