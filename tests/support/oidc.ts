/**
 * A made-up OpenID Connect provider for tests, answering as a fetch does: its discovery document, its keys, a token
 * endpoint that checks the client, the code and the PKCE verifier and signs a real RS256 ID token, a userinfo
 * endpoint and a logout endpoint. Each test says who logs in and what their tokens carry, and can bend the answers
 * (another key, another nonce, an expired token) to see jukecord refuse them.
 */
import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';

export const ISSUER = 'https://sso.example.test/realms/home';
export const CLIENT_ID = 'jukecord';
export const CLIENT_SECRET = 'made-up-client-secret';

/** Who logs in at the provider, and what is in their ID token and their userinfo. */
export interface ProviderPerson {
  readonly sub: string;
  readonly idClaims?: Record<string, unknown>;
  readonly userinfo?: Record<string, unknown>;
}

/** Ways to bend what the provider sends, so a test can see jukecord refuse it. */
export interface Bent {
  /** Signs the ID token with a key the provider does not publish. */
  otherKey?: boolean;
  /** Puts another nonce in the ID token. */
  nonce?: string;
  /** Another audience than the client. */
  audience?: string;
  /** Another issuer than the provider. */
  issuer?: string;
  /** An ID token that expired an hour ago. */
  expired?: boolean;
  /** Leaves the end_session_endpoint out of the document. */
  noLogout?: boolean;
  /** The discovery document answers 503. */
  down?: boolean;
  /** Lists only client_secret_post for the token endpoint. */
  postOnly?: boolean;
}

function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

// A JWT signed with RS256 by a private key, with the key's ID in its header.
function jwt(payload: Record<string, unknown>, key: KeyObject, kid: string): string {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const body = b64url(JSON.stringify(payload));
  return `${head}.${body}.${b64url(sign('sha256', Buffer.from(`${head}.${body}`), key))}`;
}

export class FakeProvider {
  /** Its issuer: the https one, unless a test puts it on plain http. */
  readonly issuer: string;
  private readonly keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  private readonly stranger = generateKeyPairSync('rsa', { modulusLength: 2048 });
  // The codes handed out: who they log in, the PKCE challenge, the nonce and the redirect they were made for.
  private readonly codes = new Map<
    string,
    { person: ProviderPerson; challenge: string; nonce: string; redirect: string }
  >();
  private readonly accessTokens = new Map<string, ProviderPerson>();
  /** What the test bends now. */
  bent: Bent = {};
  /** Every request, by method and path, and the token requests' bodies and authorization headers. */
  readonly requests: string[] = [];
  readonly tokenRequests: { body: URLSearchParams; authorization: string | null }[] = [];
  private counter = 0;

  constructor(issuer = ISSUER) {
    this.issuer = issuer;
  }

  /** The fetch jukecord is given: every request to the provider lands here. */
  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    this.requests.push(`${method} ${url.pathname}`);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (url.pathname.endsWith('/.well-known/openid-configuration')) return this.discovery();
    if (url.pathname.endsWith('/certs')) return Response.json({ keys: [this.publicJwk()] });
    if (url.pathname.endsWith('/token')) return this.token(new URLSearchParams(String(init?.body ?? '')), headers);
    if (url.pathname.endsWith('/userinfo')) return this.userinfo(headers);
    return new Response('not here', { status: 404 });
  }) as typeof fetch;

  private publicJwk(): Record<string, unknown> {
    return { ...this.keys.publicKey.export({ format: 'jwk' }), kid: 'key-1', alg: 'RS256', use: 'sig' };
  }

  private discovery(): Response {
    if (this.bent.down) return new Response('down', { status: 503 });
    return Response.json({
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/protocol/openid-connect/auth`,
      token_endpoint: `${this.issuer}/protocol/openid-connect/token`,
      userinfo_endpoint: `${this.issuer}/protocol/openid-connect/userinfo`,
      jwks_uri: `${this.issuer}/protocol/openid-connect/certs`,
      ...(this.bent.noLogout ? {} : { end_session_endpoint: `${this.issuer}/protocol/openid-connect/logout` }),
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: this.bent.postOnly
        ? ['client_secret_post']
        : ['client_secret_basic', 'client_secret_post'],
    });
  }

  /**
   * What the provider does while the browser is there: the person logs in, and the browser is sent back with a code
   * (or with an error). Returns the query of the way back.
   */
  authorize(location: string, person: ProviderPerson | { error: string }): URLSearchParams {
    const url = new URL(location);
    const state = url.searchParams.get('state') ?? '';
    if ('error' in person) return new URLSearchParams({ error: person.error, state });
    this.counter += 1;
    const code = `code-${this.counter}`;
    this.codes.set(code, {
      person,
      challenge: url.searchParams.get('code_challenge') ?? '',
      nonce: url.searchParams.get('nonce') ?? '',
      redirect: url.searchParams.get('redirect_uri') ?? '',
    });
    return new URLSearchParams({ code, state, iss: this.issuer });
  }

  private token(body: URLSearchParams, headers: Headers): Response {
    this.tokenRequests.push({ body, authorization: headers.get('authorization') });
    // The client proves itself with HTTP Basic, or with the form field when that is all the provider lists.
    const basic = headers.get('authorization');
    // Basic's two parts are form-encoded before they are joined (RFC 6749, 2.3.1): decoded here as a provider does.
    const client = basic?.startsWith('Basic ')
      ? Buffer.from(basic.slice(6), 'base64')
          .toString()
          .split(':')
          .map((part) => decodeURIComponent(part.replace(/\+/g, ' ')))
          .join(':')
      : `${body.get('client_id')}:${body.get('client_secret')}`;
    if (client !== `${CLIENT_ID}:${CLIENT_SECRET}`) return Response.json({ error: 'invalid_client' }, { status: 401 });
    const grant = this.codes.get(body.get('code') ?? '');
    // A code works once, for the redirect it was made for, with the verifier of its challenge.
    this.codes.delete(body.get('code') ?? '');
    const verifier = body.get('code_verifier') ?? '';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    if (!grant || grant.redirect !== body.get('redirect_uri') || grant.challenge !== challenge)
      return Response.json({ error: 'invalid_grant', error_description: 'Code not valid' }, { status: 400 });
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: this.bent.issuer ?? this.issuer,
      aud: this.bent.audience ?? CLIENT_ID,
      sub: grant.person.sub,
      iat: now - (this.bent.expired ? 7200 : 0),
      exp: now + (this.bent.expired ? -3600 : 300),
      nonce: this.bent.nonce ?? grant.nonce,
      azp: CLIENT_ID,
      ...grant.person.idClaims,
    };
    const key = this.bent.otherKey ? this.stranger.privateKey : this.keys.privateKey;
    const accessToken = `access-${this.counter}`;
    this.accessTokens.set(accessToken, grant.person);
    return Response.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 300,
      id_token: jwt(claims, key, 'key-1'),
    });
  }

  private userinfo(headers: Headers): Response {
    const person = this.accessTokens.get(headers.get('authorization')?.replace(/^Bearer /, '') ?? '');
    if (!person) return new Response(null, { status: 401 });
    return Response.json({ sub: person.sub, ...person.userinfo });
  }
}
