/**
 * The panel logins the host sees and ends: every login that has not expired, whose it is and how it came in, and
 * ending one (its browser logged out at once, its live connection too), in the API and the CLI.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { InjectOptions } from 'fastify';
import { COMMANDS } from '../../src/cli/commands.ts';
import { API_PREFIX } from '../../src/web/api.ts';
import { CSRF_HEADER, memberKey } from '../../src/web/auth.ts';
import { ALICE, asHost, GUILD, type TestServer, testServer } from '../support/web.ts';

const api = (path: string) => `${API_PREFIX}${path}`;

const CAROL = memberKey('ldap', 'entryUUID:0c3a9f7e-0000-4000-8000-0000000000c1');

describe('the logins the host sees and ends', () => {
  let server: TestServer;
  const inject = (options: InjectOptions) => server.web.app.inject(options);
  // A login as the routes start one: its cookie, and the headers its panel sends.
  const login = async (principal: Parameters<TestServer['auth']['startSession']>[0]) => {
    const cookie = (await server.auth.startSession(principal)).split(';')[0] ?? '';
    const caller = await server.auth.identify({ cookie });
    if (!caller) throw new Error('the login just made does not log in');
    return { cookie, headers: { cookie, [CSRF_HEADER]: caller.csrf ?? '' } };
  };
  const list = async (headers: Record<string, string>) => {
    const answer = await inject({ method: 'GET', url: api('/sessions'), headers });
    assert.equal(answer.statusCode, 200);
    return answer.json() as { id: string; way: string; kind: string; name: string | null; current: boolean }[];
  };

  before(async () => {
    server = await testServer({ logins: true, listen: true });
    await server.store.users.upsert({ id: CAROL, name: 'Carol', avatar: null });
    await server.store.users.upsert({ id: ALICE, name: 'Alice', avatar: null });
  });
  after(() => server.close());

  it('lists every login with whose it is, how it came in and what it may do, the one asking marked', async () => {
    const carol = await login({ kind: 'member', memberId: CAROL, provider: 'ldap', level: 'control' });
    await login({ kind: 'user', userId: ALICE });
    await login({ kind: 'user', userId: ALICE, level: 'read' });
    await login({ kind: 'friend', scope: 'read' });
    const host = await login({ kind: 'host' });
    const seen = await list(host.headers);
    const shown = seen.map(({ way, kind, name, current }) => ({ way, kind, name, current }));
    for (const one of [
      { way: 'ldap', kind: 'member', name: 'Carol', current: false },
      { way: 'discord', kind: 'user', name: 'Alice', current: false },
      { way: 'oidc', kind: 'user', name: 'Alice', current: false },
      { way: 'link', kind: 'friend', name: null, current: false },
      { way: 'link', kind: 'host', name: null, current: true },
    ])
      assert.ok(
        shown.some((entry) => JSON.stringify(entry) === JSON.stringify(one)),
        `${JSON.stringify(one)} in ${JSON.stringify(shown)}`,
      );
    // An ID is the start of the hash of the cookie, never the cookie.
    for (const entry of seen) assert.match(entry.id, /^[0-9a-f]{16}$/);
    assert.ok(!JSON.stringify(seen).includes(carol.cookie.split('=')[1] ?? 'none'));
  });

  it("ends a member's login at once: their next request is refused, their live updates end", async () => {
    const carol = await login({ kind: 'member', memberId: CAROL, provider: 'ldap', level: 'admin' });
    const socket = new WebSocket(`${server.url.replace('http', 'ws')}/api/v1/events?guild=${GUILD}`, {
      headers: { cookie: carol.cookie },
    } as unknown as string[]);
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      socket.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason })),
    );
    await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve()));
    const theirs = (await list(asHost)).find((entry) => entry.kind === 'member' && !entry.current);
    if (!theirs) throw new Error("Carol's login is not listed");
    // Ended in their own login too: the latest of Carol's (each test's logins stay in the list).
    const ids = (await list(asHost)).filter((entry) => entry.kind === 'member').map((entry) => entry.id);
    for (const id of ids) {
      const ended = await inject({ method: 'DELETE', url: api(`/sessions/${id}`), headers: asHost });
      assert.equal(ended.statusCode, 200);
    }
    assert.deepEqual(await closed, { code: 4401, reason: 'the host ended this login' });
    assert.equal((await inject({ method: 'GET', url: api('/me'), headers: { cookie: carol.cookie } })).statusCode, 401);
    // An ID of no login: said so.
    const again = await inject({ method: 'DELETE', url: api(`/sessions/${ids[0]}`), headers: asHost });
    assert.equal(again.statusCode, 404);
    assert.equal(again.json().error.message, 'there is no such login');
    const odd = await inject({ method: 'DELETE', url: api('/sessions/not-an-id'), headers: asHost });
    assert.equal(odd.statusCode, 400);
  });

  it('is for the host and an admin member: other logins are refused', async () => {
    for (const principal of [
      { kind: 'member' as const, memberId: CAROL, provider: 'ldap' as const, level: 'control' as const },
      { kind: 'user' as const, userId: ALICE },
      { kind: 'friend' as const, scope: 'control' as const },
    ]) {
      const someone = await login(principal);
      const answer = await inject({ method: 'GET', url: api('/sessions'), headers: someone.headers });
      assert.equal(answer.statusCode, 403, principal.kind);
      const id = (await list(asHost))[0]?.id ?? '0000000000000000';
      assert.equal(
        (await inject({ method: 'DELETE', url: api(`/sessions/${id}`), headers: someone.headers })).statusCode,
        403,
      );
    }
    const admin = await login({ kind: 'member', memberId: CAROL, provider: 'ldap', level: 'admin' });
    assert.ok((await list(admin.headers)).some((entry) => entry.current));
  });

  it('has CLI commands: the list and the end of one', () => {
    assert.equal(COMMANDS.sessions.name, 'session list');
    assert.equal(COMMANDS['session-end'].name, 'session end');
    assert.deepEqual(
      COMMANDS['session-end'].request({ args: ['0123456789abcdef'], flags: new Map() } as never, {} as never),
      {
        params: { id: '0123456789abcdef' },
      },
    );
    assert.throws(
      () => COMMANDS['session-end'].request({ args: ['nope'], flags: new Map() } as never, {} as never),
      /login ID/,
    );
    const shown = COMMANDS.sessions.show([
      {
        id: '0123456789abcdef',
        way: 'ldap',
        kind: 'member',
        userId: CAROL,
        name: 'Carol',
        scope: 'control',
        createdAt: 0,
        seenAt: 0,
        expiresAt: 0,
        current: false,
      },
    ]);
    assert.match(shown, /^0123456789abcdef {2}Carol \(ldap, control\)/);
    assert.equal(COMMANDS.sessions.show([]), 'No logins');
  });
});
