/**
 * The shapes of jukecord's HTTP answers that more than one server makes: the error every refusal is, the refusal that
 * says when to ask again, and a wait with a time limit. The web server (server.ts), the audio and covers
 * (files.ts) and the core's internal port (roles/internal.ts) answer alike with them.
 */
import type { FastifyReply } from 'fastify';

/** The HTTP status of each error code. */
export const STATUS: Readonly<Record<string, number>> = {
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

/** What a refusal says when jukecord sheds work it can do later. */
export const BUSY = 'jukecord is busy; try again in a moment';
/** What a refusal of a read says when a login or an address asks faster than the rates allow. */
export const TOO_MANY_READS = 'too many requests at once; try again in a moment';

/** The answer for an error, in the one shape every API error has (a refused change of settings adds its problems). */
export function failure(
  reply: FastifyReply,
  code: string,
  message: string,
  problems?: readonly { readonly names: readonly string[]; readonly message: string }[],
): FastifyReply {
  return reply.code(STATUS[code] ?? 500).send({ error: { code, message, ...(problems ? { problems } : {}) } });
}

/** A refusal that says when to try again (Retry-After, in whole seconds). */
export function later(reply: FastifyReply, code: string, message: string, ms: number): FastifyReply {
  return failure(reply.header('retry-after', String(Math.max(1, Math.ceil(ms / 1000)))), code, message);
}

/**
 * Waits for `promise` at most `ms`: its value when it settled in time, `undefined` when the time ran out first (the
 * promise goes on; whoever made it keeps it). A rejection in time is passed on.
 */
export async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
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
