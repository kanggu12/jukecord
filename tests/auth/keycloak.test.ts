/**
 * Logging in through a real Keycloak (tests/auth/run.sh starts one with tests/auth/keycloak-realm.json), driven as a
 * browser drives it: jukecord sends it to Keycloak, the login form is filled in and sent, the redirects are followed
 * back with the cookies kept. Skipped unless JUKECORD_E2E_KEYCLOAK names the realm's issuer.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Browser } from './browser.ts';
import { type RunningJukecord, startJukecord } from './jukecord.ts';

const ISSUER = process.env.JUKECORD_E2E_KEYCLOAK ?? '';
const skip = ISSUER === '' ? 'JUKECORD_E2E_KEYCLOAK is not set (tests/auth/run.sh sets it)' : false;

// The realm's people, with their passwords (made up, in the realm file).
const PEOPLE = {
  ada: 'ada-e2e-password',
  dan: 'dan-e2e-password',
  lee: 'lee-e2e-password',
  sam: 'sam-e2e-password',
} as const;

// A jukecord on the realm's main client, its levels by the groups claim.
const MAIN = {
  JUKECORD_OIDC_CLIENT_ID: 'jukecord',
  JUKECORD_OIDC_CLIENT_SECRET: 'jukecord-e2e-client-secret',
  JUKECORD_OIDC_ADMIN_GROUPS: 'jukecord-admins',
  JUKECORD_OIDC_CONTROL_GROUPS: 'jukecord-djs',
  JUKECORD_OIDC_READ_GROUPS: 'jukecord-listeners',
  JUKECORD_OIDC_LABEL: 'Log in with Keycloak',
};

/** Logs a person in at Keycloak through jukecord: the browser, where it ended, and who jukecord says it is. */
async function logIn(jukecord: RunningJukecord, name: keyof typeof PEOPLE, password: string = PEOPLE[name]) {
  const browser = new Browser();
  // To jukecord's key, and on to Keycloak's login page.
  const page = await browser.go(`${jukecord.url}/auth/sso?next=/stats`, { headers: { accept: 'text/html' } });
  assert.equal(page.response.status, 200, `Keycloak's login page did not open: ${page.url}`);
  assert.ok(page.url.startsWith(`${ISSUER}/protocol/openid-connect/auth?`), page.url);
  const form = await page.response.text();
  // The person types their name and password and presses the key; the browser follows Keycloak back to jukecord.
  const back = await browser.submit(form, page.url, { username: name, password });
  const me = await browser.request(`${jukecord.url}/api/v1/me`);
  const answer = me.status === 200 ? ((await me.json()) as Record<string, unknown>) : null;
  return { browser, ended: back.url, me: answer };
}

