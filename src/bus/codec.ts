/**
 * What goes over the bus, as text: every message is JSON with the protocol's version, and a few rules keep the values
 * an action takes and gives the same on both sides.
 *
 * JSON loses two things jukecord's values have: `undefined` in a list of arguments (an optional argument left out
 * between two given ones: JSON writes it as null, which the action would take for a value) and the kind of an error
 * (an ActionError's code is what an edge answers with: 404, 409, 503 as in one process). Both are written so they come
 * back as they were. A service that speaks another version of the protocol is not understood, and says so.
 */
import { ActionError, type ActionErrorCode } from '../app/actions.ts';
import { StoreError } from '../store/sql.ts';

/** The protocol's version: raised when a message changes in a way an older service would misread. */
export const BUS_PROTOCOL = 1;

// What an undefined argument is written as. A plain JSON object, never one an action takes (nothing takes "$u").
const UNDEFINED = { $u: 1 };

/** Arguments as JSON text, an undefined one kept as such. */
export function encodeArgs(args: readonly unknown[]): unknown[] {
  return args.map((arg) => (arg === undefined ? UNDEFINED : arg));
}

/** The arguments back, undefined where they were. */
export function decodeArgs(args: unknown): unknown[] {
  if (!Array.isArray(args)) return [];
  return args.map((arg) => (isUndefined(arg) ? undefined : arg));
}

function isUndefined(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).length === 1 &&
    (value as Record<string, unknown>).$u === 1
  );
}

/** An error as it travels: an action's refusal with everything an answer is made of, a store's, or something else. */
export type WireError =
  | {
      readonly kind: 'action';
      readonly code: ActionErrorCode;
      readonly message: string;
      readonly spent: boolean;
      readonly retryAfterMs: number | null;
    }
  | { readonly kind: 'store'; readonly message: string }
  | { readonly kind: 'internal' };

// The codes an ActionError may carry, to refuse anything else a message claims.
const CODES: ReadonlySet<string> = new Set<ActionErrorCode>([
  'invalid',
  'not-found',
  'forbidden',
  'conflict',
  'unavailable',
]);

/**
 * An error as the bus carries it. A refusal keeps its code, message, whether it cost a lookup and when to ask again;
 * a store's error keeps its message (it is a mistake in the request, which the web server answers as one); anything
 * else is jukecord's own failure, whose details stay in the log of the service where it happened.
 */
export function toWire(error: unknown): WireError {
  if (error instanceof ActionError) {
    return {
      kind: 'action',
      code: error.code,
      message: error.message,
      spent: error.spent,
      retryAfterMs: error.retryAfterMs,
    };
  }
  if (error instanceof StoreError) return { kind: 'store', message: error.message };
  return { kind: 'internal' };
}

/** A failure of the core's that the edge has no details of: its log has them. */
export class CoreFailure extends Error {
  override name = 'CoreFailure';
}

/** The error back as the caller would have had it in one process. */
export function fromWire(wire: unknown, command: string): Error {
  const error = (typeof wire === 'object' && wire !== null ? wire : {}) as Partial<Record<string, unknown>>;
  if (error.kind === 'action' && typeof error.code === 'string' && CODES.has(error.code)) {
    const retry = typeof error.retryAfterMs === 'number' ? { retryAfterMs: error.retryAfterMs } : {};
    return new ActionError(error.code as ActionErrorCode, String(error.message ?? ''), {
      spent: error.spent === true,
      ...retry,
    });
  }
  if (error.kind === 'store') return new StoreError(String(error.message ?? ''));
  return new CoreFailure(`the core failed at ${command}; its log says why`);
}

/** A message as text, with the protocol's version first. */
export function encode(message: Record<string, unknown>): string {
  return JSON.stringify({ v: BUS_PROTOCOL, ...message });
}

/** What a message says, or why it cannot be read: not JSON, or another version of the protocol. */
export function decode(text: string): { ok: true; message: Record<string, unknown> } | { ok: false; why: string } {
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return { ok: false, why: 'a message that is not JSON' };
  }
  if (typeof message !== 'object' || message === null || Array.isArray(message))
    return { ok: false, why: 'a message that is not an object' };
  const version = (message as { v?: unknown }).v;
  if (version !== BUS_PROTOCOL) {
    return {
      ok: false,
      why: `a message of bus protocol ${String(version)} (this jukecord speaks ${BUS_PROTOCOL}): run one version of jukecord in every service`,
    };
  }
  return { ok: true, message: message as Record<string, unknown> };
}
