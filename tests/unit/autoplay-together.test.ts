/**
 * Autoplay beside the other ways a server shares its music: its tracks are nobody's turn when people take turns (they
 * stay after people's), the limit of tracks per person does not count them, Wrapped leaves them out of who added
 * most, a stop asked for after this track is a person's Stop for it, and it adds nothing while the player is paused
 * (by a person, or resting with nobody listening) until the music goes on.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type ActionContext, Actions } from '../../src/app/actions.ts';
import { Autoplay } from '../../src/app/autoplay.ts';
import { Bus } from '../../src/core/bus.ts';
import { Players } from '../../src/core/players.ts';
import { QueueService } from '../../src/core/queue.ts';
import { AUTOPLAY, type NewTrack, type Track } from '../../src/core/types.ts';
import { createLogger } from '../../src/log.ts';
import type { Resolver } from '../../src/media/resolver.ts';
import type { YtDlp } from '../../src/media/ytdlp.ts';
import { FakeClock, FakeMedia, flush } from '../support/fakes.ts';
import { addTracks, memoryStore } from '../support/store.ts';

const log = createLogger({ level: 'error', sinks: [] });
const GUILD = '100000000000000001';
const person = (userId: string): ActionContext => ({ guildId: GUILD, userId, mayControl: true, mayManage: false });
const [ANN, BEN] = [person('300000000000000001'), person('300000000000000002')];
const MANAGER: ActionContext = { guildId: GUILD, userId: '300000000000000009', mayControl: true, mayManage: true };
// A song's length: long enough that nothing ends while a test looks.
const SONG = 180_000;

// Actions and autoplay over a real queue and players; "t1" ... finds one stored track each. YouTube's mix of a track
// comes when a test answers it (`mixes` holds the answers waited for).
function setup() {
  const clock = new FakeClock();
  const store = memoryStore(() => clock.now());
  const bus = new Bus();
  const queue = new QueueService(store.queue, bus);
  const media = new FakeMedia();
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
  const tracks = addTracks(store, 40);
  const resolver = {
    resolve: async (input: string): Promise<Track[]> => [tracks[Number(input.slice(1)) - 1] as Track],
    run: async <T>(_who: string | null, _server: string | null, work: () => Promise<T>) => work(),
  } as unknown as Resolver;
  const mixes: ((tracks: NewTrack[]) => void)[] = [];
  const ytdlp = {
    mix: () => new Promise<NewTrack[]>((resolve) => mixes.push(resolve)),
  } as unknown as YtDlp;
  const autoplay = new Autoplay({
    bus,
    players,
    queue,
    store,
    slots: resolver,
    ytdlp,
    clock,
    log,
    trackMaxMs: 3 * 3_600_000,
    random: () => 0,
  });
  autoplay.start();
  const actions = new Actions({ store, queue, players, resolver, log, autoplay });
  // Thirty-one plays long ago, so the history has a track clear of the newest thirty to pick.
  for (const [index, track] of tracks.slice(5, 36).entries())
    store.history.add({
      guildId: GUILD,
      trackId: track.id,
      addedBy: ANN.userId,
      playedAt: index + 1,
      playedMs: 60_000,
    });
  // Who added each queued track, in order: a, b, h (the host) or A (autoplay).
  const owners = () =>
    queue
      .list(GUILD)
      .map((item) =>
        item.addedBy === AUTOPLAY ? 'A' : item.addedBy === ANN.userId ? 'a' : item.addedBy === BEN.userId ? 'b' : 'h',
      )
      .join('');
  return { clock, store, queue, media, players, autoplay, actions, tracks, owners, mixes };
}

// A track on YouTube (made up, as the fixtures are), whose mix autoplay asks for in "related" mode, and a track of it.
const SEED = {
  source: 'https://www.youtube.com/watch?v=mixx0000001',
  url: 'https://www.youtube.com/watch?v=mixx0000001',
  title: 'Morning Light (Official Audio)',
  uploader: 'Example Band',
  durationMs: SONG,
  thumbnail: null,
};
const RELATED: NewTrack = { ...SEED, source: 'https://www.youtube.com/watch?v=mixx0000002', title: 'Paper Boats' };

// Lets autoplay look (it waits a moment after a change) and finish its pick.
async function settle(clock: FakeClock): Promise<void> {
  await clock.advance(400);
  await flush();
}

describe('autoplay with taking turns and the limit per person', () => {
  it("keeps autoplay's tracks after people's when people take turns, and takes turns without them", async () => {
    const { store, queue, actions, tracks, owners } = setup();
    actions.takeTurns(MANAGER, true);
    // Ann's track plays; autoplay has queued two (as when the queue ran out twice); then people add.
    await actions.add(ANN, 't1');
    const [one, two] = tracks;
    assert.ok(one && two);
    queue.add(GUILD, [tracks[2]?.id ?? 0, tracks[3]?.id ?? 0], 'end', AUTOPLAY);
    assert.equal(owners(), 'AA');
    await actions.add(ANN, 't5');
    await actions.add(BEN, 't6');
    await actions.add(ANN, 't7');
    // Ben's first turn before Ann's second; both before autoplay's, which nobody's turn moves.
    assert.equal(owners(), 'baaAA');
    // Put in turns once: the people's tracks in turns, autoplay's after them.
    queue.add(GUILD, [tracks[7]?.id ?? 0], 'next', AUTOPLAY);
    assert.equal(owners(), 'AbaaAA');
    assert.equal(actions.turnsNow(BEN), 4);
    assert.equal(owners(), 'baaAAA');
    store.close();
  });

  it("leaves an autoplay track people moved among theirs where it is, people's new tracks in turn around it", async () => {
    const { queue, actions, tracks, owners } = setup();
    actions.takeTurns(MANAGER, true);
    await actions.add(ANN, 't1');
    await actions.add(ANN, 't2');
    await actions.add(BEN, 't3');
    // Someone moved a track autoplay queued up between people's.
    queue.add(GUILD, [tracks[9]?.id ?? 0], 1, AUTOPLAY);
    assert.equal(owners(), 'bAa');
    // Ben's second turn goes after Ann's second (the second round), the autoplay track keeping its place.
    await actions.add(BEN, 't4');
    assert.equal(owners(), 'bAab');
  });

  it("does not count autoplay's tracks against anyone's limit", async () => {
    const { queue, actions, tracks, owners } = setup();
    actions.personLimit(MANAGER, 1);
    // Ben's track plays; autoplay's three wait.
    await actions.add(BEN, 't2');
    queue.add(GUILD, [tracks[2]?.id ?? 0, tracks[3]?.id ?? 0, tracks[4]?.id ?? 0], 'end', AUTOPLAY);
    // Ann's one track fits (autoplay's three are nobody's) and goes before them; her second is over her limit.
    const first = await actions.add(ANN, 't1');
    assert.equal(first.skippedLimit, 0);
    assert.equal(owners(), 'aAAA');
    await assert.rejects(actions.add(ANN, 't6'), /each person may have 1 tracks in the queue here/);
  });
});

describe('autoplay with stop after this track and a paused player', () => {
  it('takes a stop asked for after this track as a Stop: a pick that comes after it neither queues nor plays', async () => {
    const { clock, store, queue, media, players, actions, owners, mixes } = setup();
    actions.autoplay(ANN, 'related');
    queue.add(GUILD, [store.tracks.upsert(SEED).id], 'end', ANN.userId);
    players.get(GUILD).play();
    media.finish(SONG);
    await settle(clock);
    // The last track plays, and autoplay waits for YouTube's mix of it; meanwhile the track is to stop after it.
    assert.equal(mixes.length, 1);
    actions.stopAfter(ANN, true);
    await clock.advance(SONG);
    await settle(clock);
    assert.equal(players.get(GUILD).snapshot().status, 'idle');
    // The mix comes after the stop: nothing is queued, and the music stays stopped.
    mixes[0]?.([RELATED]);
    await settle(clock);
    assert.equal(owners(), '');
    assert.equal(players.get(GUILD).snapshot().status, 'idle');
  });

  it('picks nothing while a stop is asked for after this track', async () => {
    const { clock, media, actions, owners } = setup();
    await actions.add(ANN, 't1');
    media.finish(SONG);
    await flush();
    actions.stopAfter(ANN, true);
    actions.autoplay(ANN, 'history');
    await settle(clock);
    assert.equal(owners(), '');
    // Played on after all: the pick comes.
    actions.stopAfter(ANN, false);
    await settle(clock);
    assert.equal(owners(), 'A');
  });

  it('adds nothing while the player is paused (resting with nobody listening), and picks when it plays on', async () => {
    const { clock, media, players, actions, owners } = setup();
    await actions.add(ANN, 't1');
    media.finish(SONG);
    await flush();
    // Paused (as app/rest.ts pauses a server nobody hears), then autoplay turned on: nothing is queued meanwhile.
    players.get(GUILD).pause();
    actions.autoplay(ANN, 'history');
    await settle(clock);
    assert.equal(owners(), '');
    // Played on: the pick for this track comes now.
    players.get(GUILD).resume();
    await settle(clock);
    assert.equal(owners(), 'A');
  });

  it('queues no pick that comes back to a paused player, and picks again when it plays on', async () => {
    const { clock, store, queue, media, players, actions, owners, mixes } = setup();
    actions.autoplay(ANN, 'related');
    queue.add(GUILD, [store.tracks.upsert(SEED).id], 'end', ANN.userId);
    players.get(GUILD).play();
    media.finish(SONG);
    await settle(clock);
    assert.equal(mixes.length, 1);
    // Paused (by a person, or resting with nobody listening) while the mix was asked for: it comes, and waits.
    players.get(GUILD).pause();
    mixes[0]?.([RELATED]);
    await settle(clock);
    assert.equal(owners(), '');
    // Played on: the pick is made again (the mix is known now), and queued.
    players.get(GUILD).resume();
    await settle(clock);
    assert.equal(owners(), 'A');
    assert.equal(mixes.length, 1);
  });
});
