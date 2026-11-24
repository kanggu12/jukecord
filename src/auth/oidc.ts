/**
 * Logging in through an OpenID Connect provider (Keycloak, Authentik, Microsoft Entra ID, Okta, Google ...), with
 * openid-client: the provider is found from its issuer's discovery document, the browser goes there with the
 * authorization code flow (PKCE, state and nonce) and comes back with a code that jukecord trades for an ID token,
 * whose signature (the issuer's keys), issuer, audience, expiry and nonce are all checked. The claims it carries, or
 * the provider's userinfo when it carries too little, say who the person is and which groups or roles they have.
 *
 * What a login needs between leaving for the provider and coming back (the PKCE verifier, the nonce, where to go
 * after) waits on the cache port under the state's hash, for ten minutes and one use, so the browser may come back to
 * any process serving browsers. A cookie ties it to the browser that left: a link with someone else's state logs
 * nobody in. Nothing of the provider's (no token, no claim) is kept once the login is made.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as client from 'openid-client';
import type { Cache } from '../cache/cache.ts';
import type { Logger } from '../log.ts';
import { claimAt, claimValues } from './levels.ts';
import type { OidcSettings } from './settings.ts';

/** The cookie that ties a login under way to its browser, alive only until it comes back. */
export const SSO_COOKIE = 'jukecord_sso';

// How long a login may take at the provider: ten minutes, as Discord's and the login links' do.
const LOGIN_MS = 10 * 60_000;
// How long the provider's discovery document is used before it is read again (its keys are read again whenever a
// token is signed with a key not seen before, by openid-client itself).
const DISCOVERY_MS = 24 * 60 * 60_000;
// How long one request to the provider may take, in seconds (openid-client's unit).
const REQUEST_S = 10;
// The longest name kept for a person: what fits a row of the panel, where longer ones end in an ellipsis anyway.
const NAME_MAX = 64;
// The longest place to go after a login that is kept with it (the panel's own addresses are far shorter).
const NEXT_MAX = 2048;

/** Who the provider says logged in, and what of theirs decides their level. */
export interface OidcIdentity {
  /** The provider's own ID of the person (the `sub` claim). */
  readonly subject: string;
  /** The provider that vouched for them (the `iss` claim, checked to be the one set up): its subjects are its own. */
  readonly issuer: string;
  /** Their display name, from the first of name, preferred_username, nickname or given_name there is. */
  readonly name: string;
  /** The groups or roles at the configured claim. */
  readonly groups: readonly string[];
  /** A Discord user ID at the configured claim, when one is set up and the claim holds one. */
  readonly discordId: string | null;
}

/** Why a login through the provider did not go through, said in the panel's words by its code. */
export class OidcError extends Error {
  override name = 'OidcError';
  /** cancelled: the person turned back at the provider; expired: no login under way for this browser (late, used, or
   * another browser's); failed: the provider or its answer refused the login; unavailable: the provider did not
   * answer. */
  readonly code: 'cancelled' | 'expired' | 'failed' | 'unavailable';

