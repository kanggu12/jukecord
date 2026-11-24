/**
 * The test of the Discord login's application, logging no one in: a code no one was given, traded at Discord's token
 * endpoint with the application's ID and secret. Discord answers that the code is not valid (invalid_grant) for an
 * application it knows with that secret, and that the client is not (invalid_client) otherwise; no token is made
 * either way. The address the login comes back to is said too: Discord sends people back only to one the application
 * lists among its OAuth2 redirects.
 *
 * The secret goes to Discord's own address alone, never one a request names.
 */

/** One finding of a login test, as the identity provider's and the directory's tests say theirs. */
export interface LoginCheck {
  readonly name: string;
  readonly status: 'ok' | 'warn' | 'fail';
  readonly detail: string;
}

/** What the test found: false when any check failed. */
export interface DiscordLoginTest {
  readonly ok: boolean;
  readonly checks: readonly LoginCheck[];
}

/** What the test needs: the application's ID and secret as they would be in use, and the login's return address. */
export interface DiscordLoginOptions {
  readonly clientId: string | null;
  readonly clientSecret: string | null;
  /** `<public address>/auth/callback`, the address Discord sends people back to. */
  readonly redirectUri: string;
  /** Discord's API (changed only by tests, which never reach Discord). */
  readonly api?: string;
  readonly fetch?: typeof fetch;
}

// How long Discord has to answer: a test the page waits for.
const WAIT_MS = 10_000;

/** Tests the Discord login's application. */
export async function testDiscordLogin(options: DiscordLoginOptions): Promise<DiscordLoginTest> {
  const checks: LoginCheck[] = [];
  checks.push(await application(options));
  // The return address: a fact for the application's settings at Discord, which only a real login can try.
  checks.push({
    name: 'redirect',
    status: 'ok',
    detail: `the application's OAuth2 redirects must list ${options.redirectUri}`,
  });
  return { ok: checks.every((check) => check.status !== 'fail'), checks };
}

// The application: known to Discord with that secret, or not, or Discord out of reach.
async function application(options: DiscordLoginOptions): Promise<LoginCheck> {
  // Neither is optional for the login: said by its setting, before anything is sent.
  if (!options.clientId)
    return { name: 'application', status: 'fail', detail: 'no client ID (JUKECORD_DISCORD_CLIENT_ID)' };
  if (!options.clientSecret)
    return { name: 'application', status: 'fail', detail: 'no client secret (JUKECORD_DISCORD_CLIENT_SECRET)' };
  const api = options.api ?? 'https://discord.com/api/v10';
  const fetcher = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetcher(`${api}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      // A code made up for this test: no one was given it, so no login and no token can come of it.
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: `jukecord-test-${crypto.randomUUID()}`,
        redirect_uri: options.redirectUri,
        client_id: options.clientId,
        client_secret: options.clientSecret,
      }).toString(),
      signal: AbortSignal.timeout(WAIT_MS),
    });
  } catch (error) {
    // Not reached: the network's words (no route, no name, too slow).
    const reason = error instanceof Error ? error.message || error.name : String(error);
    return { name: 'application', status: 'fail', detail: `Discord could not be reached (${reason})` };
  }
  // Discord's answer in its own word for the error, when it gave one.
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  const code = typeof body?.error === 'string' ? body.error : null;
  if (code === 'invalid_grant')
    return {
      name: 'application',
      status: 'ok',
      detail: `Discord knows application ${options.clientId} and its secret`,
    };
  if (code === 'invalid_client' || code === 'unauthorized_client' || response.status === 401)
    return {
      name: 'application',
      status: 'fail',
      detail: `Discord refused the client ID or its secret (${code ?? response.status})`,
    };
  // A redirect address the application does not list is Discord's own complaint about the made-up code's request.
  if (code === 'invalid_request')
    return {
      name: 'application',
      status: 'warn',
      detail: `Discord refused the request (invalid_request): the application may not list ${options.redirectUri}`,
    };
  return {
    name: 'application',
    status: 'warn',
    detail: `Discord answered ${response.status}${code ? ` (${code})` : ''}`,
  };
}
