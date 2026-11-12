/**
 * Covers: each track's picture (and a search result's, before it is added), fetched once by jukecord and kept in the
 * media cache beside its audio, so the panel shows it from jukecord's own address.
 *
 * Browsers then never ask the image hosts (the sites the tracks come from see no listener's address), and a picture
 * from the panel's own origin can be drawn into a canvas (Wrapped's "Save as picture"). A cover is fetched by the same
 * rule as everything jukecord fetches: the name is resolved here (address.ts), every address it has must be public,
 * and the connection goes to the very address checked, after each redirect too. Only a picture is kept: at most
 * 2 MiB, within ten seconds, and JPEG, PNG, GIF, WebP or AVIF by its own first bytes (never SVG, which can carry
 * script). A few are fetched at once, the same one once however many ask, and one that cannot be had is not asked for
 * again for an hour.
 */
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { NewTrack } from '../core/types.ts';
import type { Logger } from '../log.ts';
import { VERSION } from '../version.ts';
import { isPrivateAddress, resolveAll } from './address.ts';
import { BusyError } from './busy.ts';
import { type CoverType, MediaCache } from './cache.ts';

/** The largest picture kept: a big album cover is a few hundred kilobytes; more is not a thumbnail. */
export const COVER_MAX_BYTES = 2 * 1024 ** 2;

/** How long one picture may take, redirects and all. */
export const COVER_TIMEOUT_MS = 10_000;

// How many redirects are followed: an image host sends one at most (a size or a format); more is a loop.
const REDIRECTS = 3;

// How long a cover that could not be had is not asked for again.
const FAILED_FOR_MS = 3_600_000;

// The most failures remembered: past this many the oldest are forgotten, so the memory stays bounded.
const FAILED_MAX = 10_000;

/** A picture that could not be had, and why (for the log). */
export class CoverError extends Error {
  override name = 'CoverError';
}

/** A fetched picture: its bytes and what its first bytes say it is. */
export interface Picture {
  readonly bytes: Buffer;
  readonly type: CoverType;
}

/**
 * What a cover is kept by: the canonical address (the cache key, so a search result's picture is its track's once it
 * is added), the picture's address, and the title for the log. A track, or a search result not added yet.
 */
export type Pictured = Pick<NewTrack, 'source' | 'thumbnail' | 'title'>;

/** A cached cover, ready to be sent. */
export interface CoverFile {
  readonly path: string;
  readonly type: CoverType;
}

// The ASCII letters of part of a buffer (the magic words of the formats below).
function letters(bytes: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...bytes.subarray(from, to));
}

/**
 * What kind of picture some bytes are, by their first bytes, or null for anything else (an HTML error page, an SVG,
 * a truncated file). The file's own bytes decide, not what the site says it is.
 */
export function sniffImage(bytes: Uint8Array): CoverType | null {
  // JPEG: the start-of-image marker, then the first segment's marker.
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  // PNG: its eight-byte signature.
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, at) => bytes[at] === byte))
    return 'png';
  // GIF: either version of its header.
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(letters(bytes, 0, 6))) return 'gif';
  // WebP: a RIFF file of the WEBP form.
  if (bytes.length >= 12 && letters(bytes, 0, 4) === 'RIFF' && letters(bytes, 8, 12) === 'WEBP') return 'webp';
  // AVIF: an ISO media file whose brand is a still picture or a sequence.
  if (bytes.length >= 12 && letters(bytes, 4, 8) === 'ftyp' && ['avif', 'avis'].includes(letters(bytes, 8, 12)))
    return 'avif';
  return null;
}