  constructor(code: OidcError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

/** One finding of the settings test, as the doctor's checks are. */
export interface Check {
  readonly name: string;
  readonly status: 'ok' | 'warn' | 'fail';
  readonly detail: string;
}

export interface OidcOptions {
  readonly settings: OidcSettings;
  /** `<public address>/auth/sso/callback`, which the provider must list among the client's redirects. */
  readonly redirectUri: string;
  /** Where the provider sends the browser after logging out there: the login page. */
  readonly afterLogout: string;
  readonly cache: Cache;
  readonly log: Logger;
  /** The fetch used to talk to the provider (tests pass their own). */
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

// What waits on the cache for the browser to come back.
interface Pending {
  readonly browser: string;
  readonly verifier: string;
  readonly nonce: string;
  readonly next: string;
}

// The hash a value is kept and compared under (SHA-256, hex), so the cache never holds a state or a cookie itself.
function hashOf(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// Whether an error is the provider not answering (no connection, a timeout, a server error) rather than refusing.
function unreachable(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return true;
  // A status the protocol does not expect (a 502 from a proxy in front, a 500): the provider's trouble.
  return error instanceof client.ClientError && error.code === 'OAUTH_RESPONSE_IS_NOT_CONFORM';
}

// An error in a few words for the log and the test: the provider's own error code and description when it gave them.
function said(error: unknown): string {
  if (error instanceof client.ResponseBodyError || error instanceof client.AuthorizationResponseError)
    return error.error_description ? `${error.error}: ${error.error_description}` : error.error;
  if (error instanceof Error && error.cause instanceof Error) return `${error.message} (${error.cause.message})`;
  return error instanceof Error ? error.message : String(error);
}

export class OidcLogin {
  private readonly options: OidcOptions;
  private readonly now: () => number;
  // The provider's configuration as discovered, and when; a failed discovery is tried again at the next login.
  private discovered: { at: number; configuration: Promise<client.Configuration> } | null = null;

  constructor(options: OidcOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  // The tests' fetch as openid-client calls one (its options are a fetch's own, with a body that may be absent).
  private readonly fetcher: client.CustomFetch = (url, options) =>
    (this.options.fetch ?? fetch)(url, options as RequestInit);

  /** The words on the login key, when the host chose them. */
  get label(): string | null {
    return this.options.settings.label;
  }

  /** The provider's configuration: discovered once, used for a day, discovered again after a failure. */
  configuration(): Promise<client.Configuration> {
    const known = this.discovered;
    if (known && this.now() - known.at < DISCOVERY_MS) return known.configuration;
    const configuration = this.discover();
    this.discovered = { at: this.now(), configuration };
    // A failure is not kept: the next login asks the provider again.
    configuration.catch(() => {
      if (this.discovered?.configuration === configuration) this.discovered = null;
    });
    return configuration;
  }

  // Reads the provider's discovery document under its issuer and makes the client's configuration.
  private async discover(): Promise<client.Configuration> {
    const { settings } = this.options;
    const issuer = new URL(settings.issuer);
    const secret = settings.clientSecret;
    // The secret travels in the client's metadata too: a provider that signs ID tokens with it (HS256) is checked by it.
    const metadata = secret === null ? undefined : { client_secret: secret };
    // What every configuration made here gets: the ID token's signature checked against the issuer's keys (not only its
    // claims: openid-client leaves the signature to TLS by default, which a proxy ending TLS in front of jukecord would
    // not vouch for), plain http when the host wrote http:// (a provider inside the host's own network), the time
    // limit, and the tests' fetch.
    const prepare = (configuration: client.Configuration): void => {
      client.enableNonRepudiationChecks(configuration);
      if (issuer.protocol === 'http:') client.allowInsecureRequests(configuration);
      configuration.timeout = REQUEST_S;
      if (this.options.fetch) configuration[client.customFetch] = this.fetcher;
    };
    // HTTP Basic for the secret, which every provider must take (RFC 6749, 2.3.1); a public client sends none (PKCE
    // alone proves it).
    const discovered = await client.discovery(
      issuer,
      settings.clientId,
      metadata,
      secret === null ? client.None() : client.ClientSecretBasic(secret),
      {
        // allowInsecureRequests itself, not inside prepare: openid-client looks for it here to read the document over
        // plain http too.
        execute: [prepare, ...(issuer.protocol === 'http:' ? [client.allowInsecureRequests] : [])],
        timeout: REQUEST_S,
        ...(this.options.fetch ? { [client.customFetch]: this.fetcher } : {}),
      },
    );
    // A provider that lists only the form field for the secret gets it there, with the document just read.
    const supported = discovered.serverMetadata().token_endpoint_auth_methods_supported;
    if (secret !== null && supported?.includes('client_secret_post') && !supported.includes('client_secret_basic')) {
      const post = new client.Configuration(
        discovered.serverMetadata(),
        settings.clientId,
        metadata,
        client.ClientSecretPost(secret),
      );
      prepare(post);
      return post;
    }
    return discovered;
  }

  /**
   * Starts a login: where to send the browser, and the cookie that ties its way back to it. `next` is where to go
   * after, already checked to be a path on this site.
   */
  async start(next: string): Promise<{ location: string; cookie: { name: string; value: string; maxAgeMs: number } }> {
    const configuration = await this.configuration().catch((error: unknown) => {
      throw new OidcError('unavailable', `the provider's discovery document could not be read: ${said(error)}`);
    });
    const state = client.randomState();
    const nonce = client.randomNonce();
    const verifier = client.randomPKCECodeVerifier();
    const browser = randomBytes(32).toString('base64url');
    // Where to go after, kept with the login: an address this long is no page of the panel's, and is not kept.
    const pending: Pending = { browser: hashOf(browser), verifier, nonce, next: next.length > NEXT_MAX ? '/' : next };
    await this.options.cache.set(`auth:oidc:${hashOf(state)}`, JSON.stringify(pending), LOGIN_MS);
    const location = client.buildAuthorizationUrl(configuration, {
      redirect_uri: this.options.redirectUri,
      scope: this.options.settings.scopes.join(' '),
      state,
      nonce,
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
    });
    return { location: location.href, cookie: { name: SSO_COOKIE, value: browser, maxAgeMs: LOGIN_MS } };
  }

  /**
   * Finishes a login with the browser's way back (the query the provider sent it with) and its cookie: who logged
   * in, and where they wanted to go. Throws OidcError with why not.
   */
  async finish(query: URLSearchParams, browser: string | undefined): Promise<{ identity: OidcIdentity; next: string }> {
    const state = query.get('state');
    // The login under way, taken in one step: a state works once, even brought twice at the same moment.
    const saved = state ? await this.options.cache.take(`auth:oidc:${hashOf(state)}`) : null;
    // The person turned back at the provider (or it refused them before any login): said as such.
    if (query.has('error')) {
      const error = query.get('error') ?? '';
      throw new OidcError(
        error === 'access_denied' || error === 'login_required' || error === 'consent_required'
          ? 'cancelled'
          : 'failed',
        `the provider sent the browser back with ${error}${query.get('error_description') ? `: ${query.get('error_description')}` : ''}`,
      );
    }
    if (!saved)
      throw new OidcError('expired', 'no login of this browser is under way (it took over ten minutes, or was used)');
    const pending = JSON.parse(saved) as Pending;
    // The cookie proves this browser started the login: a link with someone else's state logs nobody in (login CSRF).
    const expected = Buffer.from(pending.browser, 'hex');
    const given = Buffer.from(browser ? hashOf(browser) : '', 'hex');
    if (expected.length !== given.length || !timingSafeEqual(expected, given))
      throw new OidcError('expired', 'the login did not start in this browser');
    const configuration = await this.configuration().catch((error: unknown) => {
      throw new OidcError('unavailable', `the provider's discovery document could not be read: ${said(error)}`);
    });
    let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
    try {
      // The way back as the provider made it, on the redirect address it was given (behind a proxy the request's own
      // address may differ): the code traded with the verifier, the ID token checked against the state and nonce.
      const back = new URL(this.options.redirectUri);
      back.search = query.toString();
      tokens = await client.authorizationCodeGrant(configuration, back, {
        pkceCodeVerifier: pending.verifier,
        expectedState: state ?? '',
        expectedNonce: pending.nonce,
        idTokenExpected: true,
      });
    } catch (error) {
      if (unreachable(error)) throw new OidcError('unavailable', `the provider did not answer: ${said(error)}`);
      throw new OidcError('failed', `the provider did not let the login through: ${said(error)}`);
    }
    const claims = tokens.claims();
    if (!claims) throw new OidcError('failed', 'the provider sent no ID token');
    const identity = await this.identify(configuration, claims, tokens.access_token);
    return { identity, next: pending.next };
  }

  // Who the claims say logged in, asking the provider's userinfo for what the ID token does not carry (a groups
  // mapper set to userinfo only, a Discord ID kept as an attribute).
  private async identify(
    configuration: client.Configuration,
    claims: client.IDToken,
    accessToken: string,
  ): Promise<OidcIdentity> {
    const { settings } = this.options;
    const wanted = [settings.groupsClaim, ...(settings.discordClaim ? [settings.discordClaim] : [])];
    let found: Record<string, unknown> = { ...claims };
    if (wanted.some((path) => claimAt(found, path) === undefined) && configuration.serverMetadata().userinfo_endpoint) {
      try {
        // The userinfo of this same person (its subject must be the ID token's), under the ID token's claims.
        const info = await client.fetchUserInfo(configuration, accessToken, claims.sub);
        found = { ...info, ...claims };
        for (const path of wanted) if (claimAt(found, path) === undefined) found = mergeAt(found, info, path);
      } catch (error) {
        // Without it the person may still have what they need in the ID token; the log says why it was not asked.
        this.options.log.info('the provider did not give its userinfo', { reason: said(error) });
      }
    }
    const name = [found.name, found.preferred_username, found.nickname, found.given_name].find(
      (value): value is string => typeof value === 'string' && value.trim() !== '',
    );
    const discord = settings.discordClaim ? claimAt(found, settings.discordClaim) : undefined;
    return {
      subject: claims.sub,
      issuer: claims.iss,
      name: [...(name ?? claims.sub).trim()].slice(0, NAME_MAX).join(''),
      groups: claimValues(claimAt(found, settings.groupsClaim)),
      // A Discord ID as text only: a JSON number that long has lost its last digits already.
      discordId: typeof discord === 'string' && /^\d{17,20}$/.test(discord) ? discord : null,
    };
  }

  /**
   * Where to send the browser to log out at the provider too, when it offers that (end_session_endpoint): it comes back
   * to the login page. Null when it does not, or cannot be reached now (the login here has ended either way).
   */
  async logoutUrl(): Promise<string | null> {
    try {
      const configuration = await this.configuration();
      if (!configuration.serverMetadata().end_session_endpoint) return null;
      return client.buildEndSessionUrl(configuration, {
        client_id: this.options.settings.clientId,
        post_logout_redirect_uri: this.options.afterLogout,
      }).href;
    } catch {
      return null;
    }
  }

  /**
   * Checks the settings against the provider without logging anyone in: what was found, or the failure. With the
   * secret in use withheld (a test that moved the issuer or the client), the client is not tried: nothing is sent to
   * its token endpoint.
   */
  async test(options: { secretWithheld?: boolean } = {}): Promise<Check[]> {
    const checks: Check[] = [];
    let configuration: client.Configuration;
    try {
      // Afresh, not the one kept: the test is for settings that may have just changed.
      configuration = await this.discover();
    } catch (error) {
      checks.push({ name: 'discovery', status: 'fail', detail: `${this.options.settings.issuer}: ${said(error)}` });
      return checks;
    }
    const metadata = configuration.serverMetadata();
    checks.push({
      name: 'discovery',
      status: 'ok',
      detail: `${metadata.issuer} names itself as configured, with its authorization and token endpoints`,
    });
    // The keys ID tokens are signed with.
    try {
      const jwks = metadata.jwks_uri
        ? await (this.options.fetch ?? fetch)(metadata.jwks_uri, { signal: AbortSignal.timeout(REQUEST_S * 1000) })
        : null;
      const keys = jwks?.ok ? ((await jwks.json()) as { keys?: unknown[] }).keys : undefined;
      checks.push(
        Array.isArray(keys) && keys.length > 0
          ? {
              name: 'signing keys',
              status: 'ok',
              detail: `${keys.length} key${keys.length === 1 ? '' : 's'} at ${metadata.jwks_uri}`,
            }
          : {
              name: 'signing keys',
              status: 'fail',
              detail: `no keys at ${metadata.jwks_uri ?? 'the document (no jwks_uri)'}`,
            },
      );
    } catch (error) {
      checks.push({ name: 'signing keys', status: 'fail', detail: said(error) });
    }
    // The client: a code no one was given, traded at the token endpoint. A provider that knows the client says the
    // code is not valid (invalid_grant); one that does not, that the client is not (invalid_client). Not tried without
    // the secret in use, which goes only to the issuer and client it is for.
    if (options.secretWithheld) {
      checks.push({
        name: 'client',
        status: 'warn',
        detail:
          'not tried: give JUKECORD_OIDC_CLIENT_SECRET to test another issuer or client (the secret in use goes only where it goes now)',
      });
    } else
      try {
        await client.genericGrantRequest(configuration, 'authorization_code', {
          code: `jukecord-test-${randomBytes(12).toString('base64url')}`,
          redirect_uri: this.options.redirectUri,
          code_verifier: client.randomPKCECodeVerifier(),
        });
        checks.push({ name: 'client', status: 'warn', detail: 'the provider took a made-up code' });
      } catch (error) {
        const code = error instanceof client.ResponseBodyError ? error.error : null;
        if (code === 'invalid_grant')
          checks.push({
            name: 'client',
            status: 'ok',
            detail: `the provider knows ${this.options.settings.clientId} and its secret`,
          });
        else if (code === 'invalid_client' || code === 'unauthorized_client')
          checks.push({
            name: 'client',
            status: 'fail',
            detail: `the provider refused the client ID or its secret (${said(error)})`,
          });
        else checks.push({ name: 'client', status: unreachable(error) ? 'fail' : 'warn', detail: said(error) });
      }
    checks.push({
      name: 'redirect',
      status: 'ok',
      detail: `the provider must list ${this.options.redirectUri} among the client's redirects`,
    });
    checks.push({
      name: 'PKCE',
      status: 'ok',
      detail: metadata.code_challenge_methods_supported?.includes('S256')
        ? 'the provider takes S256'
        : 'the provider does not list S256; jukecord sends it anyway',
    });
    checks.push({
      name: 'logout',
      status: 'ok',
      detail: metadata.end_session_endpoint
        ? `logging out of jukecord logs out at the provider too, and comes back to ${this.options.afterLogout}`
        : 'the provider offers no logout: logging out ends the login here only',
    });
    return checks;
  }
}

// The claims with one path taken from the userinfo when the ID token lacks it (its first step, whole).
function mergeAt(
  claims: Record<string, unknown>,
  info: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  const first = Object.keys(info).find((key) => path === key || path.startsWith(`${key}.`));
  return first === undefined ? claims : { ...claims, [first]: info[first] };
}
