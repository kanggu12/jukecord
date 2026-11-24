/**
 * Changes of one server made at the same moment, over a database that answers every statement a turn of the event
 * loop later (as a network database does): each ends as it would one after the other, in either order. While the
 * database answered synchronously no two changes could overlap at all; now they can wait halfway, and the server's
 * lane (src/core/lanes.ts) is what keeps one from running in the other's gap.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type ActionContext, ActionError, Actions } from '../../src/app/actions.ts';
import { Bus } from '../../src/core/bus.ts';
import { GuildLanes } from '../../src/core/lanes.ts';
import { Players } from '../../src/core/players.ts';
import { QueueService } from '../../src/core/queue.ts';
import { AUTOPLAY } from '../../src/core/types.ts';
import { createLogger } from '../../src/log.ts';
import type { Resolver } from '../../src/media/resolver.ts';
import { FakeClock, FakeMedia, flush } from '../support/fakes.ts';
import { addTracks, type Hold, slowMemoryStore } from '../support/store.ts';

const GUILD = '100000000000000001';
const ALICE: ActionContext = { guildId: GUILD, userId: '300000000000000001', mayControl: true, mayManage: false };

// Actions, a queue and players over the slow database (held where `hold` says), sharing one set of lanes (as main.ts
// does); "x", "a", "p" and "y" find one track each.
async function setup(hold?: Hold) {
  const clock = new FakeClock();
  const store = await slowMemoryStore(() => clock.now(), hold);
  const bus = new Bus();
  const lanes = new GuildLanes();
  const queue = new QueueService(store.queue, bus, lanes);
  const media = new FakeMedia();
  const log = createLogger({ level: 'error', sinks: [] });
  const players = new Players({
    lanes,
    queue,
    media,
    history: store.history,
    state: store.playerState,
    bus,
    clock,
    log,
    fetchTimeoutMs: 60_000,
  });
  const [x, a, p, y] = await addTracks(store, 4);
  if (!x || !a || !p || !y) throw new Error('no tracks');
  const table = new Map([
    ['x', x],
    ['a', a],
    ['p', p],
    ['y', y],
  ]);
  const resolver = {
    resolve: async (input: string) => {
      const found = table.get(input);
      if (!found) throw new Error('nothing was found');
      return [found];
    },
  } as unknown as Resolver;
  const actions = new Actions({ lanes, store, queue, players, resolver, log });
  return { clock, store, queue, media, players, actions, x, a, p, y };
}

// A server playing X, with A (a person's) and then P (autoplay's, which fills a queue that ran out) waiting.
async function playingWithAutoplayAfter(hold?: Hold) {
  const context = await setup(hold);
  const { queue, players, media, x, a, p } = context;
  await queue.add(GUILD, [x.id, a.id], 'end', ALICE.userId);
  await queue.add(GUILD, [p.id], 'end', AUTOPLAY);
  await players.get(GUILD).play();
  media.finish(180_000);
  await flush();
  assert.equal(players.get(GUILD).snapshot().track?.id, x.id);
  return context;
}

// The queue as track IDs, in order.
async function order(context: Awaited<ReturnType<typeof setup>>): Promise<number[]> {
  return (await context.queue.list(GUILD)).map((item) => item.track.id);
}

describe('two changes of one server at once', () => {
  it('end as one after the other: an add and a skip give the queue either order gives', async () => {
    // One after the other, add first: Y goes after A (before autoplay's P), then the skip takes A.
    const sequential = await playingWithAutoplayAfter();
    await sequential.actions.add(ALICE, 'y');
    await sequential.actions.skip(ALICE);
    const expected = [sequential.y.id, sequential.p.id];
    assert.deepEqual(await order(sequential), expected);
    // The other order: the skip takes A, then Y goes before P: the same queue.
    const reversed = await playingWithAutoplayAfter();
    await reversed.actions.skip(ALICE);
    await reversed.actions.add(ALICE, 'y');
    assert.deepEqual(await order(reversed), expected);
    // At once: the add is held after it read where autoplay's tracks begin (after A), just as it starts to insert, and
    // the skip is asked for meanwhile. Without the lane the skip took A in that gap, and Y went in after P: autoplay's
    // track before a person's. With it, the skip waits for the add's turn to end.
    let armed = false;
    let reached = () => {};
    const atInsert = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const together = await playingWithAutoplayAfter((what) => {
      // The add's look at where autoplay's tracks begin (QueueRepository.autoplayTail), then its insert's transaction.
      if (what.includes('added_by IS NULL OR added_by != ?')) armed = true;
      else if (armed && what === 'BEGIN') {
        armed = false;
        reached();
        return released;
      }
      return undefined;
    });
    const adding = together.actions.add(ALICE, 'y');
    await atInsert;
    const skipping = together.actions.skip(ALICE);
    // Long enough for the skip to run to its end, were it not waiting for the server's turn.
    for (let i = 0; i < 30; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    await Promise.all([adding, skipping]);
    assert.deepEqual(await order(together), [together.y.id, together.p.id]);
    // A plays, and went into nobody's queue twice.
    assert.equal(together.players.get(GUILD).snapshot().track?.id, together.a.id);
  });

  it('end as one after the other: two adds of one person hold to the limit of tracks per person', async () => {
    const { store, queue, actions, players, media, x } = await setup();
    await store.settings.setCommunity(GUILD, { personLimit: 1 });
    // Something plays, so what is added waits in the queue.
    await queue.add(GUILD, [x.id], 'end', null);
    await players.get(GUILD).play();
    media.finish(180_000);
    await flush();
    // Each add counts the person's tracks before it inserts: at once, both counted none.
    const answers = await Promise.allSettled([actions.add(ALICE, 'a'), actions.add(ALICE, 'y')]);
    const refused = answers.filter(
      (answer) =>
        answer.status === 'rejected' && answer.reason instanceof ActionError && answer.reason.code === 'conflict',
    );
    assert.equal(refused.length, 1);
    assert.equal(await queue.countBy(GUILD, ALICE.userId), 1);
  });

  it('end as one after the other: two skips at once move on twice, each track played once', async () => {
    const { queue, actions, players, media, store, clock, x, a, p, y } = await setup();
    await queue.add(GUILD, [x.id, a.id, p.id, y.id], 'end', ALICE.userId);
    await players.get(GUILD).play();
    media.finish(180_000);
    await flush();
    // Played for half a minute: a play the history keeps.
    await clock.advance(30_000);
    await Promise.all([actions.skip(ALICE), actions.skip(ALICE)]);
    // X was skipped, then A (loading when the second skip came): P is getting ready, Y waits.
    assert.equal(players.get(GUILD).snapshot().track?.id, p.id);
    assert.deepEqual(
      (await queue.list(GUILD)).map((item) => item.track.id),
      [y.id],
    );
    // Only X had played (A never started), so the history holds X once.
    assert.deepEqual(
      (await store.history.list(GUILD)).map((entry) => entry.track.id),
      [x.id],
    );
  });

  it('show a reader the player as it was before a change or as it is after, never halfway', async () => {
    // Looked at whenever a statement is about to run: a moment when other code (a panel asking what plays) can run.
    let look: (() => void) | null = null;
    const context = await playingWithAutoplayAfter(() => {
      look?.();
      return undefined;
    });
    const player = context.players.get(GUILD);
    const seen = new Set<string>();
    look = () => {
      const snapshot = player.snapshot();
      seen.add(`${snapshot.status} ${snapshot.track?.id ?? 'none'}`);
    };
    // A skip writes X's play, takes A out of the queue and saves the player: X playing until A is loading.
    await context.clock.advance(30_000);
    await context.actions.skip(ALICE);
    assert.deepEqual([...seen].sort(), [`loading ${context.a.id}`, `playing ${context.x.id}`]);
    // A stop writes A's play (none: it never started) and goes idle: A loading until idle, nothing else.
    seen.clear();
    await context.actions.stop(ALICE);
    look = null;
    for (const state of seen) assert.ok(state === `loading ${context.a.id}` || state === 'idle none', state);
    assert.ok(seen.has('idle none'));
  });
});
