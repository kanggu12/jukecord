/**
 * Keeping lookups on the public internet: an address whose host is on a private network (the machine itself, the
 * home router, other containers or pods) is refused before yt-dlp fetches it, so the bot cannot be used to probe the
 * network it runs in. JUKECORD_ALLOW_PRIVATE_ADDRESSES turns this off for media servers on the local network.
 *
 * Names are resolved once and remembered for ten minutes. A name that does not resolve is let through: yt-dlp then
 * says it cannot reach it, which is the clearer message.
 */
import dns from 'node:dns/promises';
import net from 'node:net';

/** An address refused because of where it points. */
export class AddressError extends Error {
  override name = 'AddressError';
}

// The eight 16-bit groups of an IPv6 address. An IPv4 tail ("::ffff:10.0.0.1") counts as the last two groups, and a
// zone ("fe80::1%eth0", which names an interface) is dropped.
function ipv6Groups(address: string): number[] {
  let text = (address.toLowerCase().split('%')[0] ?? '').trim();
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (tail) {
    const [a = 0, b = 0, c = 0, d = 0] = tail.slice(1).map(Number);
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', rest] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = rest ? rest.split(':') : [];
  // "::" stands for as many zero groups as are missing from eight.
  const groups =
    rest === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return groups.map((group) => Number.parseInt(group, 16));
}

/**
 * Whether an IP address is not on the public internet: private, loopback, link-local, shared, multicast, unspecified.
 * IPv6 addresses that carry an IPv4 address (mapped ::ffff:a.b.c.d in either spelling, the old compatible form, NAT64,
 * 6to4) are judged by the IPv4 address inside, which is where they lead.
 */
export function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (net.isIPv6(address)) {
    const g = ipv6Groups(address);
    const zero = (from: number, to: number) => g.slice(from, to).every((group) => group === 0);
    // The IPv4 address in two groups, judged as itself.
    const inside = (high = 0, low = 0) => isPrivateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    // :: (unspecified) and ::1 (loopback).
    if (zero(0, 7) && (g[7] === 0 || g[7] === 1)) return true;
    // ::ffff:a.b.c.d, however it is written (a URL turns ::ffff:127.0.0.1 into ::ffff:7f00:1).
    if (zero(0, 5) && g[5] === 0xffff) return inside(g[6], g[7]);
    // ::a.b.c.d, the old IPv4-compatible form.
    if (zero(0, 6)) return inside(g[6], g[7]);
    // NAT64: 64:ff9b::/96 and the local-use 64:ff9b:1::/48 end in the IPv4 address they reach.
    if (g[0] === 0x64 && g[1] === 0xff9b && (zero(2, 6) || g[2] === 1)) return inside(g[6], g[7]);
    // 6to4: 2002:AABB:CCDD:: leads to AA.BB.CC.DD.
    if (g[0] === 0x2002) return inside(g[1], g[2]);
    const first = g[0] ?? 0;
    return (
      // fc00::/7 unique local, fe80::/10 link-local, fec0::/10 the old site-local, ff00::/8 multicast.
      (first & 0xfe00) === 0xfc00 ||
      (first & 0xffc0) === 0xfe80 ||
      (first & 0xffc0) === 0xfec0 ||
      (first & 0xff00) === 0xff00
    );
  }
  // Not an IP address at all: nothing to fetch from.
  return true;
}

// Names are resolved by asking DNS directly (c-ares), two seconds a try, two tries, not through the system resolver: that
// one runs on Node's four shared worker threads, which a name that never answers would hold for many seconds while the
// panel's files and the audio wait behind it.
const resolver = new dns.Resolver({ timeout: 2000, tries: 2 });

/** No name server answered at all (no network, none reachable): nothing is known about the name itself. */
export class NoAnswerError extends Error {
  override name = 'NoAnswerError';
}

// The resolver's codes for a question that got no answer, as opposed to "no such name".
const NO_ANSWER = new Set(['ETIMEOUT', 'ECONNREFUSED', 'ESERVFAIL', 'EAI_AGAIN', 'ECANCELLED', 'ECONNRESET']);

/** A name's IPv4 and IPv6 addresses; throws when it has none (NoAnswerError when no name server answered). */
export async function resolveAll(host: string): Promise<string[]> {
  const [v4, v6] = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
  const found = [...(v4.status === 'fulfilled' ? v4.value : []), ...(v6.status === 'fulfilled' ? v6.value : [])];
  if (found.length === 0) {
    // Both questions unanswered: this machine reaches no name server, which says nothing about the name.
    const unanswered = [v4, v6].every(
      (result) => result.status === 'rejected' && NO_ANSWER.has(String((result.reason as { code?: unknown })?.code)),
    );
    if (unanswered) throw new NoAnswerError(`no name server answered for ${host}`);
    throw new Error(`${host} does not resolve`);
  }
  return found;
}

/** Checks an address before it is fetched; throws AddressError to refuse it. */
export type AddressCheck = (url: URL) => Promise<void>;

/** Refuses addresses that are not http(s) or whose host resolves to a private network. */
export function publicAddressesOnly(
  lookup: (host: string) => Promise<string[]> = resolveAll,
  now: () => number = Date.now,
): AddressCheck {
  const known = new Map<string, { ok: boolean; at: number }>();
  return async (url) => {
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw new AddressError('only http and https addresses can be added');
    // [::1] in a URL is ::1 to the resolver.
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const remembered = known.get(host);
    let ok: boolean;
    if (remembered && now() - remembered.at < 600_000) {
      ok = remembered.ok;
    } else {
      let addresses: string[];
      if (net.isIP(host)) {
        addresses = [host];
      } else {
        try {
          addresses = await lookup(host);
        } catch {
          return;
        }
      }
      // Every address the name has must be public: one private answer is enough to reach inside.
      ok = addresses.length > 0 && addresses.every((address) => !isPrivateAddress(address));
      known.set(host, { ok, at: now() });
      // A bounded memory: past a thousand names the oldest are forgotten.
      if (known.size > 1000) known.delete(known.keys().next().value ?? host);
    }
    if (!ok) throw new AddressError(`${host} is on a private network, which jukecord does not fetch from`);
  };
}