/** How a fetch finds and checks addresses (tests stand a local site in for the internet). */
export interface FetchRules {
  /** A name's addresses (DNS asked directly, with a time limit, by default). */
  readonly lookup?: (host: string) => Promise<string[]>;
  /** Whether an address may be connected to (public addresses only by default). */
  readonly allowed?: (address: string) => boolean;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

// One answer of a site, read only as far as the rules allow.
type Answer = { readonly redirect: URL } | { readonly picture: Picture };

// Asks one address for a picture: the name checked first, the connection made to the checked address, the body read
// up to the limit.
async function ask(url: URL, rules: Required<FetchRules>, signal: AbortSignal): Promise<Answer> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new CoverError('not a web address');
  // "[::1]" in an address is "::1" to the resolver.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  try {
    addresses = net.isIP(host) ? [host] : await rules.lookup(host);
  } catch {
    throw new CoverError('no such site');
  }
  // Every allowed address of the name, IPv4 first, as the egress guard tries them (a container often has no IPv6 route).
  const usable = addresses.filter((address) => rules.allowed(address)).sort((a, b) => net.isIP(a) - net.isIP(b));
  if (usable.length === 0) throw new CoverError('the picture is on a private network');
  const first = usable[0] ?? '';
  const client = url.protocol === 'https:' ? https : http;
  return new Promise<Answer>((resolve, reject) => {
    const request = client.request(
      url,
      {
        method: 'GET',
        headers: {
          // The kinds of picture jukecord keeps; no cookies, no referrer, nothing about who asked.
          accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9',
          'user-agent': `jukecord/${VERSION}`,
        },
        // A connection of its own, closed after the answer: nothing is pooled with another site's address.
        agent: false,
        signal,
        // Node connects to what this answers instead of asking the system: only the addresses checked above, so a name
        // that answers differently the second time cannot lead anywhere else (an IP address in the URL is not looked
        // up at all, and was checked as itself).
        lookup: (_name, options, callback) => {
          if (options.all)
            callback(
              null,
              usable.map((address) => ({ address, family: net.isIP(address) })),
            );
          else callback(null, first, net.isIP(first));
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        // A redirect: the next address is checked by the same rules before anything is asked of it.
        if (status >= 300 && status < 400 && location) {
          response.resume();
          try {
            resolve({ redirect: new URL(location, url) });
          } catch {
            reject(new CoverError('the site sent a redirect that is not an address'));
          }
          return;
        }
        // Anything but a picture's own answer: a "not found" picture (YouTube sends a grey one) is not this cover.
        if (status !== 200) {
          response.resume();
          reject(new CoverError(`the site answered ${status}`));
          return;
        }
        const type = String(response.headers['content-type'] ?? '');
        // Said to be something else (a page): not read at all. A missing type is left to the bytes to say.
        if (type && !type.toLowerCase().startsWith('image/')) {
          response.resume();
          reject(new CoverError(`the site sent ${type.split(';')[0]}, not a picture`));
          return;
        }
        const length = Number(response.headers['content-length']);
        if (Number.isFinite(length) && length > rules.maxBytes) {
          response.destroy();
          reject(new CoverError('the picture is larger than jukecord keeps'));
          return;
        }
        // The body, counted as it comes: a site that sends more than it said, or says nothing, is cut at the limit.
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > rules.maxBytes) {
            response.destroy();
            reject(new CoverError('the picture is larger than jukecord keeps'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const bytes = Buffer.concat(chunks);
          const kind = sniffImage(bytes);
          if (!kind) reject(new CoverError('what the site sent is not a picture jukecord keeps'));
          else resolve({ picture: { bytes, type: kind } });
        });
        // A connection cut halfway: whatever came is not a whole picture (after a whole one this changes nothing).
        response.on('close', () => {
          if (!response.complete) reject(new CoverError('the site stopped sending'));
        });
        response.on('error', (error) => reject(new CoverError(error.message)));
      },
    );
    request.on('error', (error) => {
      // The time limit (or jukecord stopping) aborted it: said as that, not as the socket's own words.
      reject(new CoverError(signal.aborted ? 'the site took too long' : error.message));
    });
    request.end();
  });
}

// A picture given inline ("data:image/png;base64,..."): taken as it is, checked like a fetched one. Nothing is fetched.
function inline(address: string, maxBytes: number): Picture {
  const match = /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]*)$/i.exec(address);
  if (!match) throw new CoverError('an inline picture that is not base64');
  const text = match[1] ?? '';
  // Measured before it is decoded: four letters carry three bytes.
  if (text.length > Math.ceil(maxBytes / 3) * 4 + 4) throw new CoverError('the picture is larger than jukecord keeps');
  const bytes = Buffer.from(text, 'base64');
  const type = sniffImage(bytes);
  if (!type || bytes.length > maxBytes) throw new CoverError('what the address holds is not a picture jukecord keeps');
  return { bytes, type };
}

/**
 * Fetches the picture at an address by the rules above: public addresses only (unless `allowed` says otherwise),
 * redirects checked again, a size and a time limit, picture formats only.
 */
export async function fetchPicture(address: string, rules: FetchRules = {}, signal?: AbortSignal): Promise<Picture> {
  const full: Required<FetchRules> = {
    lookup: rules.lookup ?? resolveAll,
    allowed: rules.allowed ?? ((candidate) => !isPrivateAddress(candidate)),
    maxBytes: rules.maxBytes ?? COVER_MAX_BYTES,
    timeoutMs: rules.timeoutMs ?? COVER_TIMEOUT_MS,
  };
  if (address.startsWith('data:')) return inline(address, full.maxBytes);
  // The whole fetch, redirects included, within the time limit; and stopped with whoever asked.
  const limit = AbortSignal.timeout(full.timeoutMs);
  const both = signal ? AbortSignal.any([limit, signal]) : limit;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new CoverError('not an address');
  }
  for (let hop = 0; hop <= REDIRECTS; hop += 1) {
    const answer = await ask(url, full, both);
    if ('picture' in answer) return answer.picture;
    url = answer.redirect;
  }
  throw new CoverError('the site sent too many redirects');
}

