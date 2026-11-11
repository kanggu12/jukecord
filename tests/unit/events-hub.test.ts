import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ActionError } from '../../src/app/actions.ts';
import { EventHub } from '../../src/web/events.ts';

// The hub with everything around it replaced: the bus handlers are kept so a test can announce a change, access
// takes as long as a test says per server, and voiceChannels says whose view it was asked for.
function hub(
  delays: Record<string, number> = {},
  extra: { stillValid?: () => boolean; refuse?: () => Error | null } = {},
) {
  const handlers = new Map<string, (payload: { guildId: string }) => void>();
  const bus = {
    on: (name: string, fn: (payload: { guildId: string }) => void) => handlers.set(name, fn),
    off: () => {},
  };
  const access = {
    context: async (_principal: unknown, guildId: string) => {
      await new Promise((resolve) => setTimeout(resolve, delays[guildId] ?? 0));
      // A test can make the check fail from some point on (the person left, or Discord stopped answering).
      const refusal = extra.refuse?.();
      if (refusal) throw refusal;
      return { guildId, userId: null, mayControl: true, mayManage: false };
    },
  };
  const actions = {
    nowPlaying: (context: { guildId: string }) => ({ guildId: context.guildId }),
    queue: () => [],
    // The list names the viewer it was made for, which is all these tests look at.
    voiceChannels: (context: { userId: string | null; mayManage: boolean }) => ({
      current: null,
      channels: [{ id: context.userId ?? (context.mayManage ? 'host' : 'anyone') }],
    }),
  };
  const presenter = { player: (value: unknown) => value, queue: (value: unknown) => value };
  const log = { debug: () => {}, info: () => {} };
  const events = new EventHub({
    bus,
    actions,
    access,
    presenter,
    users: { get: () => null },
    log,
    ...(extra.stillValid ? { stillValid: extra.stillValid } : {}),
  } as unknown as ConstructorParameters<typeof EventHub>[0]);
  return { events, handlers };
}

// A socket that keeps what the hub writes and lets a test send it messages.
function socket() {
  const listeners = new Map<string, (data: unknown) => void>();
  const sent: Record<string, unknown>[] = [];
  // The close codes the hub used on this socket.
  const closed: number[] = [];
  return {
    sent,
    closed,
    say: (message: Record<string, unknown>) => listeners.get('message')?.(JSON.stringify(message)),
    fake: {
      OPEN: 1,
      readyState: 1,
      bufferedAmount: 0,
      on: (name: string, fn: (data: unknown) => void) => listeners.set(name, fn),
      send: (text: string) => sent.push(JSON.parse(text) as Record<string, unknown>),
      close: (code: number) => closed.push(code),
      ping: () => {},
      terminate: () => {},
    },
  };
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// One heartbeat now, instead of waiting thirty seconds for it.
const beat = (events: EventHub) => (events as unknown as { beat(): void }).beat();

describe('EventHub', () => {
  it('follows the server asked for last, even when an earlier ask is answered later', async () => {
    // The server in the address (A) takes longer to check than the one chosen while connecting (B).
    const { events, handlers } = hub({ A: 60, B: 5 });
    const browser = socket();
    events.attach(browser.fake as never, { principal: { kind: 'user', userId: 'u' } } as never, 'A');
    browser.say({ type: 'subscribe', guild: 'B' });
    await settle(150);
    const states = browser.sent.filter((message) => message.type === 'state').map((message) => message.guild);
    assert.deepEqual(states, ['B'], 'the late answer for A must not move the connection back');
    handlers.get('player')?.({ guildId: 'A' });
    handlers.get('player')?.({ guildId: 'B' });
    const players = browser.sent.filter((message) => message.type === 'player').map((message) => message.guild);
    assert.deepEqual(players, ['B']);
    events.close();
  });

  it("sends each connection the voice channels its own person can see, and the host's all of them", async () => {
    const { events, handlers } = hub();
    const host = socket();
    const alice = socket();
    events.attach(host.fake as never, { principal: { kind: 'host' } } as never, 'G');
    events.attach(alice.fake as never, { principal: { kind: 'user', userId: 'alice' } } as never, 'G');
    await settle(20);
    const view = (browser: ReturnType<typeof socket>, type: string) =>
      (browser.sent.findLast((message) => message.type === type)?.voice as { channels: { id: string }[] })?.channels[0]
        ?.id;
    assert.equal(view(host, 'state'), 'host');
    assert.equal(view(alice, 'state'), 'alice');
    handlers.get('voice')?.({ guildId: 'G' });
    assert.equal(view(host, 'voice'), 'host');
    assert.equal(view(alice, 'voice'), 'alice');
    events.close();
  });

  it('ends a connection whose login ended (4401) or that may no longer open its server (4410), at the heartbeat', async () => {
    let valid = true;
    let refusal: Error | null = null;
    const { events } = hub({}, { stillValid: () => valid, refuse: () => refusal });
    const ended = socket();
    const left = socket();
    events.attach(ended.fake as never, { principal: { kind: 'user', userId: 'a' } } as never, 'G');
    await settle(10);
    // A logged-out or revoked login.
    valid = false;
    beat(events);
    assert.deepEqual(ended.closed, [4401]);
    valid = true;
    events.attach(left.fake as never, { principal: { kind: 'user', userId: 'b' } } as never, 'G');
    await settle(10);
    // Someone who left the server.
    refusal = new ActionError('forbidden', 'you are not a member of that server');
    beat(events);
    await settle(10);
    assert.deepEqual(left.closed, [4410]);
    events.close();
  });

  it('keeps a connection when Discord does not answer or the database cannot be read this once', async () => {
    let fail: 'none' | 'discord' | 'database' = 'none';
    const { events } = hub(
      {},
      {
        stillValid: () => {
          if (fail === 'database') throw new Error('database is locked');
          return true;
        },
        refuse: () => (fail === 'discord' ? new ActionError('unavailable', 'Discord did not answer') : null),
      },
    );
    const browser = socket();
    events.attach(browser.fake as never, { principal: { kind: 'user', userId: 'c' } } as never, 'G');
    await settle(10);
    fail = 'discord';
    beat(events);
    await settle(10);
    fail = 'database';
    beat(events);
    await settle(10);
    assert.deepEqual(browser.closed, []);
    events.close();
  });
});
