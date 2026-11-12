/**
 * Votes to skip: who may vote, how many it takes, when the votes end, and the count made again as people come and go.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type ActionContext, ActionError, Actions, type Directory } from '../../src/app/actions.ts';
import { NOT_LISTENING, SkipVotes } from '../../src/app/votes.ts';
import { Bus } from '../../src/core/bus.ts';
import { Players } from '../../src/core/players.ts';
import { QueueService } from '../../src/core/queue.ts';
import type { Track } from '../../src/core/types.ts';
import { createLogger } from '../../src/log.ts';
import type { Resolver } from '../../src/media/resolver.ts';
import { FakeClock, FakeMedia, flush } from '../support/fakes.ts';
import { addTracks, memoryStore } from '../support/store.ts';

const GUILD = '100000000000000001';
const DJ_ROLE = '500000000000000001';
// Three people without the DJ role, and the DJ.
const [ANN, BEN, CAT, DEE] = ['300000000000000001', '300000000000000002', '300000000000000003', '300000000000000004'];
const listener = (userId: string): ActionContext => ({ guildId: GUILD, userId, mayControl: false, mayManage: false });
const DJ: ActionContext = { guildId: GUILD, userId: '300000000000000009', mayControl: true, mayManage: false };
const MANAGER: ActionContext = { guildId: GUILD, userId: '300000000000000008', mayControl: true, mayManage: true };

// A server with a DJ role and three tracks playing in turn, the people listening set by each test.
async function setup() {
  const clock = new FakeClock();
  const store = memoryStore(() => clock.now());
  const bus = new Bus();
  const queue = new QueueService(store.queue, bus);
  const media = new FakeMedia();
  const log = createLogger({ level: 'error', sinks: [] });
  const players = new Players({
    queue,
    media,
    history: store.history,
    state: store.playerState,
    bus,
    clock,
    log,
    fetchTimeoutMs: 60_000,
  });
  const tracks = addTracks(store, 3);
  const resolver = { resolve: async () => tracks } as unknown as Resolver;
  // Who listens: the test changes it, and says so on the bus as the voice side and the live updates do.
  const people = new Set<string>();
  const votes = new SkipVotes({
    players,
    bus,
    clock,
    log,
    applies: (guildId) => actions.voteSkipApplies(guildId),
    listening: () => new Set(people),
  });
  const actions = new Actions({ store, queue, players, resolver, log, votes });
  // Discord's side: the server has the DJ role among its roles.
  const directory = { roles: () => [{ id: DJ_ROLE, name: 'DJ', color: 0 }] } as unknown as Directory;
  actions.setVoice(null, () => true, directory);
  store.settings.setDjRole(GUILD, DJ_ROLE);
  // Every vote event, to see the panels told.
  const told: string[] = [];
  bus.on('votes', ({ guildId }) => told.push(guildId));
  await actions.add(DJ, 'three');
  media.finish(180_000);
  await flush();
  const listen = (...ids: string[]) => {
    people.clear();
    for (const id of ids) people.add(id);
    bus.emit('people', { guildId: GUILD });
  };
  const title = () => players.get(GUILD).snapshot().track?.title;
  return { clock, store, media, players, actions, tracks: tracks as Track[], listen, title, told };
}

// The message of an action's refusal.
function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ActionError) return `${error.code}: ${error.message}`;
    throw error;
  }
  return 'none';
}

describe('votes to skip', () => {
  it('skips once half of the people listening have voted, rounded up, saying how the vote stands until then', async () => {
    const { actions, listen, title, told } = await setup();
    listen(ANN, BEN, CAT);
    const first = actions.skip(listener(ANN));
    assert.deepEqual(first.votes, { votes: 1, needed: 2 });
    assert.equal(title(), 'Track 1');
    // Voting again changes nothing; the panels heard the count.
    assert.deepEqual(actions.skip(listener(ANN)).votes, { votes: 1, needed: 2 });
    assert.deepEqual(actions.skipVotes(listener(CAT)), { on: true, votes: 1, needed: 2 });
    assert.ok(told.length >= 1);
    const second = actions.skip(listener(BEN));
    assert.equal(second.votes, null);
    assert.equal(title(), 'Track 2');
    // A new track starts with no votes.
    assert.deepEqual(actions.skipVotes(listener(CAT)), { on: true, votes: 0, needed: 2 });
  });

  it('takes the one vote of someone listening alone, and refuses one from someone not listening', async () => {
    const { actions, listen, title } = await setup();
    listen(ANN);
    assert.equal(
      refusal(() => actions.skip(listener(BEN))),
      `forbidden: ${NOT_LISTENING}`,
    );
    assert.equal(actions.skip(listener(ANN)).votes, null);
    assert.equal(title(), 'Track 2');
  });

  it('ends the votes with the play: the next track, and the same one again by repeat, start from none', async () => {
    const { clock, media, actions, players, listen, title } = await setup();
    listen(ANN, BEN, CAT, DEE);
    actions.skip(listener(ANN));
    // The DJ skips: the vote was about a play that is over.
    actions.skip(DJ);
    media.finish(180_000);
    await flush();
    assert.equal(title(), 'Track 2');
    assert.equal(actions.skipVotes(listener(BEN)).votes, 0);
    assert.deepEqual(actions.skip(listener(BEN)).votes, { votes: 1, needed: 2 });
    // Track 2 plays again from the top by repeat: its votes end too.
    const player = players.get(GUILD);
    player.setRepeat('track');
    await clock.advance(180_000);
    assert.equal(title(), 'Track 2');
    assert.equal(actions.skipVotes(listener(BEN)).votes, 0);
  });

  it('counts again as people come and go: a vote enough for fewer people skips, a voter who left counts no more', async () => {
    const { clock, actions, listen, title } = await setup();
    listen(ANN, BEN, CAT, DEE, DJ.userId ?? '');
    // Five listening: three votes needed.
    actions.skip(listener(ANN));
    actions.skip(listener(BEN));
    assert.equal(title(), 'Track 1');
    // A voter leaves: one vote of four, two needed.
    listen(BEN, CAT, DEE, DJ.userId ?? '');
    await clock.advance(300);
    assert.deepEqual(actions.skipVotes(listener(BEN)), { on: true, votes: 1, needed: 2 });
    // The voter comes back and two others leave: two votes of three is enough, within a moment.
    listen(ANN, BEN, CAT);
    assert.equal(title(), 'Track 1');
    await clock.advance(300);
    assert.equal(title(), 'Track 2');
  });

  it('keeps the DJ role for Skip where votes are off or there is no DJ role, and refuses the rest of the music', async () => {
    const { store, actions, listen } = await setup();
    listen(ANN, BEN);
    const djRefusal = 'forbidden: only members with the DJ role can change the music here';
    // Every other change still needs the role.
    assert.equal(
      refusal(() => actions.pause(listener(ANN))),
      djRefusal,
    );
    assert.equal(
      refusal(() => actions.removeCurrent(listener(ANN))),
      djRefusal,
    );
    // Votes off, set by someone who manages the server (and not by anyone else).
    assert.equal(
      refusal(() => actions.voteSkip(listener(ANN), false)),
      'forbidden: only people who can manage the server can change this setting',
    );
    assert.equal(actions.voteSkip(MANAGER, false).voteSkip, false);
    assert.equal(
      refusal(() => actions.skip(listener(ANN))),
      djRefusal,
    );
    assert.equal(actions.skipVotes(listener(ANN)).on, false);
    // On again, with the DJ role cleared: everyone may change the music, and the context says so.
    actions.voteSkip(MANAGER, true);
    store.settings.setDjRole(GUILD, null);
    assert.equal(actions.voteSkipApplies(GUILD), false);
  });

  it('ends the votes under way when the DJ role or the setting changes', async () => {
    const { actions, listen, told } = await setup();
    listen(ANN, BEN, CAT);
    actions.skip(listener(ANN));
    const before = told.length;
    actions.djRole(MANAGER, DJ_ROLE);
    assert.equal(actions.skipVotes(listener(ANN)).votes, 0);
    assert.ok(told.length > before);
  });

  it('counts the host listening in a browser as a person, and refuses a vote with nothing playing', async () => {
    const { actions, players, listen } = await setup();
    listen(ANN, 'host');
    assert.deepEqual(actions.skip(listener(ANN)).votes, null);
    players.get(GUILD).stop();
    assert.equal(
      refusal(() => actions.skip(listener(ANN))),
      'conflict: nothing is playing',
    );
  });
});

describe('a skip meant for a track that has gone', () => {
  it('skips nothing more and casts no vote on the next track, for a vote and for the DJ alike', async () => {
    const { actions, listen, title, tracks } = await setup();
    listen(ANN, BEN);
    const first = tracks[0]?.id;
    // Two people listening: Ann's vote is enough, and Track 1 goes.
    assert.equal(actions.skip(listener(ANN), first).votes, null);
    assert.equal(title(), 'Track 2');
    // Ben pressed Skip on Track 1 too, a moment later: nothing more goes, and Track 2 has no vote against it.
    const late = actions.skip(listener(BEN), first);
    assert.equal(late.votes, null);
    assert.equal(late.snapshot.track?.title, 'Track 2');
    assert.equal(actions.skipVotes(listener(BEN)).votes, 0);
    // The same for a DJ pressing on a card of Track 1.
    actions.skip(DJ, first);
    assert.equal(title(), 'Track 2');
    // Without saying which, Skip is for what plays now.
    actions.skip(DJ);
    assert.equal(title(), 'Track 3');
  });
});
