/**
 * The fifth kind of login: a member of the host's identity provider or directory, whose groups gave them a level, and
 * an OIDC login that is a Discord user with a level on top. What each may do and where, how their sessions are kept
 * and read back, and that they show by their name.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { InjectOptions } from 'fastify';
import { Access, hostLike, LOCAL_GUILD, personOf } from '../../src/app/access.ts';
import { ActionError } from '../../src/app/actions.ts';
import { discordUserId } from '../../src/core/types.ts';
import { queueCard } from '../../src/discord/cards.ts';
import { API_PREFIX } from '../../src/web/api.ts';
import { CSRF_HEADER, hashSecret, memberKey, memberProvider } from '../../src/web/auth.ts';
import { memoryStore } from '../support/store.ts';
import {
  ALICE,
  asHost,
  DJ_ROLE,
  exampleTrack,
  FakeDirectory,
  GUILD,
  OTHER_GUILD,
  type TestServer,
  testServer,
} from '../support/web.ts';

const api = (path: string) => `${API_PREFIX}${path}`;

const CAROL = memberKey('ldap', 'f3a9e0b2-2c1d-4a7b-9e55-0d6c1b7e8a41');
const DAVE = memberKey('oidc', '9b1f6c2e-0000-4000-8000-00000000000d', 'https://sso.example.test/realms/home');

// What an ActionError's code is, or "none".
const code = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return 'none';
  } catch (error) {
    return error instanceof ActionError ? error.code : String(error);
  }
};

describe('member keys', () => {
  it('are short, the same at every login, apart by provider, and never a Discord ID', () => {
    assert.match(CAROL, /^ldap:[0-9a-f]{15}$/);
    assert.equal(CAROL.length, 20);
    assert.equal(memberKey('ldap', 'f3a9e0b2-2c1d-4a7b-9e55-0d6c1b7e8a41'), CAROL);
    assert.notEqual(memberKey('oidc', 'f3a9e0b2-2c1d-4a7b-9e55-0d6c1b7e8a41', 'https://sso.example.test'), CAROL);
    assert.equal(memberProvider(CAROL), 'ldap');
    assert.equal(memberProvider(DAVE), 'oidc');
    for (const other of [ALICE, 'host', 'autoplay', 'ldap:short', null]) assert.equal(memberProvider(other), null);
    assert.equal(discordUserId(CAROL), null);
    assert.equal(discordUserId(ALICE), ALICE);
  });

  it("are apart by the provider's issuer too: another provider's person of the same subject is someone else", () => {
    const here = memberKey('oidc', 'f2a1-mina', 'https://sso.example.test/realms/home');
    assert.match(here, /^oidc:[0-9a-f]{15}$/);
    assert.notEqual(memberKey('oidc', 'f2a1-mina', 'https://login.other.example/'), here);
    assert.equal(memberKey('oidc', 'f2a1-mina', 'https://sso.example.test/realms/home'), here);
  });
});

describe('Access for members', () => {
  async function setup(browserOnly = false) {
    const store = await memoryStore();
    const directory = new FakeDirectory();
    const access = new Access({ settings: store.settings, directory: () => (browserOnly ? null : directory) });
    return { store, directory, access };
  }
  const member = (level: 'admin' | 'control' | 'read') =>
    ({ kind: 'member', memberId: CAROL, provider: 'ldap', level }) as const;

  it('gives each level its rights in every server the bot is in, acting as the member', async () => {
    const { access } = await setup();
    const rights = async (level: 'admin' | 'control' | 'read') =>
      (await access.guilds(member(level))).map((guild) => [guild.id, guild.mayControl, guild.mayManage]);
    assert.deepEqual(await rights('admin'), [
      [GUILD, true, true],
      [OTHER_GUILD, true, true],
    ]);
    assert.deepEqual(await rights('control'), [
      [GUILD, true, false],
      [OTHER_GUILD, true, false],
    ]);
    assert.deepEqual(await rights('read'), [
      [GUILD, false, false],
      [OTHER_GUILD, false, false],
    ]);
    // What a member does is theirs: the context carries their key, so the queue shows who added a track.
    assert.deepEqual(await access.context(member('control'), GUILD), {
      guildId: GUILD,
      userId: CAROL,
      mayControl: true,
      mayManage: false,
    });
    assert.equal(await code(() => access.context(member('admin'), '199999999999999999')), 'not-found');
  });

  it('has the one local queue in browser-only mode, at their level', async () => {
    const { access } = await setup(true);
    assert.deepEqual(await access.guilds(member('read')), [{ ...LOCAL_GUILD, mayControl: false, mayManage: false }]);
    assert.deepEqual(await access.context(member('admin'), 'local'), {
      guildId: 'local',
      userId: CAROL,
      mayControl: true,
      mayManage: true,
    });
  });

  it('gives an OIDC login that is a Discord user their Discord rights, and the level where it gives more', async () => {
    const { store, directory, access } = await setup();
    await store.settings.setDjRole(GUILD, DJ_ROLE);
    // Alice is in the first server without the DJ role, and not in the second.
    directory.join(GUILD, ALICE);
    const plain = { kind: 'user', userId: ALICE } as const;
    assert.deepEqual(
      (await access.guilds(plain)).map((guild) => [guild.id, guild.mayControl]),
      [[GUILD, false]],
    );
    // With the control level: control in both, the second server through the level alone.
    const withControl = { ...plain, level: 'control' } as const;
    assert.deepEqual(
      (await access.guilds(withControl)).map((guild) => [guild.id, guild.mayControl, guild.mayManage]),
      [
        [GUILD, true, false],
        [OTHER_GUILD, true, false],
      ],
    );
    assert.equal((await access.context(withControl, OTHER_GUILD)).userId, ALICE);
    // A Discord manager with the read level keeps Manage Server where Discord gives it.
    directory.join(GUILD, ALICE, { manage: true });
    access.forget(ALICE);
    const withRead = { ...plain, level: 'read' } as const;
    assert.deepEqual(await access.context(withRead, GUILD), {
      guildId: GUILD,
      userId: ALICE,
      mayControl: true,
      mayManage: true,
    });
    assert.equal((await access.context(withRead, OTHER_GUILD)).mayControl, false);
    // Without a level, a server they are not in stays closed.
    assert.equal(await code(() => access.context(plain, OTHER_GUILD)), 'forbidden');
  });

  it('counts the host and admin levels as host-like, and names the person a login acts as', () => {
    assert.equal(hostLike({ kind: 'host' }), true);
    assert.equal(hostLike(member('admin')), true);
    assert.equal(hostLike(member('control')), false);
    assert.equal(hostLike({ kind: 'user', userId: ALICE, level: 'admin' }), true);
    assert.equal(hostLike({ kind: 'user', userId: ALICE }), false);
    assert.equal(hostLike({ kind: 'friend', scope: 'control' }), false);
    assert.equal(personOf(member('read')), CAROL);
    assert.equal(personOf({ kind: 'user', userId: ALICE, level: 'read' }), ALICE);
    assert.equal(personOf({ kind: 'host' }), null);
  });
});

describe('member sessions', () => {
  let server: TestServer;
  const inject = (options: InjectOptions) => server.web.app.inject(options);

  before(async () => {
    // Every way in set up: a member's login, and a linked one, come in only through ways that are.
    server = await testServer({ found: { one: [exampleTrack('m1')] }, logins: true });
    // A member is known by what their provider said at their last login.
    await server.store.users.upsert({ id: CAROL, name: 'Carol', avatar: null });
  });
  after(() => server.close());

  // A member's panel login, as the routes start one, with the headers a panel sends.
  async function memberLogin(level: 'admin' | 'control' | 'read', memberId = CAROL) {
    const provider = memberProvider(memberId) ?? 'ldap';
    const setCookie = await server.auth.startSession({ kind: 'member', memberId, provider, level });
    const cookie = setCookie.split(';')[0] ?? '';
    const caller = await server.auth.identify({ cookie });
    if (!caller?.csrf) throw new Error('the session just made does not log in');
    return { cookie, csrf: caller.csrf, caller };
  }

  it('keeps a member as a member, at the level the groups gave, and a linked login as its Discord user', async () => {
    const carol = await memberLogin('control');
    assert.deepEqual(carol.caller.principal, { kind: 'member', memberId: CAROL, provider: 'ldap', level: 'control' });
    assert.equal(carol.caller.scope, 'control');
    // The row: the member's key and the level, nothing else of theirs.
    const row = await server.store.sql.get('SELECT kind, user_id, scope FROM sessions WHERE id_hash = ?', [
      carol.caller.sessionHash,
    ]);
    assert.deepEqual(
      { kind: row?.kind, user_id: row?.user_id, scope: row?.scope },
      { kind: 'member', user_id: CAROL, scope: 'control' },
    );
    const setCookie = await server.auth.startSession({ kind: 'user', userId: ALICE, level: 'read' });
    const linked = await server.auth.identify({ cookie: setCookie.split(';')[0] });
    assert.deepEqual(linked?.principal, { kind: 'user', userId: ALICE, level: 'read' });
    // A linked login may call what a Discord login may; its level only adds rights, in Access.
    assert.equal(linked?.scope, 'admin');
  });

  it('logs nobody in from a member row that names no member, nor from a linked row without a Discord ID', async () => {
    for (const [kind, userId] of [
      ['member', null],
      ['member', ALICE],
      ['member', 'ldap:not-a-key'],
      ['linked', null],
      ['linked', CAROL],
    ] as const) {
      const secret = `forged-${kind}-${userId}`;
      await server.store.sessions.create({
        idHash: hashSecret(secret),
        kind,
        userId,
        csrf: 'c',
        scope: 'admin',
        expiresAt: Date.now() + 60_000,
      });
      // Never the host, never anyone: a row's kind cannot be bent into rights.
      assert.equal(await server.auth.identify({ cookie: `jukecord_session=${secret}` }), null, `${kind} ${userId}`);
    }
  });

  it('shows a member by their name in /me, with where they logged in and their level', async () => {
    const carol = await memberLogin('read');
    const me = await inject({ method: 'GET', url: api('/me'), headers: { cookie: carol.cookie } });
    assert.equal(me.statusCode, 200);
    assert.deepEqual(
      { ...(me.json() as Record<string, unknown>), csrf: null },
      {
        kind: 'member',
        id: CAROL,
        name: 'Carol',
        avatar: null,
        scope: 'read',
        csrf: null,
        bot: { id: '200000000000000001', name: 'jukecord', avatar: null },
        guest: null,
        member: { provider: 'ldap', level: 'read' },
      },
    );
  });

  it('holds each level to what it may do, in its own words', async () => {
    const reader = await memberLogin('read');
    const add = await inject({
      method: 'POST',
      url: api(`/guilds/${GUILD}/queue`),
      headers: { cookie: reader.cookie, [CSRF_HEADER]: reader.csrf },
      payload: { input: 'one' },
    });
    assert.equal(add.statusCode, 403);
    assert.equal(add.json().error.message, 'your groups let you look and listen, not change the music');
    const controller = await memberLogin('control');
    const role = await inject({
      method: 'PUT',
      url: api(`/guilds/${GUILD}/settings/dj-role`),
      headers: { cookie: controller.cookie, [CSRF_HEADER]: controller.csrf },
      payload: { roleId: null },
    });
    assert.equal(role.statusCode, 403);
    assert.equal(
      role.json().error.message,
      "your groups let you change the music, not the server's settings or tokens",
    );
    // What only the host may do: an admin member may, a control member may not.
    const logs = (who: { cookie: string }) =>
      inject({ method: 'GET', url: api('/logs'), headers: { cookie: who.cookie } });
    assert.equal((await logs(controller)).statusCode, 403);
    const admin = await memberLogin('admin');
    assert.equal((await logs(admin)).statusCode, 200);
  });

  it("makes login links for the host only: an admin member's would outlive the member", async () => {
    const admin = await memberLogin('admin');
    // A host's link would be a host's session, and a token that never expires; a friend's, thirty days.
    for (const scope of ['admin', 'control', 'read']) {
      const link = await inject({
        method: 'POST',
        url: api(`/login-links?scope=${scope}`),
        headers: { cookie: admin.cookie, [CSRF_HEADER]: admin.csrf },
      });
      assert.equal(link.statusCode, 403, scope);
      assert.equal(link.json().error.message, 'only the host can make login links');
    }
    // An OIDC login that is a Discord user, at the admin level: the same.
    const linked =
      (await server.auth.startSession({ kind: 'user', userId: ALICE, level: 'admin' })).split(';')[0] ?? '';
    const caller = await server.auth.identify({ cookie: linked });
    const theirs = await inject({
      method: 'POST',
      url: api('/login-links'),
      headers: { cookie: linked, [CSRF_HEADER]: caller?.csrf ?? '' },
    });
    assert.equal(theirs.statusCode, 403);
    assert.equal((await inject({ method: 'POST', url: api('/login-links'), headers: asHost })).statusCode, 200);
  });

  it("shows what a member adds by their name, and keeps their likes their own, not the host's", async () => {
    const carol = await memberLogin('control');
    const headers = { cookie: carol.cookie, [CSRF_HEADER]: carol.csrf };
    const added = await inject({
      method: 'POST',
      url: api(`/guilds/${GUILD}/queue`),
      headers,
      payload: { input: 'one' },
    });
    assert.equal(added.statusCode, 200);
    const item = added.json().items[0] as { addedBy: string; addedByName: string; track: { id: number } };
    assert.deepEqual([item.addedBy, item.addedByName], [CAROL, 'Carol']);
    const liked = await inject({ method: 'PUT', url: api(`/guilds/${GUILD}/likes/${item.track.id}`), headers });
    assert.equal(liked.statusCode, 200);
    const hosts = await inject({ method: 'GET', url: api(`/guilds/${GUILD}/likes`), headers: asHost });
    assert.deepEqual(hosts.json(), []);
    const theirs = await inject({
      method: 'GET',
      url: api(`/guilds/${GUILD}/likes`),
      headers: { cookie: carol.cookie },
    });
    assert.equal(theirs.json().length, 1);
    // A Discord card says a member is one, not a broken mention; a Discord user is mentioned.
    const track = await server.store.tracks.get(item.track.id);
    assert.ok(track);
    const card = JSON.stringify(
      queueCard(
        [
          { id: 1, guildId: GUILD, position: 0, track, addedBy: CAROL, addedAt: 0 },
          { id: 2, guildId: GUILD, position: 1, track, addedBy: ALICE, addedAt: 0 },
        ],
        1,
        'en',
      ).toJSON(),
    );
    assert.match(card, /added by a member/);
    assert.match(card, new RegExp(`added by <@${ALICE}>`));
    assert.doesNotMatch(card, /<@ldap:/);
  });

  it('makes no API token for a member or a linked login, and lets an admin member see and revoke every token', async () => {
    const admin = await memberLogin('admin');
    const made = await inject({
      method: 'POST',
      url: api('/tokens'),
      headers: { cookie: admin.cookie, [CSRF_HEADER]: admin.csrf },
      payload: { name: 'mine', scope: 'read' },
    });
    assert.equal(made.statusCode, 403);
    assert.equal(made.json().error.message, 'a login through SSO or a directory cannot make tokens');
    const linked = await server.auth.startSession({ kind: 'user', userId: ALICE, level: 'admin' });
    const caller = await server.auth.identify({ cookie: linked.split(';')[0] });
    assert.ok(caller);
    await assert.rejects(server.auth.createToken(caller, 'x', 'read'), /cannot make tokens/);
    const hosts = await inject({
      method: 'POST',
      url: api('/tokens'),
      headers: asHost,
      payload: { name: 'host script', scope: 'read' },
    });
    const id = hosts.json().info.id as number;
    const listed = await inject({ method: 'GET', url: api('/tokens'), headers: { cookie: admin.cookie } });
    assert.ok((listed.json() as { id: number }[]).some((token) => token.id === id));
    const revoked = await inject({
      method: 'DELETE',
      url: api(`/tokens/${id}`),
      headers: { cookie: admin.cookie, [CSRF_HEADER]: admin.csrf },
    });
    assert.equal(revoked.statusCode, 200);
  });
});
