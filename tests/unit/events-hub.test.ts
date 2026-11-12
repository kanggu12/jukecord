import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import zlib from 'node:zlib';
import { ActionError } from '../../src/app/actions.ts';
import { EventHub } from '../../src/web/events.ts';

// The hub with everything around it replaced: the bus handlers are kept so a test can announce a change, access
// takes as long as a test says per server, voiceChannels says whose view it was asked for, and the queue is a list
// a test can grow, with a version a test can move (and a count of how often it was read).
function hub(
  delays: Record<string, number> = {},
  extra: {
    stillValid?: () => boolean;
    refuse?: () => Error | null;
    queueEveryMs?: number;
    listenersEveryMs?: number;
  } = {},
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
  const queue = { items: [] as unknown[], version: 0, reads: 0 };
  const actions = {
    nowPlaying: (context: { guildId: string }) => ({ guildId: context.guildId }),
    queue: () => {
      queue.reads += 1;
      return { items: queue.items, version: queue.version };
    },
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
    users: { get: (id: string) => ({ id, name: `Person ${id}`, avatar: null }) },
    log,
    queueVersion: () => queue.version,
    // The fake callers have no session or address of their own: the caps are tested over real connections instead.
    limits: { total: 10_000, perLogin: 10_000, perAddress: 10_000 },
    ...(extra.stillValid ? { stillValid: extra.stillValid } : {}),
    ...(extra.queueEveryMs !== undefined ? { queueEveryMs: extra.queueEveryMs } : {}),
    ...(extra.listenersEveryMs !== undefined ? { listenersEveryMs: extra.listenersEveryMs } : {}),
  } as unknown as ConstructorParameters<typeof EventHub>[0]);
  return { events, handlers, queue };
}

