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
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { hostLike, personOf } from '../app/access.ts';
import { ActionError } from '../app/actions.ts';
import type { Health } from '../app/health.ts';
import { LdapError } from '../auth/ldap.ts';
import { levelOf, sameLdapGroup, sameOidcGroup } from '../auth/levels.ts';
import { OidcError, SSO_COOKIE } from '../auth/oidc.ts';
import type { Cache } from '../cache/cache.ts';
import { MemoryCache } from '../cache/memory.ts';
import { MEMORY_BUCKETS, MEMORY_ENTRIES } from '../cache/open.ts';
import type { Bus } from '../core/bus.ts';
import { steadyNow } from '../core/clock.ts';
import type { Players } from '../core/players.ts';
import type { QueueService } from '../core/queue.ts';
import type { Track } from '../core/types.ts';
import type { Logger } from '../log.ts';
import type { MediaCache } from '../media/cache.ts';
import type { Covers } from '../media/covers.ts';
import { MetricsGate, negotiate } from '../metrics/http.ts';
import { MetricsRegistry } from '../metrics/registry.ts';
import { httpMetrics, methodLabel, routeLabel, statusClass } from '../metrics/web.ts';
import { StoreError } from '../store/store.ts';
import { API, API_PREFIX, OPERATIONS, type OperationName, type OperationSpec, type Permission } from './api.ts';
import {
  addressFailures,
  addressKey,
  type Caller,
  CSRF_HEADER,
  cookie,
  DiscordLoginError,
  nameFailures,
  parseCookies,
  SESSION_COOKIE,
  safeNext,
} from './auth.ts';
import { DEFAULT_LIVE_LIMITS, type ElsewhereListeners, EventHub, type LiveLimits } from './events.ts';
import { type Files, MediaFiles } from './files.ts';
import { HANDLERS, type HandlerDeps, type HandlerInput } from './handlers.ts';
import { CHANGES, COVERS, FETCHES, Limit, Pressure, type Rate, READS, SEARCHES } from './limits.ts';
import { openApiDocument } from './openapi.ts';
import { BUSY, failure, later, TOO_MANY_READS } from './replies.ts';
import { type FieldSchema, misfit } from './schemas.ts';

/** One process (or a core's own use): its players, its queue and its media, which the routes read themselves. */
export interface LocalMedia {
  readonly players: Players;
  readonly queue: QueueService;
  readonly cache: MediaCache;
  /** Makes the MP3 copy of a cached track for browsers without Opus. */
  readonly mp3: (track: Track, signal: AbortSignal) => Promise<string | null>;
  /** The tracks' covers, served from the cache and fetched once (src/media/covers.ts). */
  readonly covers: Covers;
  readonly edge?: undefined;
}

/** An edge of a split jukecord: the core has the players, the queue and the media (see roles/edge.ts). */
export interface EdgeMedia {
  readonly edge: {
    /** The core's audio and covers, streamed from its internal port. */
    readonly files: Files;
    /** A server's queue version as the bus last told it (the live updates keep a server's queue per version). */
    readonly queueVersion: (guildId: string) => number;
    /** Who listens in the other edges' browsers, shown and counted with this edge's own. */
    readonly elsewhere: ElsewhereListeners;
    /** Tells the other edges to end the connections a logout or a revoked link ends here. */
    readonly endings: NonNullable<ConstructorParameters<typeof EventHub>[0]['endings']>;
    /** Whether the core has fallen behind, which sheds what can wait here too (the core does the work). */
    readonly behind: () => boolean;
  };
  readonly players?: undefined;
  readonly queue?: undefined;
  readonly cache?: undefined;
  readonly mp3?: undefined;
  readonly covers?: undefined;
}

export type WebServerOptions = WebServerCommon & (LocalMedia | EdgeMedia);

