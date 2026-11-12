/**
 * jukecord's own requests to services outside (the lyrics, from LRCLIB), held to the rule yt-dlp is held to: public
 * addresses only. Each request goes through the address guard (egress.ts) as a CONNECT tunnel, so the guard resolves
 * the name, checks the address and makes the connection, exactly as it does for yt-dlp; TLS runs inside the tunnel,
 * end to end with the site, so the guard sees no content. Without a guard (JUKECORD_ALLOW_PRIVATE_ADDRESSES turns it
 * off) the request goes straight out.
 *
 * Every request has a time limit for the whole of it and a size limit on its answer, and follows no redirect: the
 * caller gets the answer as it came and decides.
 */
import http from 'node:http';
import https from 'node:https';
import type net from 'node:net';
import { type Duplex, PassThrough } from 'node:stream';
import tls from 'node:tls';

/** An answer as it came: its status, its headers and its body as text. */
export interface OutboundAnswer {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

/** Fetches an address and gives its answer, or throws when there is none (refused, too slow, too big, gone). */
export type OutboundGet = (url: URL, headers: Readonly<Record<string, string>>) => Promise<OutboundAnswer>;

export interface OutboundOptions {
  /** The address guard (http://127.0.0.1:port), or null to connect straight out. */
  readonly proxy: string | null;
  /** How long a whole request may take, from asking to the last byte (default 15 s). */
  readonly timeoutMs?: number;
  /** The most bytes an answer may have (default 1 MiB). */
  readonly maxBytes?: number;
  /** Certificates to trust besides the system's (the tests' own made-up site). */
  readonly ca?: string;
}

/** A request that got no answer to give: what happened, in words for the log. */
export class OutboundError extends Error {
  override name = 'OutboundError';
}

// Opens a tunnel through the guard to host:port and gives the socket at its far end. The guard answers 200 when it
// connected to a public address of the name, 403 when the name leads only to private ones, 502 when it has none.
function tunnel(proxy: URL, host: string, port: number, signal: AbortSignal): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const authority = `${host}:${port}`;
    const request = http.request({
      host: proxy.hostname,
      port: Number(proxy.port),
      method: 'CONNECT',
      path: authority,
      headers: { host: authority },
      signal,
    });
    request.once('connect', (answer, socket, head) => {
      if (answer.statusCode !== 200) {
        socket.destroy();
        reject(new OutboundError(`the address guard did not connect to ${host} (${answer.statusCode})`));
        return;
      }
      // Bytes the site sent with the guard's answer already belong to the TLS conversation that follows.
      if (head.length > 0) socket.unshift(head);
      resolve(socket);
    });
    request.once('error', (error) => reject(new OutboundError(`the address guard did not answer: ${error.message}`)));
    request.end();
  });
}

/** A function that fetches through the guard (or straight, without one), with the limits above. */
export function outbound(options: OutboundOptions): OutboundGet {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? 1024 ** 2;
  const proxy = options.proxy ? new URL(options.proxy) : null;
  return (url, headers) =>
    new Promise<OutboundAnswer>((resolve, reject) => {
      // One time limit for everything: the tunnel, the handshake, the request and the whole answer.
      const signal = AbortSignal.timeout(timeoutMs);
      const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
      const fail = (error: unknown) =>
        reject(
          error instanceof OutboundError
            ? error
            : new OutboundError(
                signal.aborted
                  ? `${url.host} took longer than ${Math.round(timeoutMs / 1000)} s`
                  : `${url.host} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
              ),
        );
      // The answer, read up to the size limit; one past it is cut off and refused.
      const read = (answer: http.IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        answer.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            answer.destroy();
            reject(new OutboundError(`${url.host} answered with more than ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        answer.on('end', () =>
          resolve({
            status: answer.statusCode ?? 0,
            headers: answer.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        answer.on('error', fail);
      };
      // Asked for as it is: no compression to undo, and the site closes the connection after the answer.
      const ask = { ...headers, 'accept-encoding': 'identity', connection: 'close' };
      let request: http.ClientRequest;
      if (url.protocol === 'https:') {
        request = https.request(url, {
          headers: ask,
          signal,
          ...(options.ca ? { ca: options.ca } : {}),
          // Through the guard: the tunnel, then TLS inside it to the site itself (its certificate checked against its
          // name as usual). Straight out: Node's own connection.
          ...(proxy
            ? {
                createConnection: (_options: unknown, done: (error: Error | null, socket: Duplex) => void) => {
                  tunnel(proxy, url.hostname, port, signal).then(
                    (socket) =>
                      done(
                        null,
                        tls.connect({ socket, servername: url.hostname, ...(options.ca ? { ca: options.ca } : {}) }),
                      ),
                    // Node reads the socket only when there is no error; an ended stream stands in for it here.
                    (error: unknown) =>
                      done(error instanceof Error ? error : new Error(String(error)), new PassThrough().end()),
                  );
                  return undefined;
                },
              }
            : {}),
        });
      } else if (url.protocol === 'http:') {
        // Plain HTTP through the guard is a request with the whole address on its first line, as yt-dlp sends it.
        request = proxy
          ? http.request({
              host: proxy.hostname,
              port: Number(proxy.port),
              path: url.href,
              headers: { ...ask, host: url.host },
              signal,
            })
          : http.request(url, { headers: ask, signal });
      } else {
        reject(new OutboundError(`only http and https addresses are fetched, not ${url.protocol}`));
        return;
      }
      request.once('response', read);
      request.once('error', fail);
      request.end();
    });
}