describe('logging in through Keycloak', { skip }, () => {
  let main: RunningJukecord;

  before(async () => {
    main = await startJukecord(18900, { JUKECORD_OIDC_ISSUER: ISSUER, ...MAIN });
  });
  after(async () => {
    await main?.stop();
  });

  it('shows the key with its words on the login page, as the methods say', async () => {
    const methods = await (await fetch(`${main.url}/api/v1/auth/methods`)).json();
    assert.deepEqual(methods, { discord: false, sso: { label: 'Log in with Keycloak' }, directory: null });
  });

  it('lets each group in at its level, back where they wanted to go, by their name', async () => {
    const ada = await logIn(main, 'ada');
    assert.equal(ada.ended, `${main.url}/stats`);
    assert.equal(ada.me?.kind, 'member');
    assert.equal(ada.me?.name, 'Ada Admin');
    assert.deepEqual(ada.me?.member, { provider: 'oidc', level: 'admin' });
    // The admin level may do what the host may: the log is the host's.
    assert.equal((await ada.browser.request(`${main.url}/api/v1/logs?limit=1`)).status, 200);
    const dan = await logIn(main, 'dan');
    assert.deepEqual(dan.me?.member, { provider: 'oidc', level: 'control' });
    const guilds = (await (await dan.browser.request(`${main.url}/api/v1/guilds`)).json()) as {
      mayControl: boolean;
      mayManage: boolean;
    }[];
    assert.deepEqual(
      guilds.map((guild) => [guild.mayControl, guild.mayManage]),
      [[true, false]],
    );
    assert.equal((await dan.browser.request(`${main.url}/api/v1/logs?limit=1`)).status, 403);
    const lee = await logIn(main, 'lee');
    assert.deepEqual(lee.me?.member, { provider: 'oidc', level: 'read' });
  });

  it("keeps the session cookie HttpOnly and SameSite=Lax, and the login's cookie away once it is done", async () => {
    const browser = new Browser();
    const start = await browser.request(`${main.url}/auth/sso`);
    assert.match(
      String(start.headers.get('set-cookie')),
      /^jukecord_sso=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600$/,
    );
    const page = await browser.go(String(start.headers.get('location')));
    await browser.submit(await page.response.text(), page.url, { username: 'lee', password: PEOPLE.lee });
    assert.equal(browser.cookie(main.url, 'jukecord_sso'), undefined);
    const session = browser.hops.length > 0 && browser.cookie(main.url, 'jukecord_session');
    assert.ok(session);
  });

  it('refuses someone in none of the groups, in words, with no session', async () => {
    const sam = await logIn(main, 'sam');
    assert.equal(sam.ended, `${main.url}/login?error=no-group`);
    assert.equal(sam.me, null);
    assert.equal(sam.browser.cookie(main.url, 'jukecord_session'), undefined);
  });

  it('takes a way back once, and only in the browser that left', async () => {
    const browser = new Browser();
    const page = await browser.go(`${main.url}/auth/sso`);
    // The form sent by hand, to catch the way back before the browser follows it.
    const form = /<form[^>]*\baction="([^"]+)"/.exec(await page.response.text())?.[1]?.replaceAll('&amp;', '&') ?? '';
    const sent = await browser.request(new URL(form, page.url).href, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'lee', password: PEOPLE.lee }).toString(),
    });
    const callback = String(sent.headers.get('location'));
    assert.ok(callback.startsWith(`${main.url}/auth/sso/callback?`), callback);
    // Another browser (no cookie of this login) is sent back with the reason; the one that left gets in once.
    const stranger = await fetch(callback, { redirect: 'manual' });
    assert.equal(stranger.headers.get('location'), '/login?error=sso-expired');
    // The stranger used the state up: the browser that left is told so too, and logs in again from the start.
    const late = await browser.request(callback);
    assert.equal(late.headers.get('location'), '/login?error=sso-expired');
  });

  it('logs out at Keycloak too, which sends the browser back to the login page', async () => {
    const lee = await logIn(main, 'lee');
    const out = await lee.browser.request(`${main.url}/auth/logout`, {
      method: 'POST',
      headers: { 'x-jukecord-csrf': String(lee.me?.csrf) },
    });
    assert.equal(out.status, 200);
    const { next } = (await out.json()) as { next: string };
    assert.ok(next.startsWith(`${ISSUER}/protocol/openid-connect/logout?`), next);
    // Keycloak asks whether to log out (jukecord sends no ID token to hint with: it keeps none), and then goes back.
    const ask = await lee.browser.go(next);
    const confirmed = await lee.browser.submit(await ask.response.text(), ask.url, {});
    assert.equal(confirmed.url, `${main.url}/login`);
    assert.equal((await lee.browser.request(`${main.url}/api/v1/me`)).status, 401);
    // Keycloak's own session ended too: the next login asks for the password again.
    const again = await lee.browser.go(`${main.url}/auth/sso`);
    assert.match(await again.response.text(), /name="password"/);
  });

  it('tests the settings against Keycloak, and names a wrong secret', async () => {
    const test = async (settings: Record<string, string> = {}) => {
      const answer = await fetch(`${main.url}/api/v1/auth/test-oidc`, {
        method: 'POST',
        headers: { authorization: `Bearer ${main.hostToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ settings }),
      });
      return (await answer.json()) as { ok: boolean; checks: { name: string; status: string; detail: string }[] };
    };
    const good = await test();
    assert.equal(good.ok, true, JSON.stringify(good.checks));
    const wrong = await test({ JUKECORD_OIDC_CLIENT_SECRET: 'not-the-secret' });
    assert.equal(wrong.checks.find((check) => check.name === 'client')?.status, 'fail');
    assert.ok(!JSON.stringify(wrong).includes('not-the-secret'));
  });
});

describe('logging in through Keycloak with the groups in the userinfo, and with realm roles', { skip }, () => {
  let userinfo: RunningJukecord;
  let roles: RunningJukecord;

  before(async () => {
    // A client whose groups mapper writes full paths to the userinfo only: jukecord asks the userinfo for them.
    userinfo = await startJukecord(18901, {
      JUKECORD_OIDC_ISSUER: ISSUER,
      JUKECORD_OIDC_CLIENT_ID: 'jukecord-userinfo',
      JUKECORD_OIDC_CLIENT_SECRET: 'jukecord-e2e-userinfo-secret',
      JUKECORD_OIDC_CONTROL_GROUPS: '/jukecord-djs',
      JUKECORD_OIDC_READ_GROUPS: 'jukecord-listeners',
    });
    // The realm roles, at their dotted path (the realm file's client mapper puts them in the userinfo).
    roles = await startJukecord(18902, {
      JUKECORD_OIDC_ISSUER: ISSUER,
      JUKECORD_OIDC_CLIENT_ID: 'jukecord',
      JUKECORD_OIDC_CLIENT_SECRET: 'jukecord-e2e-client-secret',
      JUKECORD_OIDC_GROUPS_CLAIM: 'realm_access.roles',
      JUKECORD_OIDC_CONTROL_GROUPS: 'jukecord-dj',
    });
  });
  after(async () => {
    await userinfo?.stop();
    await roles?.stop();
  });

  it('reads the groups from the userinfo when the ID token does not carry them, full paths or not', async () => {
    assert.deepEqual((await logIn(userinfo, 'dan')).me?.member, { provider: 'oidc', level: 'control' });
    assert.deepEqual((await logIn(userinfo, 'lee')).me?.member, { provider: 'oidc', level: 'read' });
  });

  it('reads realm roles at realm_access.roles', async () => {
    assert.deepEqual((await logIn(roles, 'dan')).me?.member, { provider: 'oidc', level: 'control' });
    assert.equal((await logIn(roles, 'lee')).me, null);
  });
});