interface WebServerCommon {
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
  readonly log: Logger;
  /** How many live connections there may be (in all, per login, per address); tests and the settings change it. */
  readonly live?: Partial<LiveLimits>;
  /** Whether jukecord can serve, part by part (for /readyz, src/app/health.ts). */
  readonly health: Health;
  /** Where every number of jukecord is kept, for /metrics; a server made on its own (a test's) makes its own. */
  readonly metrics?: MetricsRegistry;
  /** The token that lets a scraper read /metrics from anywhere (JUKECORD_METRICS_TOKEN); none: the address rule. */
  readonly metricsToken?: string | null;
  /**
   * Hears, at most once a minute per cap, that connections were turned away at one: every connection's, one
   * address's, or the live connections' (for app/alerts.ts).
   */
  readonly turnedAway?: (cap: TurnedAway) => void;
  /**
   * Where the rates are counted (and whatever else browsers' requests share): the process's shared cache, which several
   * edges keep on one Redis or Valkey server. Without it the server keeps one in its memory.
   */
  readonly sharedCache?: Cache;
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

// The changes that start a fetch somebody waits for (yt-dlp and ffmpeg, at once): the tighter rate applies to them.
const FETCHING: ReadonlySet<OperationName> = new Set(['skip', 'play-now', 'jump', 'remove-current']);

// What a guest of a listening link may ask for: the player and the queue of its server and the lyrics of what plays,
// who it is and which server it opens, and the status. Anything else is refused before it is looked at, whatever its
// access would allow a login; the audio and the live updates check the guest's server on their own.
const GUEST_MAY: ReadonlySet<OperationName> = new Set(['now-playing', 'queue', 'lyrics', 'me', 'guilds', 'status']);
const GUEST_ONLY = 'a guest can only look and listen';

// What a refusal says when a login or an address sends changes faster than the rates allow (BUSY and TOO_MANY_READS
// are in replies.ts, which the audio and the covers answer with too).
const TOO_MANY_CHANGES = 'too many changes at once; try again in a moment';
const TOO_MANY_SKIPS = 'too many skips at once; try again in a moment';
const TOO_MANY_SEARCHES = 'too many searches at once; try again in a moment';

// The metrics' text, compressed off the main thread for a scraper that takes gzip (Prometheus always does): a few tens
// of kilobytes become a few.
const gzipped = promisify(zlib.gzip);

// HTTP/1.1 lets a client send requests one after another without waiting for the answers (pipelining). Browsers never
// do; undici with pipelining and benchmark tools do. A client that sends many in one go and reads nothing had each one
// answered, and each answer held in memory for a reader that never came: a few connections of small requests filled
// the heap. So at most this many answers are made at a time on one connection; the requests after them wait their turn
// without being made, up to PIPELINED_HELD more, and the ones past that are refused at once (a small 429 each, after
// which Node stops reading the connection until its answers are taken). Closing the connection instead lost every
// answer, the first sixteen too, without a word in the log.
const PIPELINED_MAX = 16;
const PIPELINED_HELD = 112;

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

// What went wrong, in the words of its error, for the log.
function reasonOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
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
  // A member's level is their groups' word: said so, with who can change it.
  if (caller.principal.kind === 'member') {
    return access === 'admin'
      ? "your groups let you change the music, not the server's settings or tokens"
      : 'your groups let you look and listen, not change the music';
  }
  return `this needs ${access === 'admin' ? 'an' : 'a'} ${access} token`;
}

function permission(access: Permission, caller: Caller | null): 'ok' | 'unauthorized' | 'forbidden' {
  if (access === 'public') return 'ok';
  if (!caller) return 'unauthorized';
  if (access === 'read') return 'ok';
  if (access === 'control') return caller.scope === 'read' ? 'forbidden' : 'ok';
  if (access === 'admin') return caller.scope === 'admin' ? 'ok' : 'forbidden';
  // What only the host may do: the host, and a login whose groups gave it the admin level (src/app/access.ts).
  return hostLike(caller.principal) && caller.scope === 'admin' ? 'ok' : 'forbidden';
}

