/**
 * Requests jukecord makes itself: a Deezer or Spotify answer, a track's page on Spotify or Apple Music, a file
 * attached to a Discord command. They follow the rule every connection of yt-dlp follows (egress.ts): the name is
 * resolved here, every address it has must be public, the connection goes to that very address (a name that answers
 * differently the second time cannot lead inside), and each redirect is checked again the same way. Each has a time
 * limit and a size limit, and can stop reading once what it needs has come (a page's head).
 *
 * JUKECORD_ALLOW_PRIVATE_ADDRESSES turns the address rule off, as it does for yt-dlp.
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { AddressError, isPrivateAddress, resolveAll } from './address.ts';

export interface FetchOptions {
  readonly method?: 'GET' | 'POST';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** How long the whole request may take, redirects included (default 15 s). */
  readonly timeoutMs?: number;
  /** The most bytes read (default 2 MiB); more is a failure, unless `until` came first. */
  readonly maxBytes?: number;
  /** Stop reading once this text has come (a page's "</head>", where its facts are). */
  readonly until?: string;
  /** How many redirects are followed (default 5). */
  readonly redirects?: number;
  readonly signal?: AbortSignal;
}

/** An answer: its status, the address it finally came from, its headers, and its body as text. */
export interface FetchAnswer {
  readonly status: number;
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly text: string;
}

export type PublicFetch = (address: string, options?: FetchOptions) => Promise<FetchAnswer>;

export interface PublicFetchSetup {
  /** Every address allowed (JUKECORD_ALLOW_PRIVATE_ADDRESSES). */
  readonly allowPrivate?: boolean;
  /** A name's addresses (tests answer from a table); DNS asked directly by default (address.ts). */
  readonly lookup?: (host: string) => Promise<string[]>;
  /** Whether an address may be connected to (tests allow their own); public ones only by default. */
  readonly allowed?: (address: string) => boolean;
}

// The answer to a request refused for where it leads: the same words whatever is there.
const REFUSED = 'that address is on a private network, which jukecord does not fetch from';

/** A fetch that keeps to public addresses (see the module comment). */
export function publicFetch(setup: PublicFetchSetup = {}): PublicFetch {
  const lookup = setup.lookup ?? resolveAll;
  const allowed = setup.allowPrivate
    ? () => true
    : (setup.allowed ?? ((address: string) => !isPrivateAddress(address)));

  // The addresses a connection may use for a host: all allowed, IPv4 first (a container often has no IPv6 route).
  const addressesOf = async (host: string): Promise<string[]> => {
    const bare = host.replace(/^\[|\]$/g, '');
    const addresses = net.isIP(bare) ? [bare] : await lookup(bare);
    const usable = addresses.filter((address) => allowed(address));
    // One private answer is enough to refuse, as the check before a lookup does.
    if (usable.length === 0 || usable.length < addresses.length) throw new AddressError(REFUSED);
    return [...usable].sort((a, b) => net.isIP(a) - net.isIP(b));
  };

  return async (address, options = {}) => {
    const deadline = AbortSignal.timeout(options.timeoutMs ?? 15_000);
    const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
    let url = new URL(address);
    let method = options.method ?? 'GET';
    let body = options.body;
    for (let hop = 0; ; hop += 1) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:')
        throw new AddressError('only http and https addresses are fetched');
      // Checked before anything connects; an address written as an IP is checked as it is (no lookup is made for it).
      const addresses = await addressesOf(url.hostname);
      const answer = await once(url, method, body, options, addresses, signal);
      const location = answer.headers.location;
      if (answer.status >= 300 && answer.status < 400 && typeof location === 'string') {
        if (hop >= (options.redirects ?? 5)) throw new Error('too many redirects');
        // The next address is checked from the start, as the first was; a 303 asks with GET.
        url = new URL(location, url);
        if (answer.status === 303) {
          method = 'GET';
          body = undefined;
        }
        continue;
      }
      return { ...answer, url: url.href };
    }
  };
}

// One request to one address, connecting only to `addresses` (the ones checked for its host).
function once(
  url: URL,
  method: string,
  body: string | undefined,
  options: FetchOptions,
  addresses: readonly string[],
  signal: AbortSignal,
): Promise<Omit<FetchAnswer, 'url'>> {
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(
      url,
      {
        method,
        headers: {
          // A browser's plain name: some sites serve their pages' facts only to what looks like one. Nothing about
          // jukecord or its host goes out.
          'user-agent': 'Mozilla/5.0',
          accept: '*/*',
          ...(body !== undefined ? { 'content-length': String(Buffer.byteLength(body)) } : {}),
          ...options.headers,
        },
        // The name's checked addresses and no others: the connection cannot go anywhere the check did not see.
        lookup: (_host, lookupOptions, callback) => {
          const family = (address: string) => (net.isIPv6(address) ? 6 : 4);
          if ((lookupOptions as { all?: boolean }).all) {
            (callback as (error: Error | null, list: { address: string; family: number }[]) => void)(
              null,
              addresses.map((address) => ({ address, family: family(address) })),
            );
          } else {
            const first = addresses[0] ?? '';
            (callback as (error: Error | null, address: string, family: number) => void)(null, first, family(first));
          }
        },
        signal,
      },
      (response) => {
        // The text so far, decoded as it comes (a character split between two pieces is kept for the next).
        const decoder = new StringDecoder('utf8');
        let text = '';
        let size = 0;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve({ status: response.statusCode ?? 0, headers: response.headers, text: text + decoder.end() });
        };
        response.on('data', (chunk: Buffer) => {
          if (done) return;
          size += chunk.length;
          const piece = decoder.write(chunk);
          text += piece;
          // Enough read: what was asked for has come (looked for in the new piece and just before it).
          const until = options.until;
          if (until && text.indexOf(until, Math.max(0, text.length - piece.length - until.length)) >= 0) {
            finish();
            response.destroy();
            return;
          }
          if (size > maxBytes) {
            done = true;
            response.destroy();
            reject(new Error(`the answer is larger than ${maxBytes} bytes`));
          }
        });
        response.on('end', finish);
        response.on('error', (error) => {
          if (!done) {
            done = true;
            reject(error);
          }
        });
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}
