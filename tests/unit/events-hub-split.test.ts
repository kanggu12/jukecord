/**
 * The live updates hub as an edge of a split jukecord runs it: what it reads is the core's (it answers later), a
 * player snapshot that was on its way while a panel's state was read is not sent after it, who listens on the other
 * edges is counted and shown with this edge's own, a logout or a revoked link is told to the other edges, and a core
 * lost or replaced closes every connection with 1012 so each panel asks for the whole state again.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Ending } from '../../src/bus/relay.ts';
import { type ElsewhereListeners, EventHub, type Listener } from '../../src/web/events.ts';
import { eventually } from '../support/bus.ts';

// A socket that keeps what the hub writes (text frames only: the fake browser does not take gzip).
function socket() {
  const listeners = new Map<string, (data: unknown) => void>();
  const sent: Record<string, unknown>[] = [];
  const closed: number[] = [];
  const fake = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    on: (name: string, fn: (data: unknown) => void) => listeners.set(name, fn),
    send: (data: Buffer) => sent.push(JSON.parse(data.toString('utf8')) as Record<string, unknown>),
    close: (code: number) => closed.push(code),
    ping: () => {},
    terminate: () => {},
  };
  return {
    sent,
    closed,
    fake,
    say: (message: Record<string, unknown>) => listeners.get('message')?.(JSON.stringify(message)),
    of: (type: string) => sent.filter((message) => message.type === type),
  };
}

const settle = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

// A hub whose reads answer later, as the core's do over the bus; the version of the player is the test's to move.
function edgeHub(elsewhere?: ElsewhereListeners) {
  const handlers = new Map<string, (payload: Record<string, unknown>) => unknown>();
  const told: { name: string; guildId: string }[] = [];
  const bus = {
    on: (name: string, fn: (payload: Record<string, unknown>) => unknown) => handlers.set(name, fn),
    off: () => {},
    emit: (name: string, payload: { guildId: string }) => told.push({ name, guildId: payload.guildId }),
  };
  const player = { version: 10 };
  const later = <T>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 2));
  const actions = {
    nowPlaying: (context: { guildId: string }) => later({ guildId: context.guildId, version: player.version }),
    queue: () => later({ items: [], version: 1 }),
    voiceChannels: () => later({ current: null, channels: [] }),
    skipVotes: () => later({ on: false, votes: 0, needed: 0, voted: false }),
    skipVoters: () => later(new Set<string>()),
    currentSound: () => later({ volume: 100, preset: 'off' }),
  };
  const endings: Ending[] = [];
  const hub = new EventHub({
    bus,
    actions,
    access: { context: async (_principal: unknown, guildId: string) => ({ guildId, userId: null }) },
    presenter: { player: async (value: unknown) => value, queue: async (value: unknown) => value },
    users: { get: async (id: string) => ({ id, name: `Person ${id}`, avatar: null }) },
    log: { debug: () => {}, info: () => {} },
    queueVersion: () => 1,
    limits: { total: 10_000, perLogin: 10_000, perAddress: 10_000 },
    listenersEveryMs: 0,
    ...(elsewhere ? { elsewhere } : {}),
    endings: (ending: Ending) => endings.push(ending),
  } as unknown as ConstructorParameters<typeof EventHub>[0]);
  return { hub, handlers, player, endings, told };
}

describe('the live updates hub of an edge', () => {
  it('drops a player snapshot older than the state a panel was sent, and sends the newer ones', async () => {
    const { hub, handlers, player } = edgeHub();
    const browser = socket();
    player.version = 12;
    await hub.attach(browser.fake as never, { principal: { kind: 'host' } } as never, { guild: 'G' });
    // A snapshot the core sent before it read the state for this panel, arriving after the state.
    await handlers.get('player')?.({ guildId: 'G', version: 11, track: { id: 1 } });
    await settle();
    assert.equal(browser.of('state').length, 1);
    assert.deepEqual(browser.of('player'), []);
    await handlers.get('player')?.({ guildId: 'G', version: 13, track: { id: 2 } });
    assert.deepEqual(
      browser.of('player').map((message) => (message.player as { version: number }).version),
      [13],
    );
    hub.close();
  });

  it("counts and shows the other edges' listeners with its own, and tells its panels when theirs change", async () => {
    const away: { person: string; who: Listener }[] = [{ person: 'u2', who: { id: 'u2', name: 'Two', avatar: null } }];
    let awayCount = 1;
    const { hub, told } = edgeHub({ count: () => awayCount, shown: () => away });
    const browser = socket();
    await hub.attach(browser.fake as never, { principal: { kind: 'user', userId: 'u1' }, sessionHash: 's1' } as never, {
      guild: 'G',
    });
    // Its state first (read from the "core", a few answers one after another), then it starts listening.
    await eventually(() => browser.of('state').length === 1, 'the state');
    browser.say({ type: 'listening', on: true });
    // This edge's own browser first, then the other edge's person; both counted.
    const last = () => browser.of('listeners').at(-1)?.listeners as { people: Listener[]; count: number } | undefined;
    await eventually(() => last()?.count === 2, 'both listeners counted');
    const listeners = last() as { people: Listener[]; count: number };
    assert.deepEqual(
      listeners.people.map((person) => person.id),
      ['u1', 'u2'],
    );
    // What this edge reports to the others is its own only.
    assert.deepEqual(hub.ownListeners('G'), {
      count: 1,
      shown: [{ person: 'u1', who: { id: 'u1', name: 'Person u1', avatar: null } }],
      people: ['u1'],
    });
    assert.deepEqual(hub.listenedGuilds(), ['G']);
    assert.ok(told.some((event) => event.name === 'listeners'));
    // The other edge's browser stops: this edge's panels hear the new count, and nothing is told on the bus for it.
    const before = told.length;
    awayCount = 0;
    away.length = 0;
    hub.elsewhereChanged('G');
    await eventually(() => last()?.count === 1, 'the other edge gone from the count');
    assert.equal(told.length, before);
    hub.close();
  });

  it("tells the other edges a logout's and a revoked link's endings, and ends what they tell it without telling on", async () => {
    const { hub, endings } = edgeHub();
    const member = socket();
    const guest = socket();
    await hub.attach(
      member.fake as never,
      { principal: { kind: 'user', userId: 'u1' }, sessionHash: 'hash-1' } as never,
    );
    await hub.attach(
      guest.fake as never,
      { principal: { kind: 'guest', linkId: 7, guildId: 'G', expiresAt: 0 }, sessionHash: 'hash-2' } as never,
    );
    hub.endSession('hash-1');
    assert.deepEqual(member.closed, [4401]);
    assert.deepEqual(endings, [{ what: 'session', sessionHash: 'hash-1', reason: 'logged out' }]);
    // Another edge revoked the link: ended here, and not told on again.
    hub.ended({ what: 'guests', linkId: 7, reason: 'the listening link has ended' });
    assert.deepEqual(guest.closed, [4401]);
    assert.equal(endings.length, 1);
    hub.close();
  });

  it('closes every connection with 1012 when the core is lost or replaced, and goes on taking new ones', async () => {
    const { hub } = edgeHub();
    const first = socket();
    await hub.attach(first.fake as never, { principal: { kind: 'host' } } as never, { guild: 'G' });
    await settle();
    hub.restartAll();
    assert.deepEqual(first.closed, [1012]);
    assert.equal(hub.counts().connections, 0);
    const second = socket();
    assert.equal(
      await hub.attach(second.fake as never, { principal: { kind: 'host' } } as never, { guild: 'G' }),
      true,
    );
    // Its state is read from the core, a few answers one after another. The new state starts the count of snapshots
    // afresh: a new core's first versions are not taken for old ones.
    await eventually(() => second.of('state').length === 1, 'the new state');
    hub.close();
  });
});