export async function createWebServer(options: WebServerOptions): Promise<WebServer> {
  const { deps, log } = options;
  const { auth } = deps;
  // Every number for /metrics, and who may read them.
  const registry = options.metrics ?? new MetricsRegistry();
  const gate = new MetricsGate(options.metricsToken ?? null);
  const http = httpMetrics(registry);
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
    metrics: registry,
    // The queue's change counter, read without the queue (an edge: as the bus last said it): the hub keeps each
    // server's queue message per version.
    queueVersion: (guildId) => (options.edge ? options.edge.queueVersion(guildId) : options.queue.version(guildId)),
    // An edge's: the other edges' listeners, the endings they must hear, and reads that are the core's commands.
    ...(options.edge ? { elsewhere: options.edge.elsewhere, endings: options.edge.endings, remote: true } : {}),
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
  // The rates of changes, per login and per address, counted in the shared cache (a cache of its own when none is
  // given, on the steady clock unless a test gives one), and whether the event loop has fallen behind.
  const ownCache = options.sharedCache
    ? null
    : new MemoryCache({
        capacity: MEMORY_ENTRIES,
        buckets: MEMORY_BUCKETS,
        ...(options.rates?.now ? { now: options.rates.now } : {}),
      });
  const shared = options.sharedCache ?? (ownCache as MemoryCache);
  const changes = new Limit(shared, 'changes', options.rates?.changes ?? CHANGES, log);
  const fetches = new Limit(shared, 'fetches', options.rates?.fetches ?? FETCHES, log);
  const reads = new Limit(shared, 'reads', options.rates?.reads ?? READS, log);
  // Covers asked for that jukecord must fetch first (a cached one costs what a file of the panel costs, and is free).
  const coverFetches = new Limit(shared, 'covers', options.rates?.covers ?? COVERS, log);
  const searches = new Limit(shared, 'searches', options.rates?.searches ?? SEARCHES, log);
  const pressure = options.behind ? null : new Pressure();
  // An edge sheds what can wait when the core is behind as well: the core does the work it would ask.
  const coreBehind = options.edge?.behind ?? (() => false);
  const ownBehind = options.behind ?? (() => pressure?.behind ?? false);
  const behind = () => ownBehind() || coreBehind();

  // The audio and the covers: from this process's media cache, or (an edge) streamed from the core's.
  const files: Files = options.edge
    ? options.edge.files
    : new MediaFiles({
        players: options.players,
        queue: options.queue,
        store: deps.store,
        cache: options.cache,
        mp3: options.mp3,
        covers: options.covers,
        searched: async (context, address) => deps.actions.searched(context, address),
        coverRate: coverFetches,
        behind,
        stopping: stopping.signal,
        ...(timeouts.mp3WaitMs !== undefined ? { mp3WaitMs: timeouts.mp3WaitMs } : {}),
      });

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

  // Every answer counted by its status class, and timed by its method, route and class. The live connection is left
  // out of the times: its "answer" lasts as long as the panel stays open.
  const live = `${API_PREFIX}/events`;
  app.addHook('onResponse', async (request, reply) => {
    const status = reply.statusCode;
    const group = statusClass(status);
    http.responses.inc({ class: group });
    const template = request.routeOptions.url;
    if (template === live) return;
    http.duration.observe(reply.elapsedTime / 1000, {
      method: methodLabel(request.method),
      route: routeLabel(template, status),
      class: group,
    });
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
    // Without the panel, a folder that exists (sendFile needs a root; an edge has no media cache to name).
    root: panelDir ?? (options.edge ? os.tmpdir() : options.cache.dir),
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
  const identify = async (
    request: FastifyRequest,
    reply?: FastifyReply,
  ): Promise<{ caller: Caller | null; blocked: boolean }> => {
    const caller = await auth.identify({
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
    });
    const session = request.headers.cookie?.includes(`${SESSION_COOKIE}=`) ?? false;
    // A request without any credential is not a failed login (a public page, or a "log in first").
    if (caller || (!request.headers.authorization && !session)) return { caller, blocked: false };
    // Counted, and whether the address was blocked before this failure, as before: the attempt after the twentieth is
    // the first one refused.
    const blocked = await auth.limiter.fail([addressFailures(request.ip)]);
    if (reply && session) reply.header('set-cookie', await auth.endSession(null));
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
        const { caller, blocked } = await identify(request, reply);
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
        let giveBack: (() => Promise<void>) | null = null;
        if (spec.method !== 'GET' && caller && caller.principal.kind !== 'host') {
          if (behind()) return later(reply, 'busy', BUSY, 2000);
          const keys = [`login ${loginKey(caller)}`, `address ${addressKey(request.ip)}`];
          const fetching = FETCHING.has(name);
          // Each kind takes from all its buckets or none; a kind that took while the other refused gives its token
          // back, so a refusal costs nothing, and the wait is the longer of the two.
          const forFetch = fetching ? await fetches.spend(keys) : 0;
          const forChange = await changes.spend(keys);
          if (forFetch > 0 || forChange > 0) {
            if (fetching && forFetch === 0) await fetches.refund(keys);
            if (forChange === 0) await changes.refund(keys);
            const wait = Math.max(forFetch, forChange);
            return later(reply, 'rate-limited', forFetch > 0 ? TOO_MANY_SKIPS : TOO_MANY_CHANGES, wait);
          }
          const address = keys.slice(1);
          giveBack = async () => {
            await changes.refund(address);
            if (fetching) await fetches.refund(address);
          };
        }
        // A read from anyone but the host is held to the wider rate of reads: a logged-in one by the person behind it
        // alone, whatever login or token they use; one without a login by its address. Many people share an address
        // (a household, an office, Docker's bridge, a proxy not trusted): counted by it, fifteen panels opening at
        // once behind one were refused, and a refused /me shows the panel's start-failed page.
        if (spec.method === 'GET' && caller?.principal.kind !== 'host') {
          const person = caller ? personOf(caller.principal) : null;
          const keys = caller
            ? [person !== null ? `person ${person}` : `login ${loginKey(caller)}`]
            : [`address ${addressKey(request.ip)}`];
          // A search, which starts yt-dlp, is held to its own rate as well, by the same keys (both must have a token).
          const searching = name === 'search';
          const forSearch = searching ? await searches.spend(keys) : 0;
          const forRead = await reads.spend(keys);
          if (forSearch > 0 || forRead > 0) {
            if (searching && forSearch === 0) await searches.refund(keys);
            if (forRead === 0) await reads.refund(keys);
            const wait = Math.max(forSearch, forRead);
            return later(reply, 'rate-limited', forSearch > 0 ? TOO_MANY_SEARCHES : TOO_MANY_READS, wait);
          }
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
          if ((error instanceof ActionError && !error.spent) || error instanceof StoreError) await giveBack?.();
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
      const { caller, blocked } = await identify(request, reply);
      if (blocked) return failure(reply, 'too-many', 'too many failed logins; wait ten minutes');
      if (!caller) return failure(reply, 'unauthorized', 'log in first');
      const context = await deps.access.context(caller.principal, request.params.guild);
      // From this process's media cache, or the core's (files.ts): the same checks, files and refusals.
      return files.audio(request, reply, context.guildId, Number(request.params.track), request.query.format === 'mp3');
    },
  );

  // The keys a caller's covers are counted under when jukecord must fetch one first; none for the host, who is not
  // held to a rate, as for every other request.
  const coverKeys = (request: FastifyRequest, caller: Caller): string[] | null =>
    caller.principal.kind === 'host' ? null : [`login ${loginKey(caller)}`, `address ${addressKey(request.ip)}`];

  // A track's cover, from jukecord itself: only for a track the server shows somewhere (playing, queued, in its
  // history or in one of its playlists), to a login that can open that server.
  app.get<{ Params: { guild: string; track: string } }>(
    `${API_PREFIX}/guilds/:guild/tracks/:track/cover`,
    async (request, reply) => {
      const { caller, blocked } = await identify(request, reply);
      if (blocked) return failure(reply, 'too-many', 'too many failed logins; wait ten minutes');
      if (!caller) return failure(reply, 'unauthorized', 'log in first');
      const context = await deps.access.context(caller.principal, request.params.guild);
      const guest = caller.principal.kind === 'guest';
      return files.cover(request, reply, context, guest, Number(request.params.track), coverKeys(request, caller));
    },
  );

  // The picture of a search's result before it is added (the add field's list), from jukecord as a track's cover is,
  // so the browser does not ask the image host either: only for an address a search found in the last half hour, to
  // people who may search. It is kept by the same key as the track the result becomes, so adding it fetches nothing.
  app.get<{ Params: { guild: string }; Querystring: { url?: unknown } }>(
    `${API_PREFIX}/guilds/:guild/search/cover`,
    async (request, reply) => {
      const { caller, blocked } = await identify(request, reply);
      if (blocked) return failure(reply, 'too-many', 'too many failed logins; wait ten minutes');
      // Held to what the search itself needs, as the operations are: whoever cannot search has no result to see.
      const verdict = permission(API.search.access, caller);
      if (!caller || verdict === 'unauthorized') return failure(reply, 'unauthorized', 'log in first');
      // A guest cannot search (the operations hold guests to GUEST_MAY, and the search is not one of them).
      if (caller.principal.kind === 'guest') return failure(reply, 'forbidden', GUEST_ONLY);
      if (verdict === 'forbidden') return failure(reply, 'forbidden', forbiddenFor(API.search.access, caller));
      const context = await deps.access.context(caller.principal, request.params.guild);
      const address = typeof request.query.url === 'string' ? request.query.url : '';
      return files.searchCover(request, reply, context, address, coverKeys(request, caller));
    },
  );

  // Live updates. A browser's cookie is only accepted from the panel's own pages (another site could otherwise open
  // a connection with it).
  app.get<{ Querystring: LiveQuery }>(`${API_PREFIX}/events`, { websocket: true }, (socket, request) => {
    // What the browser says while its login is read from the database (the "listening" a panel sends as it opens) is
    // kept, in order, and handed to the hub when it takes the connection: nothing it says is lost meanwhile.
    const early: string[] = [];
    const keep = (data: unknown): void => {
      early.push(String(data));
    };
    socket.on('message', keep);
    const take = async (): Promise<void> => {
      // A blocked address with a credential that does not work is told to come back later (1013), which a panel takes
      // as "reconnect after a wait"; one that works gets in.
      const { caller, blocked } = await identify(request);
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
      await hub.attach(socket, caller, {
        guild: typeof request.query.guild === 'string' ? request.query.guild : undefined,
        // gzip=1: the panel can decompress (it has DecompressionStream), so big messages may come as gzip frames.
        gzip: request.query.gzip === '1',
        // For the cap per address: the browser's address (behind a trusted proxy, the one it forwarded).
        address: request.ip,
        // Handed over once, as the hub starts listening itself.
        early: () => {
          socket.off('message', keep);
          return early;
        },
      });
    };
    // A login that cannot be read (the database failing) ends the connection with its reason, rather than leaving it
    // open with nobody listening.
    take().catch((error: unknown) => {
      log.warn('could not take a live connection', { error });
      socket.close(1011, 'jukecord could not take the connection');
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
      // Counted before Discord is asked, and refused when the address failed too often: whether this login works is
      // only known from Discord's answer, and a blocked address must not be able to make jukecord ask Discord over and
      // over (Discord limits how often it may), nor many tries sent at once all get through before any is counted. A
      // try that was no failure is forgiven at the end.
      const keys = [addressFailures(request.ip)];
      if (!(await auth.limiter.enter(keys))) {
        auth.counted('discord', 'blocked');
        return reply.redirect('/login?error=too-many');
      }
      let failed = false;
      try {
        const { person, next } = await auth.oauthFinish(code, state, request.headers.cookie);
        await deps.store.users.upsert(person);
        // Asked afresh at every login: someone refused a minute ago may have joined the server since.
        deps.access.forget(person.id);
        // Only people in a server the bot is in get in: the panel is for those servers.
        const guilds = await deps.access.guilds({ kind: 'user', userId: person.id });
        if (guilds.length === 0) {
          auth.counted('discord', 'denied');
          return reply.redirect('/login?error=not-a-member');
        }
        reply.header('set-cookie', [
          auth.clearOAuthCookie(),
          await auth.startSession({ kind: 'user', userId: person.id }),
        ]);
        auth.counted('discord', 'ok');
        log.info('logged in with Discord', { user: person.name });
        return reply.redirect(next);
      } catch (failure) {
        // Just started and not connected to Discord yet: not the person's failure, and not counted as one.
        if (failure instanceof ActionError && failure.code === 'unavailable') {
          auth.counted('discord', 'unavailable');
          return reply.redirect('/login?error=connecting');
        }
        auth.counted('discord', 'failed');
        log.info('a Discord login failed', { reason: failure instanceof Error ? failure.message : String(failure) });
        // A state that is no login of this browser (an old tab, or a link or an image another page points here) is
        // nobody's guess: not counted, or any page could lock its visitors' address out.
        if (failure instanceof DiscordLoginError && failure.code === 'expired')
          return reply.redirect('/login?error=expired');
        failed = true;
        return reply.redirect('/login?error=failed');
      } finally {
        if (!failed) await auth.limiter.forgive(keys);
      }
    },
  );
  // Logging in through the host's identity provider (OIDC): off to the provider, and back. Where the person wanted to
  // go travels with the login on the cache, checked to be a path on this site.
  app.get<{ Querystring: { next?: string } }>('/auth/sso', async (request, reply) => {
    const oidc = auth.oidc;
    if (!oidc) return reply.redirect('/login?error=no-sso');
    // Held to a rate per address: each start keeps a login's state on the cache for ten minutes.
    if (!(await auth.mayStartSso(request.ip))) {
      auth.counted('oidc', 'blocked');
      return reply.redirect('/login?error=sso-too-fast');
    }
    try {
      const started = await oidc.start(safeNext(typeof request.query.next === 'string' ? request.query.next : '/'));
      const tie = cookie(started.cookie.name, started.cookie.value, {
        maxAgeSeconds: started.cookie.maxAgeMs / 1000,
        secure: auth.secure,
      });
      return reply.header('set-cookie', tie).redirect(started.location);
    } catch (failure) {
      // The provider's document could not be read: its trouble, said on the login page; the next try asks again.
      auth.counted('oidc', 'unavailable');
      log.warn('could not start a login through SSO', { reason: reasonOf(failure) });
      return reply.redirect('/login?error=sso-unavailable');
    }
  });
  app.get('/auth/sso/callback', async (request, reply) => {
    // The cookie that tied the login to this browser has done its job, whatever happens next.
    reply.header('set-cookie', cookie(SSO_COOKIE, '', { maxAgeSeconds: 0, secure: auth.secure }));
    const oidc = auth.oidc;
    const settings = deps.loginSettings?.oidc;
    if (!oidc || !settings) return reply.redirect('/login?error=no-sso');
    // Counted before the provider is asked, and refused when the address failed too often: a blocked address must not
    // be able to make jukecord trade codes on and on, nor many sent at once all be traded before any is counted. A try
    // that was no failure is forgiven at the end.
    const keys = [addressFailures(request.ip)];
    if (!(await auth.limiter.enter(keys))) {
      auth.counted('oidc', 'blocked');
      return reply.redirect('/login?error=too-many');
    }
    let failed = false;
    // The provider's answer, as it put it after the "?".
    const query = new URLSearchParams(request.raw.url?.split('?')[1] ?? '');
    try {
      const { identity, next } = await oidc.finish(query, parseCookies(request.headers.cookie).get(SSO_COOKIE));
      const level = levelOf(identity.groups, settings.groups, sameOidcGroup);
      // Their Discord user, when the provider names one and a bot is there to ask about it (deps.directory).
      const principal = await auth.admit('oidc', identity, level, deps.directory() !== null);
      if (!principal) {
        auth.counted('oidc', 'denied');
        log.info('refused a login through SSO: in none of the groups jukecord lets in', {
          user: identity.name,
          groups: identity.groups.length,
        });
        return reply.redirect('/login?error=no-group');
      }
      // Asked afresh at a Discord user's login: someone refused a minute ago may have joined a server since.
      if (principal.kind === 'user') deps.access.forget(principal.userId);
      reply.header('set-cookie', [
        cookie(SSO_COOKIE, '', { maxAgeSeconds: 0, secure: auth.secure }),
        await auth.startSession(principal),
      ]);
      auth.counted('oidc', 'ok');
      log.info('logged in through SSO', {
        user: identity.name,
        level: level ?? undefined,
        ...(principal.kind === 'user' ? { discord: true } : {}),
      });
      return reply.redirect(next);
    } catch (failure) {
      const code = failure instanceof OidcError ? failure.code : 'failed';
      // Only a code the provider refused counts, as any failed login does. The provider not answering is not the
      // person's failure, nor is turning back there; nor is a state that is no login of this browser (an old tab, or a
      // link or an image another page points here), or any page could lock its visitors' address out.
      failed = code === 'failed';
      auth.counted('oidc', code === 'unavailable' ? 'unavailable' : code === 'cancelled' ? 'denied' : 'failed');
      log.info('a login through SSO did not go through', { reason: reasonOf(failure) });
      return reply.redirect(`/login?error=sso-${code}`);
    } finally {
      if (!failed) await auth.limiter.forgive(keys);
    }
  });

  // Logging in with an account of the host's directory (LDAP, Active Directory): the login page's form sends the name
  // and the password here, from the panel's own pages only (another site cannot log a browser in as someone). Held
  // back per address and per name before the directory is asked, so neither a guess at one account from many places
  // nor many accounts from one place goes fast.
  app.post<{ Body: { username?: unknown; password?: unknown; next?: unknown } }>(
    '/auth/directory',
    async (request, reply) => {
      if (!sameOrigin(request, options.publicUrl)) {
        return failure(reply, 'forbidden', 'connections come from the panel only');
      }
      const ldap = auth.ldap;
      const settings = deps.loginSettings?.ldap;
      if (!ldap || !settings)
        return failure(reply, 'not-found', 'logging in with a directory account is not set up here');
      const body = request.body ?? {};
      const username = typeof body.username === 'string' ? body.username : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const refused = (status: number, code: string, message: string) =>
        reply.code(status).send({ error: { code, message } });
      // Counted before the directory is asked, and refused when the address or the name failed too often: tries sent
      // at the same moment are each counted before any is answered, so twenty get through however many come at once.
      // A try that was no failure (a person let in, a directory that did not answer) is forgiven at the end.
      const keys = [addressFailures(request.ip), nameFailures('ldap', username)];
      if (!(await auth.limiter.enter(keys))) {
        auth.counted('ldap', 'blocked');
        return refused(429, 'too-many', 'too many failed logins; wait ten minutes');
      }
      let failed = false;
      try {
        const identity = await ldap.login(username, password);
        const level = levelOf(identity.groups, settings.groups, sameLdapGroup);
        const principal = await auth.admit('ldap', identity, level, false);
        if (!principal) {
          auth.counted('ldap', 'denied');
          log.info('refused a directory login: in none of the groups jukecord lets in', {
            user: identity.name,
            groups: identity.groups.length,
          });
          return refused(403, 'no-group', 'your account is in none of the groups jukecord lets in');
        }
        auth.counted('ldap', 'ok');
        log.info('logged in with a directory account', { user: identity.name, level: level ?? undefined });
        const next = safeNext(typeof body.next === 'string' ? body.next : '/');
        return reply.header('set-cookie', await auth.startSession(principal)).send({ ok: true, next });
      } catch (failure) {
        const code = failure instanceof LdapError ? failure.code : 'unavailable';
        // The name or password the person typed is never in the log, nor in what the panel is told: only why.
        log.info('a directory login did not go through', { reason: code, detail: reasonOf(failure) });
        if (code === 'invalid') return refused(400, 'invalid', 'type your name and your password');
        if (code === 'unavailable') {
          auth.counted('ldap', 'unavailable');
          return refused(503, 'directory-down', 'the directory did not answer; try again in a moment');
        }
        if (code === 'ambiguous') {
          auth.counted('ldap', 'denied');
          return refused(409, 'ambiguous', 'the directory has more than one account by that name');
        }
        // A refused name or password stays counted against the address and the name; the try after the twentieth is
        // refused before the directory is asked.
        failed = true;
        auth.counted('ldap', 'failed');
        if (code === 'expired') return refused(403, 'password-expired', 'your password has expired; change it first');
        if (code === 'disabled') return refused(403, 'account-disabled', 'your account is turned off or locked');
        return refused(401, 'wrong-password', 'wrong name or password');
      } finally {
        if (!failed) await auth.limiter.forgive(keys);
      }
    },
  );

  // A one-time login link from `jukecord open`: the browser becomes the host, or the host's friend with the view or
  // control the link was made for.
  app.get<{ Params: { code: string } }>('/auth/link/:code', async (request, reply) => {
    // A link that works logs in even from a blocked address (it was made by the host a moment ago); one that does not
    // counts as a failure, and from a blocked address says so.
    const scope = await auth.useLink(request.params.code);
    if (scope === null) {
      const blocked = await auth.limiter.fail([addressFailures(request.ip)]);
      auth.counted('link', blocked ? 'blocked' : 'failed');
      return reply.redirect(blocked ? '/login?error=too-many' : '/login?error=link');
    }
    auth.counted('link', 'ok');
    log.info(scope === 'admin' ? 'logged in with a login link' : 'a friend logged in with a login link', { scope });
    return reply.header('set-cookie', await auth.startLinkSession(scope)).redirect('/');
  });
  // A listening link: /listen#<code> is the panel's own page, which sends the code here (the part after "#" never
  // reaches a server, so no log or proxy sees it). The browser comes in as a guest of the link, unless it is logged
  // in already. Only from the panel's own pages: another site cannot make a browser its guest.
  app.post<{ Body: { code?: unknown } }>('/auth/listen', async (request, reply) => {
    if (!sameOrigin(request, options.publicUrl)) {
      return failure(reply, 'forbidden', 'connections come from the panel only');
    }
    const code = typeof request.body?.code === 'string' ? request.body.code : '';
    const { caller } = await identify(request);
    const used = await auth.useListenLink(code, caller);
    if (used.kind === 'invalid') {
      // A code that does not work is a failed login like any other (a guess at the codes is held back).
      const blocked = await auth.limiter.fail([addressFailures(request.ip)]);
      auth.counted('listen', blocked ? 'blocked' : 'failed');
      return blocked
        ? failure(reply, 'too-many', 'too many failed logins; wait ten minutes')
        : failure(reply, 'not-found', 'this listening link has ended or does not exist');
    }
    if (used.kind === 'full') {
      auth.counted('listen', 'denied');
      return failure(reply, 'conflict', 'this listening link has as many guests as it allows');
    }
    if (used.kind === 'already') return reply.send({ ok: true });
    auth.counted('listen', 'ok');
    log.info('a guest came in with a listening link', { link: used.linkId, guild: used.guildId });
    return reply.header('set-cookie', used.cookie).send({ ok: true });
  });
  app.post('/auth/logout', async (request, reply) => {
    const { caller, blocked } = await identify(request);
    if (blocked) return failure(reply, 'too-many', 'too many failed logins; wait ten minutes');
    if (caller && !auth.csrfOk(caller, request.headers[CSRF_HEADER] as string | undefined)) {
      return failure(reply, 'forbidden', "the logout came without the panel's CSRF token");
    }
    if (caller?.principal.kind === 'user') deps.access.forget(caller.principal.userId);
    // This browser's live connection ends with its login (on every edge of a split jukecord).
    if (caller?.sessionHash) hub.endSession(caller.sessionHash);
    const ended = await auth.endSession(caller);
    // A login through the host's identity provider logs out there too, when it offers that: the panel goes where the
    // answer says, and the provider sends it back to the login page. Every other logout answers nothing, as before.
    const principal = caller?.principal;
    const throughSso =
      principal !== undefined &&
      ((principal.kind === 'member' && principal.provider === 'oidc') ||
        (principal.kind === 'user' && principal.level !== undefined));
    const next = throughSso ? await auth.oidc?.logoutUrl() : null;
    if (next) return reply.header('set-cookie', ended).send({ next });
    return reply.header('set-cookie', ended).code(204).send();
  });

  // Health: alive (the process answers, nothing checked: a liveness probe must not fail for a database that is down),
  // ready (it can serve: each part's state, kept for a second), and the figures for Prometheus.
  app.get('/healthz', async (_request, reply) => reply.type('text/plain').send('ok\n'));
  app.get('/readyz', async (_request, reply) => {
    const readiness = await options.health.read();
    return reply
      .code(readiness.ready ? 200 : 503)
      .header('cache-control', 'no-store')
      .send(readiness);
  });
  // Metrics are for a scraper beside jukecord (on the same machine, in the same cluster or network), or one that shows
  // the metrics token, not for the internet: a request that came through the reverse proxy (it carries
  // X-Forwarded-For, or the standard Forwarded) or from a public address, without the token, gets the 404 any unknown
  // path gets, so the version and the counts are not handed to everyone (src/metrics/http.ts). The connection's own
  // address decides, not a forwarded one.
  app.get('/metrics', async (request, reply) => {
    const verdict = gate.verdict(request.socket.remoteAddress ?? '', request.headers);
    if (verdict === 'hidden') return reply.code(404).send({ error: { code: 'not-found', message: 'no such path' } });
    if (verdict === 'wrong-token') {
      return failure(reply.header('www-authenticate', 'Bearer'), 'unauthorized', 'the metrics token is not right');
    }
    // Prometheus asks for OpenMetrics first; anything else gets the text format.
    const exposition = negotiate(request.headers.accept);
    const text = await registry.scrape(exposition.format);
    reply.type(exposition.contentType).header('cache-control', 'no-store').header('vary', 'accept, accept-encoding');
    if (!/\bgzip\b/.test(String(request.headers['accept-encoding'] ?? ''))) return reply.send(text);
    return reply.header('content-encoding', 'gzip').send(await gzipped(text));
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
      // A cache of its own goes with the server; a shared one is its owner's to close.
      await ownCache?.close();
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

/** The operation names the server answers (for tests). */
export const SERVED: readonly OperationName[] = OPERATIONS;