export interface CoversOptions {
  readonly cache: MediaCache;
  readonly log: Logger;
  /** Whether addresses on private networks may be fetched (JUKECORD_ALLOW_PRIVATE_ADDRESSES). */
  readonly allowPrivate?: boolean;
  /** Fetches one picture (tests replace it); fetchPicture by default. */
  readonly fetch?: (address: string, signal: AbortSignal) => Promise<Picture>;
  /** How many pictures are fetched at once (default 4). */
  readonly concurrency?: number;
  /** How many may wait for a place (default 32); one more is refused as busy. */
  readonly waitingMax?: number;
  /** How long one waits for a place before it is refused as busy (default ten seconds). */
  readonly waitMs?: number;
  readonly now?: () => number;
}

/** The covers of every track: from the cache, or fetched once and kept there. */
export class Covers {
  private readonly options: CoversOptions;
  private readonly now: () => number;
  private readonly fetch: (address: string, signal: AbortSignal) => Promise<Picture>;
  // Fetches under way, by the track's key, so a hundred panels asking for one cover fetch it once.
  private readonly running = new Map<string, Promise<CoverFile | null>>();
  // Covers that could not be had, by the track's key and the picture's address, with when.
  private readonly failed = new Map<string, number>();
  // Fetches running now, and those waiting for a place, oldest first.
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  // Ends every fetch when jukecord stops.
  private readonly stopping = new AbortController();

  constructor(options: CoversOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    // With private addresses allowed (a media server on the local network), a name is looked up as the system looks it
    // up, as yt-dlp then does too (a name in /etc/hosts, a .local one), and every address may be reached.
    const anywhere = {
      lookup: async (host: string) => (await dns.lookup(host, { all: true })).map((found) => found.address),
      allowed: () => true,
    };
    this.fetch =
      options.fetch ?? ((address, signal) => fetchPicture(address, options.allowPrivate ? anywhere : {}, signal));
  }

  /** The cover a track has in the cache now (marked as used), or null; nothing is fetched. */
  cached(track: Pictured): CoverFile | null {
    if (!track.thumbnail) return null;
    return this.options.cache.cover(MediaCache.keyOf(track.source));
  }

  /**
   * A track's cover: from the cache, or fetched now and kept. Null when the track has no picture or it cannot be had
   * (a failure is remembered for an hour). Throws BusyError when too many wait for a place already.
   */
  async get(track: Pictured): Promise<CoverFile | null> {
    const address = track.thumbnail;
    if (!address) return null;
    const key = MediaCache.keyOf(track.source);
    const hit = this.options.cache.cover(key);
    if (hit) return hit;
    // A failure is remembered for the picture's address: a track looked up again with another picture is tried anew.
    const mark = `${key} ${address}`;
    const failedAt = this.failed.get(mark);
    if (failedAt !== undefined && this.now() - failedAt < FAILED_FOR_MS) return null;
    // Under way for someone else already: the same answer.
    const running = this.running.get(key);
    if (running) return running;
    if (this.active >= this.limit() && this.waiting.length >= (this.options.waitingMax ?? 32)) {
      throw new BusyError('jukecord is fetching other covers right now; try again in a moment');
    }
    const work = this.fetchAndKeep(track, address, key, mark).finally(() => this.running.delete(key));
    this.running.set(key, work);
    return work;
  }

  /** Ends the fetches under way (jukecord is stopping). */
  stop(): void {
    this.stopping.abort();
  }

  // How many run at once.
  private limit(): number {
    return Math.max(1, this.options.concurrency ?? 4);
  }

  // Waits for a place (or is refused as busy after the wait limit), fetches, and keeps the picture.
  private async fetchAndKeep(track: Pictured, address: string, key: string, mark: string): Promise<CoverFile | null> {
    await this.place();
    try {
      const picture = await this.fetch(address, this.stopping.signal);
      this.options.cache.putCover(key, picture.bytes, picture.type);
      return this.options.cache.cover(key);
    } catch (error) {
      // Not the cover's fault when jukecord is stopping: nothing to remember.
      if (!this.stopping.signal.aborted) this.remember(mark);
      this.options.log.info('could not get a cover', {
        title: track.title,
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      this.release();
    }
  }

  // A place among the fetches: at once while fewer than the limit run, otherwise in line, oldest first.
  private place(): Promise<void> {
    if (this.active < this.limit()) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const start = () => {
        clearTimeout(timer);
        this.active += 1;
        resolve();
      };
      // Waited too long: the line is not moving (slow sites); the asker hears "busy" and may ask again later.
      const timer = setTimeout(() => {
        const at = this.waiting.indexOf(start);
        if (at >= 0) this.waiting.splice(at, 1);
        reject(new BusyError('jukecord is fetching other covers right now; try again in a moment'));
      }, this.options.waitMs ?? 10_000);
      timer.unref();
      this.waiting.push(start);
    });
  }

  // A fetch ended: the next one in line takes its place.
  private release(): void {
    this.active -= 1;
    this.waiting.shift()?.();
  }

  // Remembers a failure, forgetting the oldest beyond the bound.
  private remember(mark: string): void {
    this.failed.delete(mark);
    this.failed.set(mark, this.now());
    if (this.failed.size > FAILED_MAX) this.failed.delete(this.failed.keys().next().value ?? mark);
  }
}
