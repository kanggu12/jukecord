/**
 * Autoplay: one track queued when the last one starts, from the server's plays (weighted by plays and likes, clear of
 * the newest thirty) or from YouTube's mix of the track playing (tests/fixtures/ytdlp-mix.json, the real shape with
 * made-up values); once per start, not after a person's Stop, not while a repeat is on; and a person's own tracks
 * going before autoplay's.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { type ActionContext, Actions } from '../../src/app/actions.ts';
import { Autoplay } from '../../src/app/autoplay.ts';
import { Bus } from '../../src/core/bus.ts';
import { Players } from '../../src/core/players.ts';
import { QueueService } from '../../src/core/queue.ts';
import { AUTOPLAY, type Track } from '../../src/core/types.ts';
import { createLogger } from '../../src/log.ts';
import { Resolver } from '../../src/media/resolver.ts';
import { tracksFromInfo, type YtDlp } from '../../src/media/ytdlp.ts';
import { Presenter } from '../../src/web/present.ts';
import { FakeClock, FakeMedia, flush } from '../support/fakes.ts';
import { addTracks, memoryStore } from '../support/store.ts';

const log = createLogger({ level: 'error', sinks: [] });
const GUILD = '100000000000000001';
const ALICE = '300000000000000001';
const MIX = JSON.parse(fs.readFileSync(new URL('../fixtures/ytdlp-mix.json', import.meta.url), 'utf8'));

function setup(options: { random?: () => number; mixFails?: boolean } = {}) {
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
  // A mix lister that answers from the fixture and counts how often it was asked.
  const mixes: string[] = [];
  const ytdlp = {
    mix: async (id: string, limit: number) => {
      mixes.push(id);
      if (options.mixFails) throw new Error('yt-dlp failed: HTTP Error 404');
      return tracksFromInfo(MIX, limit);
    },
  } as unknown as YtDlp;
  const slots = new Resolver({ ytdlp: {} as YtDlp, tracks: store.tracks, log });
  const autoplay = new Autoplay({
    bus,
    players,
    queue,
    store,
    slots,
    ytdlp,
    clock,
    log,
    trackMaxMs: 3 * 3_600_000,
    random: options.random ?? (() => 0),
  });
  autoplay.start();
  const actions = new Actions({ store, queue, players, resolver: {} as Resolver, log, autoplay });
  return { clock, store, queue, media, players, autoplay, actions, mixes };
}

const DJ: ActionContext = { guildId: GUILD, userId: ALICE, mayControl: true, mayManage: false };

// Records plays of tracks in the server's history, oldest first.
function played(store: ReturnType<typeof memoryStore>, tracks: readonly Track[]): void {
  for (const [index, track] of tracks.entries())
    store.history.add({ guildId: GUILD, trackId: track.id, addedBy: ALICE, playedAt: index + 1, playedMs: 60_000 });
}

// Lets autoplay look (it waits a moment after a change) and finish its pick.
async function settle(clock: FakeClock): Promise<void> {
  await clock.advance(400);
  await flush();
}

describe('autoplay from the history', () => {
  it('queues a track the server played when the last one starts, as autoplay’s', async () => {
    const { clock, store, queue, players, actions } = setup();
    const tracks = addTracks(store, 3);
    const [old, , last] = tracks;
    assert.ok(old && last);
    // Played long ago (not among the newest thirty, which this short history is all of, but the track playing and
    // the other one are left out anyway).
    played(store, [old]);
    actions.autoplay(DJ, 'history');
    queue.add(GUILD, [last.id], 'end', ALICE);
    players.get(GUILD).play();
    await settle(clock);
    const waiting = queue.list(GUILD);
    assert.equal(waiting.length, 0, 'the newest plays are left out: nothing old enough to pick');
    // A longer history: thirty-one plays, the oldest one far enough back to be picked.
    const many = addTracks(store, 31, 'h');
    played(store, many);
    // A new start of a track (the next one): one pick for it.
    queue.add(GUILD, [old.id], 'end', ALICE);
    players.get(GUILD).skip();
    await settle(clock);
    const items = queue.list(GUILD);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.addedBy, AUTOPLAY);
    // The only one clear of the newest thirty plays, the track playing and the queue: the oldest of the thirty-one.
    assert.equal(items[0]?.track.id, many[0]?.id);
  });

  it('weighs a track by its plays and its likes', () => {
    const { store, autoplay } = setup();
    const [once, often, liked] = addTracks(store, 3);
    assert.ok(once && often && liked);
    played(store, [once, often, often, often, liked]);
    store.likes.add(ALICE, liked.id);
    store.likes.add('host', liked.id);
    // Weights 1, 3 and 1 + 2 * 2 = 5 (in the history's order of tracks), out of 9: the draw falls by its place.
    const order = store.history.playCounts(GUILD).map((entry) => entry.trackId);
    const at = (fraction: number) => {
      const picker = new Autoplay({
        ...(autoplay as unknown as { options: object }).options,
        random: () => fraction,
      } as never);
      return picker.fromHistory(GUILD, new Set())?.id;
    };
    const weights = new Map([
      [once.id, 1],
      [often.id, 3],
      [liked.id, 5],
    ]);
    let edge = 0;
    for (const id of order) {
      const weight = weights.get(id) ?? 0;
      // Just inside the track's share of the nine.
      assert.equal(at((edge + weight - 0.5) / 9), id);
      edge += weight;
    }
  });

  it('picks nothing while a repeat is on, nor when it is off', async () => {
    const { clock, store, queue, players, actions } = setup();
    const tracks = addTracks(store, 40);
    played(store, tracks.slice(0, 39));
    actions.repeat(DJ, 'queue');
    actions.autoplay(DJ, 'history');
    queue.add(GUILD, [tracks[39]?.id ?? 0], 'end', ALICE);
    players.get(GUILD).play();
    await settle(clock);
    assert.equal(queue.size(GUILD), 0);
    actions.repeat(DJ, 'off');
    actions.autoplay(DJ, 'off');
    await settle(clock);
    assert.equal(queue.size(GUILD), 0);
    // Turned on while the last track plays: it picks now.
    actions.autoplay(DJ, 'history');
    await settle(clock);
    assert.equal(queue.size(GUILD), 1);
  });

  it('picks once per start: a pick a person removed is not put back', async () => {
    const { clock, store, queue, players, actions } = setup();
    const tracks = addTracks(store, 40);
    played(store, tracks.slice(0, 39));
    actions.autoplay(DJ, 'history');
    queue.add(GUILD, [tracks[39]?.id ?? 0], 'end', ALICE);
    players.get(GUILD).play();
    await settle(clock);
    const [pick] = queue.list(GUILD);
    assert.ok(pick);
    actions.remove(DJ, pick.id);
    await settle(clock);
    assert.equal(queue.size(GUILD), 0);
  });

  it('stops with a person’s Stop until a track starts again, and plays on after an end by itself', async () => {
    const { clock, store, queue, players, actions, media } = setup();
    const tracks = addTracks(store, 40);
    played(store, tracks.slice(0, 38));
    actions.autoplay(DJ, 'history');
    queue.add(GUILD, [tracks[38]?.id ?? 0], 'end', ALICE);
    const player = players.get(GUILD);
    player.play();
    // Stopped before autoplay looked: nothing is queued.
    actions.stop(DJ);
    await settle(clock);
    assert.equal(queue.size(GUILD), 0);
    // A track starts again: autoplay picks for it.
    queue.add(GUILD, [tracks[39]?.id ?? 0], 'end', ALICE);
    player.play();
    await settle(clock);
    assert.equal(queue.size(GUILD), 1);
    // The track plays to its end by itself: the pick plays next, and autoplay picks again for it.
    media.finish(180_000);
    await flush();
    await clock.advance(180_000);
    assert.equal(player.snapshot().track?.id === tracks[39]?.id, false);
    assert.equal(player.snapshot().addedBy, AUTOPLAY);
  });
});

describe('autoplay from YouTube’s mix', () => {
  // The seed of the fixture's mix, as a track this server plays.
  const seed = {
    source: 'https://www.youtube.com/watch?v=mixx0000001',
    url: 'https://www.youtube.com/watch?v=mixx0000001',
    title: 'Morning Light (Official Audio)',
    uploader: 'Example Band',
    durationMs: 181_000,
    thumbnail: null,
  };

  it('queues the first track of the mix that did not play lately, and asks for a mix once', async () => {
    const { clock, store, queue, players, actions, mixes } = setup();
    const current = store.tracks.upsert(seed);
    // The mix's second track played lately: the third is picked.
    const second = store.tracks.upsert(tracksFromInfo(MIX, 2)[1] ?? seed);
    played(store, [second]);
    actions.autoplay(DJ, 'related');
    queue.add(GUILD, [current.id], 'end', ALICE);
    players.get(GUILD).play();
    await settle(clock);
    const [pick] = queue.list(GUILD);
    assert.equal(pick?.addedBy, AUTOPLAY);
    assert.equal(pick?.track.source, 'https://www.youtube.com/watch?v=mixx0000003');
    assert.deepEqual(mixes, ['mixx0000001']);
    // The same track again later: the mix is known.
    queue.clear(GUILD);
    players.get(GUILD).stop();
    queue.add(GUILD, [current.id], 'end', ALICE);
    players.get(GUILD).play();
    await settle(clock);
    assert.deepEqual(mixes, ['mixx0000001']);
  });

  it('picks from the history for a track not on YouTube, or when the mix fails', async () => {
    for (const mixFails of [false, true]) {
      const { clock, store, queue, players, actions } = setup({ mixFails });
      const tracks = addTracks(store, 40);
      played(store, tracks.slice(0, 39));
      const playing = mixFails ? store.tracks.upsert(seed) : (tracks[39] as Track);
      actions.autoplay(DJ, 'related');
      queue.add(GUILD, [playing.id], 'end', ALICE);
      players.get(GUILD).play();
      await settle(clock);
      const [pick] = queue.list(GUILD);
      assert.equal(pick?.addedBy, AUTOPLAY, `mix fails: ${mixFails}`);
      assert.ok(tracks.some((track) => track.id === pick?.track.id));
    }
  });
});

describe('a person’s tracks and autoplay’s', () => {
  it('go before autoplay’s at the end, which say "Autoplay" for who added them', async () => {
    const { store, queue, actions } = setup();
    const [mine, picked, next, playing] = addTracks(store, 4);
    assert.ok(mine && picked && next && playing);
    // Something plays, so the adds below wait in the queue.
    queue.add(GUILD, [playing.id], 'end', ALICE);
    (actions as unknown as { options: { players: Players } }).options.players.get(GUILD).play();
    queue.add(GUILD, [picked.id], 'end', AUTOPLAY);
    // The resolver of these actions knows the example addresses.
    const resolving = new Actions({
      store,
      queue,
      players: (actions as unknown as { options: { players: Players } }).options.players,
      resolver: { resolve: async (input: string) => [input === 'mine' ? mine : next] } as unknown as Resolver,
      log,
    });
    await resolving.add(DJ, 'mine');
    await resolving.add(DJ, 'next', 'next');
    assert.deepEqual(
      queue.list(GUILD).map((item) => [item.track.id, item.addedBy]),
      [
        [next.id, ALICE],
        [mine.id, ALICE],
        [picked.id, AUTOPLAY],
      ],
    );
    const shown = new Presenter(store.users).items(queue.list(GUILD));
    assert.equal(shown[2]?.addedByName, 'Autoplay');
  });

  it('keeps the mode across a restart, with the rest of the player', () => {
    const { store, actions } = setup();
    actions.autoplay(DJ, 'related');
    const clock = new FakeClock();
    const bus = new Bus();
    const again = new Players({
      queue: new QueueService(store.queue, bus),
      media: new FakeMedia(),
      history: store.history,
      state: store.playerState,
      bus,
      clock,
      log,
      fetchTimeoutMs: 60_000,
    });
    again.restoreAll(store.tracks, store.playerState);
    assert.equal(again.get(GUILD).snapshot().autoplay, 'related');
  });
});
