/**
 * Who may read `/metrics`, and in which format it is written for them.
 *
 * The metrics need no login, so by default only a scraper beside jukecord reads them: one on this machine or its
 * private network, asking directly (a request that came through a reverse proxy carries X-Forwarded-For or Forwarded,
 * and is refused like one from a public address). A Prometheus elsewhere (another network, behind a proxy, a service
 * mesh's sidecar that adds forwarding headers) shows the metrics token instead (JUKECORD_METRICS_TOKEN), as
 * `Authorization: Bearer <token>`. Without a token set, the rule is the address rule alone, as before the token.
 *
 * A refusal is the 404 every unknown path gets, so the version and the counts tell the internet nothing; only a wrong
 * token is told so (401), since whoever sent one meant to be let in and is better off knowing why they were not.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { isPrivateAddress } from '../media/address.ts';
import type { ExpositionFormat } from './registry.ts';

/** What a request to `/metrics` gets: the metrics, the 404 of an unknown path, or a 401 for a wrong token. */
export type MetricsVerdict = 'allowed' | 'hidden' | 'wrong-token';

/** The format to write and the type to answer with. */
export interface Exposition {
  readonly format: ExpositionFormat;
  readonly contentType: string;
}

/** Prometheus's text format, the default for every client that does not ask for OpenMetrics. */
export const TEXT_EXPOSITION: Exposition = { format: 'text', contentType: 'text/plain; version=0.0.4; charset=utf-8' };

// The SHA-256 of a text: two of them always have the same length, which timingSafeEqual needs.
function digest(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

/** The rule for `/metrics`, with the token it accepts (or none). */
export class MetricsGate {
  // The token's digest, made once for each token; null when no token is set (the address rule alone). Changed while
  // jukecord runs when the settings say so (JUKECORD_METRICS_TOKEN applies at once).
  private token: Buffer | null;

  constructor(token: string | null) {
    this.token = token === null ? null : digest(token);
  }

  /** The token a scraper shows from now on (null: none, the address rule alone). */
  setToken(token: string | null): void {
    this.token = token === null ? null : digest(token);
  }

  /** Whether a token is set (the startup line says so). */
  get hasToken(): boolean {
    return this.token !== null;
  }

  /** The verdict for a request from `peer` (the connection's own address, never a forwarded one) with these headers. */
  verdict(peer: string, headers: IncomingHttpHeaders): MetricsVerdict {
    if (this.token !== null) {
      // A bearer token shown is judged by itself, wherever the request comes from: right lets it in, wrong does not
      // fall back to the address (a scraper with a stale token is told, not let in by luck of where it runs).
      const shown = /^Bearer\s+(\S+)\s*$/i.exec(headers.authorization ?? '')?.[1];
      if (shown !== undefined) {
        // Compared by digest in constant time: how long the comparison takes says nothing about the token.
        return timingSafeEqual(digest(shown), this.token) ? 'allowed' : 'wrong-token';
      }
    }
    // The address rule: asked directly from this machine or a private network, and not through a proxy.
    const forwarded = headers['x-forwarded-for'] !== undefined || headers.forwarded !== undefined;
    return forwarded || !isPrivateAddress(peer) ? 'hidden' : 'allowed';
  }
}

// One entry of an Accept header: the type, its parameters, how much it is wanted, and where it stood.
interface Wanted {
  readonly type: string;
  readonly version: string | null;
  readonly q: number;
  readonly order: number;
}

// Reads an Accept header into its entries.
function wanted(accept: string): Wanted[] {
  return accept
    .split(',')
    .map((part, order) => {
      const [type = '', ...parameters] = part.split(';').map((piece) => piece.trim());
      let q = 1;
      let version: string | null = null;
      for (const parameter of parameters) {
        const [name = '', value = ''] = parameter.split('=').map((piece) => piece.trim());
        if (name.toLowerCase() === 'q') q = Number(value);
        if (name.toLowerCase() === 'version') version = value;
      }
      // A q that is not a number counts as not wanted, as a malformed one should.
      return { type: type.toLowerCase(), version, q: Number.isFinite(q) ? q : 0, order };
    })
    .filter((entry) => entry.type !== '' && entry.q > 0);
}

// What jukecord can write for one entry: OpenMetrics (1.0.0 or 0.0.1, the versions Prometheus asks for), the text
// format (for text/plain of any version, which every Prometheus reads, and for anything at all), or nothing.
function offered(entry: Wanted): Exposition | null {
  if (entry.type === 'application/openmetrics-text' || entry.type === 'application/*') {
    const version = entry.version ?? '1.0.0';
    if (version !== '1.0.0' && version !== '0.0.1') return null;
    return { format: 'openmetrics', contentType: `application/openmetrics-text; version=${version}; charset=utf-8` };
  }
  if (entry.type === 'text/plain' || entry.type === 'text/*' || entry.type === '*/*') return TEXT_EXPOSITION;
  return null;
}

/**
 * The format for a request's Accept header: the one it wants most (the first named of equals), the text format when
 * it names neither (curl's `*\/*`, or no header at all). Prometheus asks for OpenMetrics first, then the text format.
 */
export function negotiate(accept: string | undefined): Exposition {
  if (!accept) return TEXT_EXPOSITION;
  let best: { exposition: Exposition; q: number; order: number } | null = null;
  for (const entry of wanted(accept)) {
    const exposition = offered(entry);
    if (!exposition) continue;
    if (!best || entry.q > best.q || (entry.q === best.q && entry.order < best.order)) {
      best = { exposition, q: entry.q, order: entry.order };
    }
  }
  return best?.exposition ?? TEXT_EXPOSITION;
}