// A socket that keeps what the hub writes (gzip frames unpacked, as the panel does) and lets a test send it messages.
function socket() {
  const listeners = new Map<string, (data: unknown) => void>();
  const sent: Record<string, unknown>[] = [];
  // Every frame as it was written: its bytes and whether it was binary (gzip).
  const frames: { data: Buffer; binary: boolean }[] = [];
  // The close codes the hub used on this socket, and their reasons.
  const closed: number[] = [];
  const reasons: string[] = [];
  let terminated = false;
  const fake = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    on: (name: string, fn: (data: unknown) => void) => listeners.set(name, fn),
    send: (data: Buffer, options: { binary?: boolean } = {}) => {
      frames.push({ data, binary: options.binary === true });
      const text = options.binary ? zlib.gunzipSync(data).toString('utf8') : data.toString('utf8');
      sent.push(JSON.parse(text) as Record<string, unknown>);
    },
    close: (code: number, reason = '') => {
      closed.push(code);
      reasons.push(reason);
    },
    ping: () => {},
    terminate: () => {
      terminated = true;
    },
  };
  return {
    sent,
    frames,
    closed,
    reasons,
    fake,
    terminated: () => terminated,
    say: (message: Record<string, unknown>) => listeners.get('message')?.(JSON.stringify(message)),
    // What the hub sent of one type, in order.
    of: (type: string) => sent.filter((message) => message.type === type),
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
    events.attach(browser.fake as never, { principal: { kind: 'user', userId: 'u' } } as never, { guild: 'A' });
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
    events.attach(host.fake as never, { principal: { kind: 'host' } } as never, { guild: 'G' });
    events.attach(alice.fake as never, { principal: { kind: 'user', userId: 'alice' } } as never, { guild: 'G' });
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
    events.attach(ended.fake as never, { principal: { kind: 'user', userId: 'a' } } as never, { guild: 'G' });
    await settle(10);
    // A logged-out or revoked login.
    valid = false;
    beat(events);
    assert.deepEqual(ended.closed, [4401]);
    valid = true;
    events.attach(left.fake as never, { principal: { kind: 'user', userId: 'b' } } as never, { guild: 'G' });
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
    events.attach(browser.fake as never, { principal: { kind: 'user', userId: 'c' } } as never, { guild: 'G' });
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

  it('sends a burst of queue changes as one message with the latest queue, then at most one per interval', async () => {
    const { events, handlers, queue } = hub({}, { queueEveryMs: 60 });
    const browser = socket();
    events.attach(browser.fake as never, { principal: { kind: 'host' } } as never, { guild: 'G' });
    await settle(10);
    // Five changes in one moment (three failed tracks put back, the next taken out, say): one message, the last queue.
    for (let change = 1; change <= 5; change += 1) {
      queue.items = Array.from({ length: change }, (_, index) => ({ id: index }));
      queue.version = change;
      handlers.get('queue')?.({ guildId: 'G' });
    }
    await settle(10);
    assert.deepEqual(
      browser.of('queue').map((message) => (message.queue as { version: number }).version),
      [5],
    );
    // Two more right after: held back until the interval has passed, then sent together as the newest.
    queue.version = 6;
    handlers.get('queue')?.({ guildId: 'G' });
    queue.version = 7;
    handlers.get('queue')?.({ guildId: 'G' });
    await settle(20);
    assert.equal(browser.of('queue').length, 1, 'sent before the interval had passed');
    await settle(80);
    assert.deepEqual(
      browser.of('queue').map((message) => (message.queue as { version: number }).version),
      [5, 7],
    );
    events.close();
  });

  it('makes a big message once, as gzip for the panels that take it and as text for the others', async () => {
    const { events, handlers, queue } = hub({}, { queueEveryMs: 0 });
    // A queue well over the 2 KiB below which messages stay text.
    queue.items = Array.from({ length: 200 }, (_, index) => ({ id: index, title: `Track number ${index}` }));
    const first = socket();
    const second = socket();
    const old = socket();
    events.attach(first.fake as never, { principal: { kind: 'host' } } as never, { guild: 'G', gzip: true });
    events.attach(second.fake as never, { principal: { kind: 'host' } } as never, { guild: 'G', gzip: true });
    events.attach(old.fake as never, { principal: { kind: 'host' } } as never, { guild: 'G' });
    await settle(10);
    queue.version = 1;
    handlers.get('queue')?.({ guildId: 'G' });
    await settle(10);
    const frame = (browser: ReturnType<typeof socket>) => browser.frames.at(-1);
    // The very same bytes for both gzip panels: compressed once, not once per connection.
    assert.equal(frame(first)?.binary, true);
    assert.equal(frame(first)?.data, frame(second)?.data);
    // The panel without gzip gets the same message as text.
    assert.equal(frame(old)?.binary, false);
    assert.deepEqual(first.of('queue').at(-1), old.of('queue').at(-1));
    // Small messages stay text even for gzip panels.
    assert.equal(first.frames[0]?.binary, false, 'the hello');
    events.close();
  });

  it('reads and serialises a server queue once per version, however many panels subscribe', async () => {
    const { events, queue } = hub();
    queue.items = Array.from({ length: 50 }, (_, index) => ({ id: index }));
    queue.version = 3;
    const browsers = Array.from({ length: 20 }, () => socket());
    for (const [index, browser] of browsers.entries()) {
      events.attach(browser.fake as never, { principal: { kind: 'host' } } as never, {
        guild: 'G',
        gzip: index % 2 === 0,
      });
    }
    await settle(20);
    assert.equal(queue.reads, 1);
    for (const browser of browsers) {
      const state = browser.of('state')[0];
      assert.ok(state);
      assert.equal((state.queue as { version: number }).version, 3);
      // The state of a subscribe is whole: the shared queue and this panel's own parts.
      assert.deepEqual(Object.keys(state).sort(), ['guild', 'listeners', 'player', 'queue', 'type', 'v', 'voice']);
    }
    // A change: read again, once.
    queue.version = 4;
    events.attach(socket().fake as never, { principal: { kind: 'host' } } as never, { guild: 'G' });
    await settle(10);
    assert.equal(queue.reads, 2);
    events.close();
  });

  it('does not send a combined queue message to a panel whose state already had it', async () => {
    const { events, handlers, queue } = hub({}, { queueEveryMs: 40 });
    const early = socket();
    events.attach(early.fake as never, { principal: { kind: 'host' } } as never, { guild: 'G' });
    await settle(10);
    queue.version = 1;
    handlers.get('queue')?.({ guildId: 'G' });
    await settle(5);
    // A change held back by the interval, and a panel that subscribes meanwhile: its state has the newest queue.
    queue.version = 2;
    handlers.get('queue')?.({ guildId: 'G' });
    const late = socket();
    events.attach(late.fake as never, { principal: { kind: 'host' } } as never, { guild: 'G' });
    await settle(80);
    assert.deepEqual(
      early.of('queue').map((message) => (message.queue as { version: number }).version),
      [1, 2],
    );
    assert.equal(late.of('queue').length, 0);
    const state = late.of('state')[0];
    assert.ok(state);
    assert.equal((state.queue as { version: number }).version, 2);
    events.close();
  });

  it('names the first twenty listeners, counts every browser, and tells a crowd at most once a second', async () => {
    const { events } = hub({}, { listenersEveryMs: 200 });
    const watcher = socket();
    events.attach(watcher.fake as never, { principal: { kind: 'host' } } as never, { guild: 'G' });
    const people = Array.from({ length: 30 }, () => socket());
    for (const [index, browser] of people.entries()) {
      events.attach(browser.fake as never, { principal: { kind: 'user', userId: `u${index}` } } as never, {
        guild: 'G',
      });
    }
    await settle(20);
    // Thirty people press "listen here" one after another.
    for (const browser of people) {
      browser.say({ type: 'listening', on: true });
      await settle(2);
    }
    await settle(300);
    const told = watcher.of('listeners').map((message) => message.listeners as { people: unknown[]; count: number });
    // The first press is told at once and the rest together, instead of thirty messages that each name everyone.
    assert.ok(told.length <= 3, `${told.length} listener messages`);
    assert.deepEqual({ named: told.at(-1)?.people.length, count: told.at(-1)?.count }, { named: 20, count: 30 });
    assert.deepEqual(events.listeners('G').count, 30);
    events.close();
  });

  it('cuts off a panel with 8 MiB waiting for it, and only that one', async () => {
    const { events, handlers } = hub({}, { queueEveryMs: 0 });
    const slow = socket();
    const quick = socket();
    events.attach(slow.fake as never, { principal: { kind: 'host' } } as never, { guild: 'G' });
    events.attach(quick.fake as never, { principal: { kind: 'host' } } as never, { guild: 'G' });
    await settle(10);
    // Without compression per connection, the count is of bytes waiting to be sent.
    slow.fake.bufferedAmount = 8 * 1024 ** 2 + 1;
    handlers.get('player')?.({ guildId: 'G' });
    assert.equal(slow.terminated(), true);
    assert.equal(quick.terminated(), false);
    assert.equal(quick.of('player').length, 1);
    assert.deepEqual(events.counts(), { connections: 1, listening: 0 });
    events.close();
  });
});
