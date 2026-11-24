/**
 * Votes to skip: who may vote, how many it takes, when the votes end, and the count made again as people come and go.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type ActionContext, ActionError, Actions, type Directory } from '../../src/app/actions.ts';
import { NOT_LISTENING, SkipVotes } from '../../src/app/votes.ts';
import { Bus } from '../../src/core/bus.ts';
import { GuildLanes } from '../../src/core/lanes.ts';
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
  const store = await memoryStore(() => clock.now());
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
  const tracks = await addTracks(store, 3);
  const resolver = { resolve: async () => tracks } as unknown as Resolver;
  // Who listens: the test changes it, and says so on the bus as the voice side and the live updates do.
  const people = new Set<string>();
  const votes = new SkipVotes({
    lanes,
    players,
    bus,
    clock,
    log,
    applies: (guildId) => actions.voteSkipApplies(guildId),
    listening: () => new Set(people),
  });
  const actions = new Actions({ lanes, store, queue, players, resolver, log, votes });
  // Discord's side: the server has the DJ role among its roles.
  const directory = { roles: () => [{ id: DJ_ROLE, name: 'DJ', color: 0 }] } as unknown as Directory;
  actions.setVoice(null, () => true, directory);
  await store.settings.setDjRole(GUILD, DJ_ROLE);
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
async function refusal(fn: () => unknown): Promise<string> {
  try {
    // A refusal is the action's rejection (or a throw before it answers).
    await fn();
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
    const first = await actions.skip(listener(ANN));
    assert.deepEqual(first.votes, { votes: 1, needed: 2 });
    assert.equal(title(), 'Track 1');
    // Voting again changes nothing; the panels heard the count.
    assert.deepEqual((await actions.skip(listener(ANN))).votes, { votes: 1, needed: 2 });
    assert.deepEqual(await actions.skipVotes(listener(CAT)), { on: true, votes: 1, needed: 2, voted: false });
    // The voter's own view says they voted; the live updates mark their panels alone.
    assert.equal((await actions.skipVotes(listener(ANN))).voted, true);
    assert.deepEqual([...(await actions.skipVoters(GUILD))], [ANN]);
    assert.ok(told.length >= 1);
    const second = await actions.skip(listener(BEN));
    assert.equal(second.votes, null);
    assert.equal(title(), 'Track 2');
    // A new track starts with no votes, and nobody has voted on it.
    assert.deepEqual(await actions.skipVotes(listener(CAT)), { on: true, votes: 0, needed: 2, voted: false });
    assert.equal((await actions.skipVotes(listener(ANN))).voted, false);
    assert.equal((await actions.skipVoters(GUILD)).size, 0);
  });

  it('takes the one vote of someone listening alone, and refuses one from someone not listening', async () => {
    const { actions, listen, title } = await setup();
    listen(ANN);
    assert.equal(await refusal(() => actions.skip(listener(BEN))), `forbidden: ${NOT_LISTENING}`);
    assert.equal((await actions.skip(listener(ANN))).votes, null);
    assert.equal(title(), 'Track 2');
  });

  it('ends the votes with the play: the next track, and the same one again by repeat, start from none', async () => {
    const { clock, media, actions, players, listen, title } = await setup();
    listen(ANN, BEN, CAT, DEE);
    await actions.skip(listener(ANN));
    // The DJ skips: the vote was about a play that is over.
    await actions.skip(DJ);
    media.finish(180_000);
    await flush();
    assert.equal(title(), 'Track 2');
    assert.equal((await actions.skipVotes(listener(BEN))).votes, 0);
    assert.deepEqual((await actions.skip(listener(BEN))).votes, { votes: 1, needed: 2 });
    // Track 2 plays again from the top by repeat: its votes end too.
    const player = players.get(GUILD);
    await player.setRepeat('track');
    await clock.advance(180_000);
    assert.equal(title(), 'Track 2');
    assert.equal((await actions.skipVotes(listener(BEN))).votes, 0);
  });

  it('counts again as people come and go: a vote enough for fewer people skips, a voter who left counts no more', async () => {
    const { clock, actions, listen, title } = await setup();
    listen(ANN, BEN, CAT, DEE, DJ.userId ?? '');
    // Five listening: three votes needed.
    await actions.skip(listener(ANN));
    await actions.skip(listener(BEN));
    assert.equal(title(), 'Track 1');
    // A voter leaves: one vote of four, two needed. Their vote counts no more, so it is not theirs to see either.
    listen(BEN, CAT, DEE, DJ.userId ?? '');
    await clock.advance(300);
    assert.deepEqual(await actions.skipVotes(listener(BEN)), { on: true, votes: 1, needed: 2, voted: true });
    assert.equal((await actions.skipVotes(listener(ANN))).voted, false);
    assert.deepEqual([...(await actions.skipVoters(GUILD))], [BEN]);
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
    assert.equal(await refusal(() => actions.pause(listener(ANN))), djRefusal);
    assert.equal(await refusal(() => actions.removeCurrent(listener(ANN))), djRefusal);
    // Votes off, set by someone who manages the server (and not by anyone else).
    assert.equal(
      await refusal(() => actions.voteSkip(listener(ANN), false)),
      'forbidden: only people who can manage the server can change this setting',
    );
    assert.equal((await actions.voteSkip(MANAGER, false)).voteSkip, false);
    assert.equal(await refusal(() => actions.skip(listener(ANN))), djRefusal);
    assert.equal((await actions.skipVotes(listener(ANN))).on, false);
    // On again, with the DJ role cleared: everyone may change the music, and the context says so.
    await actions.voteSkip(MANAGER, true);
    await store.settings.setDjRole(GUILD, null);
    assert.equal(await actions.voteSkipApplies(GUILD), false);
  });

  it('ends the votes under way when the DJ role or the setting changes', async () => {
    const { actions, listen, told } = await setup();
    listen(ANN, BEN, CAT);
    await actions.skip(listener(ANN));
    const before = told.length;
    await actions.djRole(MANAGER, DJ_ROLE);
    assert.equal((await actions.skipVotes(listener(ANN))).votes, 0);
    assert.ok(told.length > before);
  });

  it('counts the host listening in a browser as a person, and refuses a vote with nothing playing', async () => {
    const { actions, players, listen } = await setup();
    listen(ANN, 'host');
    assert.deepEqual((await actions.skip(listener(ANN))).votes, null);
    await players.get(GUILD).stop();
    assert.equal(await refusal(() => actions.skip(listener(ANN))), 'conflict: nothing is playing');
  });
});

describe('a skip meant for a track that has gone', () => {
  it('skips nothing more and casts no vote on the next track, for a vote and for the DJ alike', async () => {
    const { actions, listen, title, tracks } = await setup();
    listen(ANN, BEN);
    const first = tracks[0]?.id;
    // Two people listening: Ann's vote is enough, and Track 1 goes.
    assert.equal((await actions.skip(listener(ANN), first)).votes, null);
    assert.equal(title(), 'Track 2');
    // Ben pressed Skip on Track 1 too, a moment later: nothing more goes, and Track 2 has no vote against it.
    const late = await actions.skip(listener(BEN), first);
    assert.equal(late.votes, null);
    assert.equal(late.snapshot.track?.title, 'Track 2');
    assert.equal((await actions.skipVotes(listener(BEN))).votes, 0);
    // The same for a DJ pressing on a card of Track 1.
    await actions.skip(DJ, first);
    assert.equal(title(), 'Track 2');
    // Without saying which, Skip is for what plays now.
    await actions.skip(DJ);
    assert.equal(title(), 'Track 3');
  });
});
