/**
 * The way out for yt-dlp: a small HTTP proxy on 127.0.0.1 that yt-dlp is told to use (--proxy), which connects only
 * to addresses on the public internet.
 *
 * The check before a lookup (address.ts) sees the address someone typed and nothing after it. yt-dlp then follows
 * redirects, opens a playlist's entries and fetches the media, and a name can answer differently the second time it
 * is asked. Every one of those connections comes through here: the name is resolved here, the address is checked
 * here, and the connection goes to that very address, so nothing yt-dlp does can reach the machine itself, the home
 * network, or the other containers and pods. A refused connection gets the same answer whatever is behind it, so the
 * refusal says nothing about the network either.
 *
 * HTTPS comes as CONNECT host:port (the proxy carries the encrypted bytes and sees no content); plain HTTP comes as a
 * request with a full address, which is passed on with the proxy's own headers removed.
 */
import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { Logger } from '../log.ts';
import { isPrivateAddress, resolveAll } from './address.ts';

/** The running proxy: its address for yt-dlp's --proxy, and a way to stop it. */
export interface EgressGuard {
  readonly url: string;
  close(): Promise<void>;
}

export interface EgressOptions {
  readonly log: Logger;
  /** Resolves a name to its addresses (tests replace it); the system resolver by default. */
  readonly lookup?: (host: string) => Promise<string[]>;
  /** Whether an address may be connected to (tests replace it); public addresses only by default. */
  readonly allowed?: (address: string) => boolean;
  /** How long a connection may sit without a byte either way (default two minutes). */
  readonly idleMs?: number;
  /** How long one address may take to accept a connection before the next is tried (default ten seconds). */
  readonly connectMs?: number;
}

// The answer to a refused connection: the same words for every refusal, whatever the address hides.
const REFUSED = 'jukecord does not fetch from private networks';
// The answer for a name with no address at all (a mistyped site), which is not a refusal.
const UNKNOWN = 'no such site';

