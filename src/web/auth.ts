/**
 * Logins: panel sessions (a cookie), API tokens (a bearer header), the host token, one-time login links, and logging
 * in with Discord (OAuth2).
 *
 * Every secret jukecord hands out is 32 random bytes. Only their SHA-256 hashes are stored, so a copy of the
 * database or a backup logs nobody in. The host token is the exception that proves the rule: it lives in a file in
 * the data directory (mode 0600) because the CLI on the same machine reads it from there; whoever can read that file
 * can already read the database.
 *
 * A session cookie alone never changes anything: every change must also carry the session's CSRF token in a header,
 * which another site cannot read or send. Tokens are sent as a header by programs, which are not exposed to that.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Principal } from '../app/access.ts';
import type { Logger } from '../log.ts';
import type { Person, Store, TokenRow, TokenScope } from '../store/store.ts';

/** Who is calling and how. */
export interface Caller {
  readonly principal: Principal;
  /** What the call may do: a session and the host token may do everything their login may; a token, its scope. */
  readonly scope: TokenScope;
  readonly via: 'session' | 'token';
  /** The hash of the session cookie's secret, for logging out; null for tokens. */
  readonly sessionHash: string | null;
  /** The session's CSRF token; null for tokens (which do not need one). */
  readonly csrf: string | null;
  /** The API token's row ID; null for sessions and the host token. */
  readonly tokenId: number | null;
}

/** The session cookie's name, prefixed so it cannot clash with other programs on the same host name. */
export const SESSION_COOKIE = 'jukecord_session';
// The OAuth state cookie, alive only between leaving for Discord and coming back.
const STATE_COOKIE = 'jukecord_oauth';
/** The header the panel sends its CSRF token in. */
export const CSRF_HEADER = 'x-jukecord-csrf';
// A panel login lasts thirty days; logging out, or the host revoking, ends it sooner.
const SESSION_MS = 30 * 86_400_000;
// A login link must be used within ten minutes, and only once.
const LINK_MS = 10 * 60_000;
// The prefix of API tokens; the logger masks anything that looks like one.
const TOKEN_PREFIX = 'jkc_';

/** A new secret: 32 random bytes in URL-safe base64, with an optional prefix that says what it is. */
export function newSecret(prefix = ''): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

/** The SHA-256 of a secret in hex: what is stored and compared instead of the secret. */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Reads a Cookie header into a map. Malformed parts are skipped; the last of two equal names wins. */
export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at <= 0) continue;
    const name = part.slice(0, at).trim();
    const raw = part.slice(at + 1).trim();
    try {
      cookies.set(name, decodeURIComponent(raw));
    } catch {
      // A value that is not valid percent-encoding is not one of ours.
    }
  }
  return cookies;
}

/** A Set-Cookie value. httpOnly (scripts cannot read it) and SameSite=Lax (other sites' forms do not carry it). */
export function cookie(name: string, value: string, options: { maxAgeSeconds: number; secure: boolean }): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  // Secure only over HTTPS: on plain http://localhost a Secure cookie would never come back.
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Creates the host token file on the first start and returns its secret.
 *
 * The file is created exclusively with mode 0600, so a second process starting at the same moment cannot replace a
 * token the first one already handed out, and no other user on the machine can read it.
 */
export function ensureHostToken(dataDir: string): string {
  const file = path.join(dataDir, 'host-token');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.startsWith(TOKEN_PREFIX)) return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const secret = newSecret(TOKEN_PREFIX);
  fs.mkdirSync(dataDir, { recursive: true });
  // "w" (not "wx"): a damaged file (no prefix) is replaced; the mode applies to a new file and is set again below.
  fs.writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return secret;
}

/** Logging in with Discord: the application's ID and secret, and where Discord sends people back to. */
export interface OAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** `<public address>/auth/callback`, which must also be listed in the application's OAuth2 redirects. */
  readonly redirectUri: string;
  /** Discord's API (changed only by tests). */
  readonly api?: string;
  /** Discord's authorisation page (changed only by tests). */
  readonly authorize?: string;
}

/**
 * The key failures are counted under: an IPv4 address as it is, an IPv6 address by its /56 (the block a home or a
 * server is usually given, so rotating through it does not reset the count; a /48 holds only 256 of them), an IPv4
 * address written as IPv6 as the IPv4 one. A request without an address (its socket already closed) counts as one.
 */
