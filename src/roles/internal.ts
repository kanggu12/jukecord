/**
 * The core's internal port (JUKECORD_INTERNAL_PORT, 8796): the audio and the covers of its media cache, for its edges
 * and nothing else.
 *
 * Every request must carry the secret the core and its edges share (JUKECORD_INTERNAL_SECRET) as a bearer token,
 * compared in constant time; anything else is refused before it is looked at. The edge has decided who the browser is
 * and what it may open, so a request names the server, the track and, for a cover, what the caller's context says
 * and the keys its cover rate counts under: the answer is what one process would have answered (files.ts), Range
 * requests and the MP3 copy included, and the edge streams it on as it comes.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ActionContext } from '../app/actions.ts';
import { ActionError } from '../app/actions.ts';
import type { Logger } from '../log.ts';
import { ConnectionError, DATABASE_DOWN, DATABASE_RETRY_MS } from '../store/network.ts';
import { StoreError } from '../store/store.ts';
import { type Files, INTERNAL_PREFIX } from '../web/files.ts';
import { BUSY, failure, later } from '../web/replies.ts';

export interface InternalServerOptions {
  readonly host: string;
  readonly port: number;
  /** The secret every request must carry. */
  readonly secret: string;
  /** This process's audio and covers (MediaFiles). */
  readonly files: Files;
  /** The media cache's folder, which the files are sent from. */
  readonly cacheDir: string;
  /** Whether the core has fallen behind: sending audio then waits, as one process's does. */
  readonly behind: () => boolean;
  readonly log: Logger;
}

export interface InternalServer {
  readonly app: FastifyInstance;
  listen(): Promise<string>;
  close(): Promise<void>;
}

// A server ID as the API takes it: a Discord snowflake, or "local" in browser-only mode.
const GUILD = /^(\d{17,20}|local)$/;

// The secret's hash, to compare in constant time whatever its length.
function digest(text: string): Buffer {
  return createHash('sha256').update(text).digest();
}

// A caller's context as an edge sends it, or null when it is not one.
function contextOf(text: unknown): ActionContext | null {
  if (typeof text !== 'string') return null;
  try {
    const value = JSON.parse(text) as Partial<ActionContext>;
    if (typeof value.guildId !== 'string' || !GUILD.test(value.guildId)) return null;
    return {
      guildId: value.guildId,
      userId: typeof value.userId === 'string' ? value.userId : null,
      mayControl: value.mayControl === true,
      mayManage: value.mayManage === true,
    };
  } catch {
    return null;
  }
}

// The keys of a cover rate as an edge sends them (none: the host, who is not held to it).
function keysOf(text: unknown): string[] | null {
  if (typeof text !== 'string') return null;
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : null;
  } catch {
    return null;
  }
}

export async function createInternalServer(options: InternalServerOptions): Promise<InternalServer> {
  const app = Fastify({ logger: false, bodyLimit: 1024 });
  const expected = digest(options.secret);
  // Only jukecord's edges: the secret first, before anything else is looked at.
  app.addHook('onRequest', async (request, reply) => {
    const given = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '')?.[1] ?? '';
    if (!timingSafeEqual(digest(given), expected)) {
      return failure(reply, 'unauthorized', "this port answers jukecord's edges only");
    }
  });
  // A refusal is the answer it would be in one process; anything else is logged here and is the edge's 500.
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ActionError) {
      if (error.retryAfterMs !== null) return later(reply, error.code, error.message, error.retryAfterMs);
      return failure(reply, error.code, error.message);
    }
    if (error instanceof StoreError) return failure(reply, 'invalid', error.message);
    // The database not answering: the edge's browser is told to ask again, as one process tells it (web/server.ts).
    if (error instanceof ConnectionError) return later(reply, 'unavailable', DATABASE_DOWN, DATABASE_RETRY_MS);
    options.log.error("an edge's request failed", { url: request.url.split('?')[0], error });
    return reply
      .code(500)
      .send({ error: { code: 'internal', message: 'something went wrong in jukecord (see its log)' } });
  });
  // sendFile, for the files of the media cache; nothing is served by its path, and the caching headers are the ones
  // the answers set themselves (files.ts), as on the panel's port.
  await app.register(fastifyStatic, { root: options.cacheDir, serve: false, cacheControl: false, index: false });

  app.get<{ Querystring: { guild?: string; track?: string; format?: string } }>(
    `${INTERNAL_PREFIX}/audio`,
    async (request, reply) => {
      const { guild, track, format } = request.query;
      if (typeof guild !== 'string' || !GUILD.test(guild)) return failure(reply, 'invalid', 'no server named');
      // Sending audio is the heaviest thing jukecord does for a browser; while it is behind, the browser asks again.
      if (options.behind()) return later(reply, 'busy', BUSY, 2000);
      return options.files.audio(request, reply, guild, Number(track), format === 'mp3');
    },
  );
  app.get<{ Querystring: { context?: string; guest?: string; track?: string; keys?: string } }>(
    `${INTERNAL_PREFIX}/cover`,
    async (request, reply) => {
      const context = contextOf(request.query.context);
      if (!context) return failure(reply, 'invalid', 'no context');
      const guest = request.query.guest === '1';
      return options.files.cover(
        request,
        reply,
        context,
        guest,
        Number(request.query.track),
        keysOf(request.query.keys),
      );
    },
  );
  app.get<{ Querystring: { context?: string; url?: string; keys?: string } }>(
    `${INTERNAL_PREFIX}/search-cover`,
    async (request, reply) => {
      const context = contextOf(request.query.context);
      if (!context) return failure(reply, 'invalid', 'no context');
      const address = typeof request.query.url === 'string' ? request.query.url : '';
      return options.files.searchCover(request, reply, context, address, keysOf(request.query.keys));
    },
  );
  app.setNotFoundHandler(async (_request, reply) => failure(reply, 'not-found', 'no such path'));

  return {
    app,
    listen: () => app.listen({ host: options.host, port: options.port }),
    close: async () => {
      // Audio under way to an edge (whose browser may read slowly) is cut after two seconds: jukecord is stopping.
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