// Headers that belong to one hop (to the proxy) and must not travel on (RFC 9110 7.6.1).
const HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Starts the proxy on 127.0.0.1 at a free port. */
export async function startEgressGuard(options: EgressOptions): Promise<EgressGuard> {
  const log = options.log;
  // DNS asked directly with a time limit (address.ts), not the system resolver on Node's shared worker threads.
  const lookup = options.lookup ?? resolveAll;
  const allowed = options.allowed ?? ((address: string) => !isPrivateAddress(address));
  const idleMs = options.idleMs ?? 120_000;
  const connectMs = options.connectMs ?? 10_000;
  // Open tunnels: the HTTP server lets go of a socket once it is a tunnel, so closing has to end them by hand.
  const tunnels = new Set<Duplex>();

  // Where a host leads: its allowed addresses, IPv4 first (a container often has no IPv6 route, and a name answers
  // with both), or why there are none (no address at all, or only private ones).
  const target = async (host: string): Promise<{ addresses: string[] } | { status: 403 | 502; reason: string }> => {
    // "[::1]" in an address is "::1" to the resolver.
    const bare = host.replace(/^\[|\]$/g, '');
    let addresses: string[];
    try {
      addresses = net.isIP(bare) ? [bare] : await lookup(bare);
    } catch {
      return { status: 502, reason: UNKNOWN };
    }
    if (addresses.length === 0) return { status: 502, reason: UNKNOWN };
    const usable = addresses.filter((candidate) => allowed(candidate));
    if (usable.length > 0) return { addresses: [...usable].sort((a, b) => net.isIP(a) - net.isIP(b)) };
    log.debug('refused a connection', { host: bare });
    return { status: 403, reason: REFUSED };
  };

  const server = http.createServer((request, response) => {
    // A plain HTTP request through a proxy names the full address ("GET http://host/path").
    let url: URL;
    try {
      url = new URL(request.url ?? '');
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (url.protocol !== 'http:') {
      response.writeHead(400).end();
      return;
    }
    void target(url.hostname).then((found) => {
      if (!('addresses' in found)) {
        response.writeHead(found.status, found.reason).end();
        return;
      }
      // Plain HTTP goes to the first address only: a request body already sent cannot be sent to a second one.
      const address = found.addresses[0];
      // The request goes on to the checked address, with the name it asked for in Host and this hop's headers gone.
      const headers: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (!HOP_HEADERS.has(name) && value !== undefined) headers[name] = value;
      }
      headers.host = url.host;
      const upstream = http.request(
        {
          host: address,
          port: Number(url.port || 80),
          method: request.method,
          path: `${url.pathname}${url.search}`,
          headers,
          setHost: false,
        },
        (answer) => {
          const back: http.OutgoingHttpHeaders = {};
          for (const [name, value] of Object.entries(answer.headers)) {
            if (!HOP_HEADERS.has(name) && value !== undefined) back[name] = value;
          }
          response.writeHead(answer.statusCode ?? 502, answer.statusMessage, back);
          answer.pipe(response);
          // The site's answer ended before it was whole (the site went away, or went quiet and was cut off): the answer
          // to yt-dlp cannot be finished either, so its connection is closed, which tells yt-dlp the body is short.
          // Ending it normally instead would leave yt-dlp waiting for the rest of a body that never comes.
          answer.on('close', () => {
            if (!answer.complete) response.destroy();
          });
        },
      );
      // A quiet site is cut off; the error below then ends the answer to yt-dlp too.
      upstream.setTimeout(idleMs, () => upstream.destroy(new Error('the site went quiet')));
      upstream.on('error', () => {
        // The site did not answer: a plain 502, as any proxy would say. Once the answer has begun, there is no status
        // left to give: the connection to yt-dlp is closed instead.
        if (response.headersSent) {
          response.destroy();
          return;
        }
        response.writeHead(502);
        response.end();
      });
      // yt-dlp gave up (a skip): the request to the site is not needed any more.
      response.on('close', () => {
        if (!response.writableFinished) upstream.destroy();
      });
      request.pipe(upstream);
    });
  });

  // HTTPS: "CONNECT host:443". The proxy opens a TCP connection to the checked address and carries bytes both ways.
  server.on('connect', (request: http.IncomingMessage, client: Duplex, head: Buffer) => {
    const authority = request.url ?? '';
    const split = authority.lastIndexOf(':');
    const host = split > 0 ? authority.slice(0, split) : '';
    const port = Number(authority.slice(split + 1));
    client.on('error', () => client.destroy());
    tunnels.add(client);
    client.on('close', () => tunnels.delete(client));
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    void target(host).then((found) => {
      if (!('addresses' in found)) {
        client.end(`HTTP/1.1 ${found.status} ${found.reason}\r\n\r\n`);
        return;
      }
      // Each allowed address in turn until one takes the connection, as a browser does with a name's addresses.
      const attempt = (index: number): void => {
        const address = found.addresses[index];
        if (address === undefined || client.destroyed) {
          if (client.writable) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          return;
        }
        const upstream = net.connect({ host: address, port });
        let connected = false;
        // A short wait for the connection itself, the long one for a quiet connection after it.
        upstream.setTimeout(connectMs, () => upstream.destroy(new Error('no answer')));
        upstream.once('connect', () => {
          connected = true;
          // yt-dlp gave up while this address was being tried: nothing to carry.
          if (client.destroyed) {
            upstream.destroy();
            return;
          }
          upstream.setTimeout(idleMs, () => upstream.destroy());
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          // Bytes the client sent after the CONNECT line (a TLS hello, sometimes) go first.
          if (head.length > 0) upstream.write(head);
          upstream.pipe(client);
          client.pipe(upstream);
          client.on('close', () => upstream.destroy());
          // The site's side closed without ending (it reset, or went quiet and was cut off): yt-dlp's side is closed
          // too, or it would wait on a tunnel that carries nothing any more. A clean end is passed on by the pipe.
          upstream.on('close', () => {
            if (!upstream.readableEnded) client.destroy();
          });
        });
        upstream.on('error', () => {
          // Not connected yet: the next address. Connected: both ends close.
          if (!connected) attempt(index + 1);
          else client.destroy();
        });
      };
      attempt(0);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as net.AddressInfo).port;
  log.debug('yt-dlp goes through the address guard', { port });
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Open requests and tunnels (a download in progress) end too, or close() would wait for them.
        server.closeAllConnections();
        for (const tunnel of tunnels) tunnel.destroy();
      }),
  };
}
