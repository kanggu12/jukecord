/**
 * The audio and the covers browsers get from jukecord: from this process's media cache (one process, and the core's
 * internal port for its edges), or streamed from the core by an edge, which has no media of its own.
 *
 * Both answer the same: the same checks (a track the server plays or shows, a picture fetched within the cover rate),
 * the same files with the same headers, Range requests and the MP3 copy included, and the same refusals. Who the
 * caller is and what they may open is decided before (web/server.ts): these take the server and, for a cover, what the
 * caller's context says and the keys its cover rate counts under (none for the host).
 */
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type ActionContext, likesOwner } from '../app/actions.ts';
import { CORE_AWAY, CORE_LATE } from '../bus/commands.ts';
import type { Players } from '../core/players.ts';
import type { QueueService } from '../core/queue.ts';
import type { NewTrack, Track } from '../core/types.ts';
import type { Logger } from '../log.ts';
import { BusyError } from '../media/busy.ts';
import { MediaCache } from '../media/cache.ts';
import type { CoverFile, Covers, Pictured } from '../media/covers.ts';
import type { Store } from '../store/store.ts';
import type { Limit } from './limits.ts';
import { BUSY, failure, later, TOO_MANY_READS, within } from './replies.ts';

/** What an audio request is told while the MP3 copy it asked for is still being made. */
export const MAKING_MP3 = 'jukecord is making the MP3 copy of this track; try again in a moment';

/** Where the audio and the covers come from. */
export interface Files {
  /** The audio of a track a server plays or has queued, as Opus, or the MP3 copy (`mp3`), Range requests honoured. */
  audio(
    request: FastifyRequest,
    reply: FastifyReply,
    guildId: string,
    trackId: number,
    mp3: boolean,
  ): Promise<FastifyReply>;
  /**
   * A track's cover, for a track the server shows somewhere (playing, queued, played, in a playlist, or liked by the
   * caller unless a guest). `keys` are what fetching a cover not cached yet is counted under; null for the host.
   */
  cover(
    request: FastifyRequest,
    reply: FastifyReply,
    context: ActionContext,
    guest: boolean,
    trackId: number,
    keys: readonly string[] | null,
  ): Promise<FastifyReply>;
  /** The picture of a result a search showed lately, by its address, to someone who may search. */
  searchCover(
    request: FastifyRequest,
    reply: FastifyReply,
    context: ActionContext,
    address: string,
    keys: readonly string[] | null,
  ): Promise<FastifyReply>;
}

export interface MediaFilesOptions {
  readonly players: Players;
  readonly queue: QueueService;
  readonly store: Store;
  readonly cache: MediaCache;
  /** Makes the MP3 copy of a cached track for browsers without Opus. */
  readonly mp3: (track: Track, signal: AbortSignal) => Promise<string | null>;
  readonly covers: Covers;
  /** A track a search showed lately, by its address (Actions.searched: it refuses someone who may not search). */
  readonly searched: (context: ActionContext, address: string) => Promise<NewTrack | null>;
  /** The rate of covers fetched on request. */
  readonly coverRate: Limit;
  /** Whether this process has fallen behind (a cover not cached is not fetched then). */
  readonly behind: () => boolean;
  /** Aborted when the server stops: an MP3 copy shared by several requests stops with jukecord. */
  readonly stopping: AbortSignal;
  /** How long an audio request waits for an MP3 copy being made before it is told to ask again (default 5 s). */
  readonly mp3WaitMs?: number;
}

/** The files of this process's own media cache. */
export class MediaFiles implements Files {
  private readonly options: MediaFilesOptions;

  constructor(options: MediaFilesOptions) {
    this.options = options;
  }