export function addressKey(address: string | undefined): string {
  const plain = (address ?? 'unknown').split('%')[0] ?? 'unknown';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(plain)?.[1];
  if (mapped) return mapped;
  if (!plain.includes(':')) return plain;
  // "::" stands for as many zero groups as are missing from eight.
  const [head = '', tail = ''] = plain.split('::');
  const compressed = plain.includes('::');
  const left = head ? head.split(':') : [];
  const right = compressed && tail ? tail.split(':') : [];
  const groups = compressed
    ? [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
    : plain.split(':');
  const [a, b, c, d] = groups.map((group) => Number.parseInt(group || '0', 16) || 0);
  // The first 56 bits: three groups and the high byte of the fourth.
  return `${[a, b, c, (d ?? 0) & 0xff00].map((group) => (group ?? 0).toString(16)).join(':')}::/56`;
}

/**
 * Turns failed logins from one address into a short ban, so a link or token cannot be guessed at speed.
 *
 * It remembers at most 10,000 addresses, the ones that failed most recently: a scan from many addresses pushes out
 * the oldest instead of growing the map or making every failure walk it.
 */
export class FailureLimiter {
  // Insertion order is the order of each address's latest failure, oldest first.
  private readonly failures = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly capacity: number;

  constructor(options: { limit?: number; windowMs?: number; now?: () => number; capacity?: number } = {}) {
    this.limit = options.limit ?? 20;
    this.windowMs = options.windowMs ?? 10 * 60_000;
    this.now = options.now ?? Date.now;
    this.capacity = options.capacity ?? 10_000;
  }

  /** Whether this address has failed too often lately. */
  blocked(address: string | undefined): boolean {
    return this.recent(addressKey(address)).length >= this.limit;
  }

  fail(address: string | undefined): void {
    const key = addressKey(address);
    const recent = this.recent(key);
    recent.push(this.now());
    // Only the latest `limit` failures matter (that many block), so no more are kept: an address failing without end
    // costs the same little each time.
    if (recent.length > this.limit) recent.splice(0, recent.length - this.limit);
    // Moved to the end: it is now the most recent.
    this.failures.delete(key);
    this.failures.set(key, recent);
    while (this.failures.size > this.capacity) {
      const oldest = this.failures.keys().next().value;
      if (oldest === undefined) break;
      this.failures.delete(oldest);
    }
  }

  // The failures of a key inside the window.
  private recent(key: string): number[] {
    const since = this.now() - this.windowMs;
    return (this.failures.get(key) ?? []).filter((at) => at > since);
  }
}

export interface AuthOptions {
  readonly store: Store;
  /** The host token's secret (see ensureHostToken). */
  readonly hostToken: string;
  /** Whether cookies get the Secure flag (the public address is https). */
  readonly secureCookies: boolean;
  /** Discord login, or null when the application's secret is not set. */
  readonly oauth: OAuthConfig | null;
  readonly log: Logger;
  readonly now?: () => number;
  /** The fetch used to talk to Discord (tests pass a fake). */
  readonly fetch?: typeof fetch;
}

export class Auth {
  private readonly options: AuthOptions;
  private readonly now: () => number;
  private readonly hostHash: Buffer;
  // Login links not used yet: the hash of the code and when it stops working.
  private readonly links = new Map<string, number>();
  // When each token was last noted as used, so a script calling every second does not write every second.
  private readonly touched = new Map<number, number>();
  /** Failed logins per address. */
  readonly limiter: FailureLimiter;

  constructor(options: AuthOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.hostHash = Buffer.from(hashSecret(options.hostToken), 'hex');
    this.limiter = new FailureLimiter({ now: this.now });
  }

  /** Whether logging in with Discord is set up. */
  get discordLogin(): boolean {
    return this.options.oauth !== null;
  }

  /** Whether cookies are marked Secure. */
  get secure(): boolean {
    return this.options.secureCookies;
  }

  /**
   * Who is calling, from the Authorization header (a token) or the session cookie; null when neither is valid.
   * A bearer header wins over a cookie: a script that also carries a browser's cookie means its token.
   */
  identify(headers: { authorization?: string | undefined; cookie?: string | undefined }): Caller | null {
    const bearer = /^Bearer\s+(\S+)$/i.exec(headers.authorization ?? '')?.[1];
    if (bearer) return this.fromToken(bearer);
    const secret = parseCookies(headers.cookie).get(SESSION_COOKIE);
    return secret ? this.fromSession(secret) : null;
  }

  /** Whether a change may go ahead: tokens always (they are not sent by browsers), sessions with their CSRF token. */
  csrfOk(caller: Caller, header: string | undefined): boolean {
    if (caller.via === 'token') return true;
    if (!caller.csrf || !header) return false;
    const expected = Buffer.from(caller.csrf);
    const given = Buffer.from(header);
    // Equal lengths first: timingSafeEqual throws on different lengths.
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  // A token: the host's (compared in constant time) or one from the database.
  private fromToken(secret: string): Caller | null {
    if (!secret.startsWith(TOKEN_PREFIX)) return null;
    const hash = hashSecret(secret);
    if (timingSafeEqual(Buffer.from(hash, 'hex'), this.hostHash)) {
      return {
        principal: { kind: 'host' },
        scope: 'admin',
        via: 'token',
        sessionHash: null,
        csrf: null,
        tokenId: null,
      };
    }
    const row = this.options.store.tokens.byHash(hash);
    if (!row) return null;
    this.noteUse(row.id);
    const principal: Principal =
      row.kind === 'host' || row.userId === null ? { kind: 'host' } : { kind: 'user', userId: row.userId };
    return { principal, scope: row.scope, via: 'token', sessionHash: null, csrf: null, tokenId: row.id };
  }

  // A session cookie.
  private fromSession(secret: string): Caller | null {
    const hash = hashSecret(secret);
    const session = this.options.store.sessions.get(hash);
    if (!session) return null;
    // Noted at most once a minute, like tokens.
    if (this.now() - session.seenAt > 60_000) this.options.store.sessions.touch(hash);
    const principal: Principal =
      session.kind === 'host' || session.userId === null ? { kind: 'host' } : { kind: 'user', userId: session.userId };
    return { principal, scope: 'admin', via: 'session', sessionHash: hash, csrf: session.csrf, tokenId: null };
  }

  // Writes "used now" for a token at most once a minute.
  private noteUse(id: number): void {
    const last = this.touched.get(id) ?? 0;
    if (this.now() - last < 60_000) return;
    this.touched.set(id, this.now());
    try {
      this.options.store.tokens.touch(id);
    } catch (error) {
      this.options.log.debug('could not note a token as used', { error });
    }
  }

  /** Whether a caller's login still exists: a session not logged out or expired, a token not revoked. */
  stillValid(caller: Caller): boolean {
    if (caller.sessionHash) return this.options.store.sessions.get(caller.sessionHash) !== null;
    if (caller.tokenId !== null) return this.options.store.tokens.get(caller.tokenId) !== null;
    // The host token: valid as long as jukecord runs with it.
    return true;
  }

  /** Starts a panel login and returns the Set-Cookie value. */
  startSession(principal: Principal): string {
    const secret = newSecret();
    this.options.store.sessions.create({
      idHash: hashSecret(secret),
      kind: principal.kind,
      userId: principal.kind === 'user' ? principal.userId : null,
      csrf: newSecret(),
      expiresAt: this.now() + SESSION_MS,
    });
    // Old logins are cleared now and then; the start of a new one is a natural moment.
    this.options.store.sessions.prune();
    return cookie(SESSION_COOKIE, secret, { maxAgeSeconds: SESSION_MS / 1000, secure: this.secure });
  }

  /** Ends the caller's session (if it is one) and returns the Set-Cookie value that removes the cookie. */
  endSession(caller: Caller | null): string {
    if (caller?.sessionHash) this.options.store.sessions.remove(caller.sessionHash);
    return cookie(SESSION_COOKIE, '', { maxAgeSeconds: 0, secure: this.secure });
  }

  /** A one-time login link code for the host (see `jukecord open`). */
  createLink(): { code: string; expiresAt: number } {
    const code = newSecret();
    const expiresAt = this.now() + LINK_MS;
    // Expired codes are dropped whenever a new one is made, so unused links do not pile up.
    for (const [hash, until] of this.links) if (until <= this.now()) this.links.delete(hash);
    this.links.set(hashSecret(code), expiresAt);
    return { code, expiresAt };
  }

  /** Uses up a login link code; true when it was valid. */
  useLink(code: string): boolean {
    const hash = hashSecret(code);
    const until = this.links.get(hash);
    // Gone either way: a code works once.
    this.links.delete(hash);
    return until !== undefined && until > this.now();
  }

  /** Where to send a browser to log in with Discord, and the cookie that ties the way back to this browser. */
  oauthStart(next: string): { location: string; cookie: string } {
    const oauth = this.options.oauth;
    if (!oauth) throw new Error('logging in with Discord is not set up');
    const state = newSecret();
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: oauth.clientId,
      // Only the person's identity: membership and roles are asked through the bot, which needs no extra consent.
      scope: 'identify',
      state,
      redirect_uri: oauth.redirectUri,
      // Someone who already allowed jukecord is not asked again.
      prompt: 'none',
    });
    const location = `${oauth.authorize ?? 'https://discord.com/oauth2/authorize'}?${params}`;
    // The state and where to go afterwards travel together in a short-lived cookie.
    const value = `${state}.${Buffer.from(safeNext(next)).toString('base64url')}`;
    return { location, cookie: cookie(STATE_COOKIE, value, { maxAgeSeconds: 600, secure: this.secure }) };
  }

  /**
   * Finishes a Discord login: checks the state against the cookie, trades the code for an access token, and asks who
   * the person is. Returns the person and where they wanted to go. The access token is revoked straight away:
   * jukecord needs it only for this one question.
   */
  async oauthFinish(
    code: string,
    state: string,
    cookieHeader: string | undefined,
  ): Promise<{ person: Person; next: string }> {
    const oauth = this.options.oauth;
    if (!oauth) throw new Error('logging in with Discord is not set up');
    const saved = parseCookies(cookieHeader).get(STATE_COOKIE) ?? '';
    const [expected, encodedNext] = saved.split('.');
    // The state proves this browser started the login: a link from someone else cannot log this browser into their
    // account (login CSRF).
    if (!expected || expected.length !== state.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(state))) {
      throw new Error('the login did not start in this browser, or took longer than 10 minutes');
    }
    const next = safeNext(encodedNext ? Buffer.from(encodedNext, 'base64url').toString() : '/');
    const api = oauth.api ?? 'https://discord.com/api/v10';
    const fetcher = this.options.fetch ?? fetch;
    const form = (fields: Record<string, string>) => ({
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const tokenResponse = await fetcher(
      `${api}/oauth2/token`,
      form({
        grant_type: 'authorization_code',
        code,
        redirect_uri: oauth.redirectUri,
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
      }),
    );
    if (!tokenResponse.ok) throw new Error(`Discord refused the login (${tokenResponse.status})`);
    const { access_token: accessToken } = (await tokenResponse.json()) as { access_token?: string };
    if (!accessToken) throw new Error('Discord did not send an access token');
    try {
      const userResponse = await fetcher(`${api}/users/@me`, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!userResponse.ok) throw new Error(`Discord did not say who logged in (${userResponse.status})`);
      const user = (await userResponse.json()) as {
        id?: string;
        username?: string;
        global_name?: string | null;
        avatar?: string | null;
      };
      if (!user.id || !/^\d{17,20}$/.test(user.id)) throw new Error('Discord sent a user without an ID');
      return {
        person: { id: user.id, name: user.global_name || user.username || user.id, avatar: user.avatar ?? null },
        next,
      };
    } finally {
      // Revoked whether or not the question worked; a failure here changes nothing for the login.
      void fetcher(
        `${api}/oauth2/token/revoke`,
        form({ token: accessToken, client_id: oauth.clientId, client_secret: oauth.clientSecret }),
      ).catch(() => {});
    }
  }

  /** The Set-Cookie value that removes the OAuth state cookie once it has done its job. */
  clearOAuthCookie(): string {
    return cookie(STATE_COOKIE, '', { maxAgeSeconds: 0, secure: this.secure });
  }

  /** Makes an API token for the caller's login, never wider than the caller's own scope. */
  createToken(caller: Caller, name: string, scope: TokenScope): { token: string; info: TokenRow } {
    const rank = { read: 0, control: 1, admin: 2 } as const;
    if (rank[scope] > rank[caller.scope]) throw new Error(`a ${caller.scope} token cannot make a ${scope} token`);
    const token = newSecret(TOKEN_PREFIX);
    const principal = caller.principal;
    const info = this.options.store.tokens.create({
      hash: hashSecret(token),
      name,
      kind: principal.kind,
      userId: principal.kind === 'user' ? principal.userId : null,
      scope,
    });
    return { token, info };
  }

  /** The caller's tokens; the host sees everyone's. */
  listTokens(caller: Caller): TokenRow[] {
    const principal = caller.principal;
    return principal.kind === 'host'
      ? this.options.store.tokens.list()
      : this.options.store.tokens.list(principal.userId);
  }

  /** Revokes a token the caller owns (the host may revoke any); false when there is no such token of theirs. */
  revokeToken(caller: Caller, id: number): boolean {
    const row = this.options.store.tokens.get(id);
    if (!row) return false;
    const principal = caller.principal;
    if (principal.kind === 'user' && (row.kind !== 'user' || row.userId !== principal.userId)) return false;
    return this.options.store.tokens.remove(id);
  }
}

// Only paths on this site may be the place to go after logging in: "//evil.example", "/<tab>/evil.example" and full
// addresses would turn the login into an open redirect. Parsed the way a browser parses it, then rebuilt from its path.
export function safeNext(next: string): string {
  const base = 'http://jukecord.invalid';
  try {
    const url = new URL(next, base);
    if (url.origin !== base || !next.startsWith('/')) return '/';
    const path = `${url.pathname}${url.search}${url.hash}`;
    // Dot segments can rebuild into "//elsewhere" ("/.//evil.example" has the path "//evil.example"), which a
    // browser reads as another site.
    return /^\/[/\\]/.test(path) ? '/' : path;
  } catch {
    return '/';
  }
}