  async audio(
    _request: FastifyRequest,
    reply: FastifyReply,
    guildId: string,
    trackId: number,
    mp3: boolean,
  ): Promise<FastifyReply> {
    const { players, queue, store, cache } = this.options;
    const valid = Number.isSafeInteger(trackId) && trackId > 0;
    const current = players.get(guildId).snapshot().track;
    // Asked of the index, not by reading the queue: a browser seeking sends a Range request each time.
    const queued = valid && (current?.id === trackId || (await queue.contains(guildId, trackId)));
    const track = queued ? await store.tracks.get(trackId) : null;
    if (!track) return failure(reply, 'not-found', 'that track is not playing or queued in this server');
    const key = MediaCache.keyOf(track.source);
    if (!cache.has(key)) return failure(reply, 'conflict', 'the track is not prepared yet');
    let file = cache.opusPath(key);
    if (mp3) {
      // Shared by everyone asking at once and not tied to this request: a second browser may be waiting for it. It
      // ends at its own time limit, which grows with the track (see Media.mp3), or when jukecord stops.
      const making = this.options.mp3(track, this.options.stopping);
      // A copy that fails after every request stopped waiting for it is Media's to log, not an unhandled rejection.
      making.catch(() => {});
      // The request waits a few seconds, which covers the copy of an ordinary song. A long track takes longer (an
      // hour of audio took most of a minute under two processors), and a request waiting on it moves nothing on its
      // connection, which the idle limit then cut with no answer at all: it is told to ask again instead (503 with
      // Retry-After, which the panel takes as "not now"), and the copy goes on meanwhile.
      let made: string | null | undefined;
      try {
        made = await within(making, this.options.mp3WaitMs ?? 5000);
      } catch (error) {
        if (error instanceof BusyError) return later(reply, 'unavailable', error.message, 2000);
        throw error;
      }
      if (made === undefined) return later(reply, 'unavailable', MAKING_MP3, 2000);
      if (!made) return failure(reply, 'conflict', 'the track is not prepared yet');
      file = made;
    }
    // A track's file does not change once made; the browser may keep it for a day.
    return reply.header('cache-control', 'private, max-age=86400').sendFile(path.basename(file), path.dirname(file));
  }

  async cover(
    _request: FastifyRequest,
    reply: FastifyReply,
    context: ActionContext,
    guest: boolean,
    trackId: number,
    keys: readonly string[] | null,
  ): Promise<FastifyReply> {
    const { players, queue, store } = this.options;
    const valid = Number.isSafeInteger(trackId) && trackId > 0;
    // Each question is one lookup by an index, cheapest first: the player, the queue, the history, the playlists, and
    // this login's likes (a login's own in every server it opens, so its liked list shows them here too; a guest has
    // none).
    const shown =
      valid &&
      (players.get(context.guildId).snapshot().track?.id === trackId ||
        (await queue.contains(context.guildId, trackId)) ||
        (await store.history.has(context.guildId, trackId)) ||
        (await store.playlists.has(context.guildId, trackId)) ||
        (!guest && (await store.likes.has(likesOwner(context), trackId))));
    const track = shown ? await store.tracks.get(trackId) : null;
    if (!track) return failure(reply, 'not-found', 'that track is not in this server');
    return this.sendCover(reply, track, 'that track has no cover', keys);
  }

  async searchCover(
    _request: FastifyRequest,
    reply: FastifyReply,
    context: ActionContext,
    address: string,
    keys: readonly string[] | null,
  ): Promise<FastifyReply> {
    const found = await this.options.searched(context, address);
    if (!found) return failure(reply, 'not-found', 'no search found that address lately');
    return this.sendCover(reply, found, 'that search result has no picture', keys);
  }

  // Sends a cover from the cache, or fetches it once first (src/media/covers.ts): within the cover rate of the login and
  // its address, and not while jukecord is behind. A picture that cannot be had, or none at all, answers `missing`,
  // which the browser need not ask again for an hour: as long as jukecord remembers the failure.
  private async sendCover(
    reply: FastifyReply,
    pictured: Pictured,
    missing: string,
    keys: readonly string[] | null,
  ): Promise<FastifyReply> {
    const { covers } = this.options;
    const none = () => failure(reply.header('cache-control', 'private, max-age=3600'), 'not-found', missing);
    if (!pictured.thumbnail) return none();
    let cover: CoverFile | null = covers.cached(pictured);
    if (!cover) {
      if (this.options.behind()) return later(reply, 'busy', BUSY, 2000);
      // The host is not held to a rate, as for every other request.
      if (keys !== null) {
        const wait = await this.options.coverRate.spend(keys);
        if (wait > 0) return later(reply, 'rate-limited', TOO_MANY_READS, wait);
      }
      try {
        cover = await covers.get(pictured);
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
  }
}

/** The path every internal request of an edge is under, at the core's internal port. */
export const INTERNAL_PREFIX = '/internal/v1';

// What a browser sends that the core's answer depends on (seeking, a file it has already), passed on as it is.
const ASKED = ['range', 'if-range', 'if-none-match', 'if-modified-since'];
// What the core's answer says that the browser needs, passed back as it is; jukecord's own security headers are added
// by the edge's server as for any answer.
const ANSWERED = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
  'cache-control',
  'retry-after',
];

export interface RemoteFilesOptions {
  /** The core's internal port (JUKECORD_CORE_URL). */
  readonly coreUrl: string;
  /** The secret the core and its edges share (JUKECORD_INTERNAL_SECRET). */
  readonly secret: string;
  readonly log: Logger;
  /** How long the core may take to start its answer (default 15 s: an MP3 copy waits five at most). */
  readonly answerMs?: number;
}

/** An edge's files: streamed from the core's internal port (roles/internal.ts), which answers them from its cache. */
export class RemoteFiles implements Files {
  private readonly options: RemoteFilesOptions;
  // One pool of kept-alive connections to the core for every browser this edge serves.
  private readonly agent: http.Agent;
  private readonly base: URL;
  private failedToldAt = Number.NEGATIVE_INFINITY;

  constructor(options: RemoteFilesOptions) {
    this.options = options;
    this.base = new URL(options.coreUrl);
    this.agent =
      this.base.protocol === 'https:'
        ? new https.Agent({ keepAlive: true, maxSockets: 256 })
        : new http.Agent({ keepAlive: true, maxSockets: 256 });
  }

  audio(request: FastifyRequest, reply: FastifyReply, guildId: string, trackId: number, mp3: boolean) {
    return this.forward(request, reply, 'audio', {
      guild: guildId,
      track: String(trackId),
      ...(mp3 ? { format: 'mp3' } : {}),
    });
  }

  cover(
    request: FastifyRequest,
    reply: FastifyReply,
    context: ActionContext,
    guest: boolean,
    trackId: number,
    keys: readonly string[] | null,
  ) {
    return this.forward(request, reply, 'cover', {
      context: JSON.stringify(context),
      guest: guest ? '1' : '0',
      track: String(trackId),
      ...(keys ? { keys: JSON.stringify(keys) } : {}),
    });
  }

  searchCover(
    request: FastifyRequest,
    reply: FastifyReply,
    context: ActionContext,
    address: string,
    keys: readonly string[] | null,
  ) {
    return this.forward(request, reply, 'search-cover', {
      context: JSON.stringify(context),
      url: address,
      ...(keys ? { keys: JSON.stringify(keys) } : {}),
    });
  }

  /** Lets go of the connections kept to the core (the edge is stopping). */
  close(): void {
    this.agent.destroy();
  }

  // Asks the core's internal port and hands its answer to the browser as it comes: the status, the headers that
  // matter, and the body streamed (an hour of audio is not held in memory). A core that cannot be reached, or does
  // not start its answer in time, is "unavailable" with a Retry-After, as every call to it is.
  private forward(
    request: FastifyRequest,
    reply: FastifyReply,
    what: string,
    query: Record<string, string>,
  ): Promise<FastifyReply> {
    const url = new URL(`${INTERNAL_PREFIX}/${what}`, this.base);
    url.search = new URLSearchParams(query).toString();
    const headers: Record<string, string> = { authorization: `Bearer ${this.options.secret}` };
    for (const name of ASKED) {
      const value = request.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    const client = url.protocol === 'https:' ? https : http;
    return new Promise<FastifyReply>((resolve) => {
      let settled = false;
      // Whether the browser went away before the core's answer came: nothing is sent then.
      let gone = false;
      const done = (answer: FastifyReply) => {
        if (settled) return;
        settled = true;
        resolve(answer);
      };
      const upstream = client.request(url, { method: 'GET', headers, agent: this.agent }, (answer) => {
        clearTimeout(timer);
        if (settled) {
          answer.destroy();
          return;
        }
        for (const name of ANSWERED) {
          const value = answer.headers[name];
          if (value !== undefined) reply.header(name, value);
        }
        done(reply.code(answer.statusCode ?? 502).send(answer));
      });
      // The core is slow to start its answer (it waits at most a few seconds itself): asked again later.
      const timer = setTimeout(() => {
        if (settled) return;
        upstream.destroy(new Error('the core did not answer in time'));
        done(later(reply, 'unavailable', CORE_LATE, 2000));
      }, this.options.answerMs ?? 15_000);
      timer.unref();
      upstream.on('error', (error) => {
        clearTimeout(timer);
        // Cut while the answer was on its way (the core stopped): the browser's connection ends with it, and the
        // browser asks again (an audio element does, from where it was).
        if (settled) return;
        // Stopped because the browser went away: there is nobody to answer.
        if (gone) {
          reply.hijack();
          done(reply);
          return;
        }
        this.failed(error);
        done(later(reply, 'unavailable', CORE_AWAY, 2000));
      });
      // The browser went away (before the answer, or during it): nothing more is asked of the core, and what it
      // still sends is dropped with the connection to it. The answer's end is no going away.
      reply.raw.once('close', () => {
        if (reply.raw.writableFinished) return;
        gone = true;
        upstream.destroy();
      });
      upstream.end();
    });
  }

  // A core that cannot be reached is told in the log once a minute, not once per request.
  private failed(error: Error): void {
    if (Date.now() - this.failedToldAt < 60_000) return;
    this.failedToldAt = Date.now();
    this.options.log.warn('could not reach the core for audio or a cover', { reason: error.message });
  }
}
