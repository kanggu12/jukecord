import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type ActionContext, ActionError, Actions, type VoiceControl } from '../../src/app/actions.ts';
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
const DJ: ActionContext = { guildId: GUILD, userId: '300000000000000001', mayControl: true, mayManage: false };
const LISTENER: ActionContext = { guildId: GUILD, userId: '300000000000000002', mayControl: false, mayManage: false };

// Actions over a real queue and players, with a resolver that answers from a fixed table.
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
  const tracks = await addTracks(store, 4);
  const table = new Map<string, Track[]>([
    ['one', tracks.slice(0, 1)],
    ['two', tracks.slice(1, 2)],
    ['list', tracks.slice(2, 4)],
  ]);
  const resolver = {
    resolve: async (input: string) => {
      const found = table.get(input);
      if (!found) throw new Error('nothing was found');
      return found;
    },
  } as unknown as Resolver;
  const actions = new Actions({ lanes, store, queue, players, resolver, log });
  return { clock, store, queue, media, players, actions, tracks };
}

// The error code an action throws.
async function code(fn: () => unknown): Promise<string> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ActionError) return error.code;
    throw error;
  }
  return 'none';
}

describe('Actions', () => {
  it('adds and starts playing when idle; a playlist adds all of its tracks', async () => {
    const { actions, media, queue } = await setup();
    const {
      items: [item],
    } = await actions.add(DJ, 'one');
    assert.equal(item?.addedBy, DJ.userId);
    // The first track became current at once and left the queue.
    assert.equal(media.last().track.title, 'Track 1');
    await actions.add(DJ, 'list');
    assert.deepEqual(
      (await queue.list(GUILD)).map((entry) => entry.track.title),
      ['Track 3', 'Track 4'],
    );
  });

  it('plays now by putting the track first and skipping the current one', async () => {
    const { actions, media } = await setup();
    await actions.add(DJ, 'one');
    media.finish(180_000);
    await flush();
    await actions.playNow(DJ, 'two');
    assert.equal(actions.nowPlaying(DJ).track?.title, 'Track 2');
  });

  it('turns lookup failures and impossible requests into codes the ways in can show', async () => {
    const { actions } = await setup();
    assert.equal(await code(() => actions.add(DJ, 'missing')), 'not-found');
    assert.equal(await code(() => actions.skip(DJ)), 'conflict');
    assert.equal(await code(() => actions.seek(DJ, -1)), 'invalid');
    assert.equal(await code(() => actions.remove(DJ, 999)), 'not-found');
    assert.equal(await code(() => actions.playlistLoad(DJ, 'nope')), 'not-found');
    // Without a bot, voice is unavailable rather than broken.
    assert.equal(await code(() => actions.join(DJ, null)), 'unavailable');
  });

  it('lets everyone look but only people allowed to change the music change it', async () => {
    const { actions } = await setup();
    assert.equal(await code(() => actions.add(LISTENER, 'one')), 'forbidden');
    assert.equal(await code(() => actions.clear(LISTENER)), 'forbidden');
    assert.deepEqual((await actions.queue(LISTENER)).items, []);
    assert.equal(actions.nowPlaying(LISTENER).status, 'idle');
  });

  it('saves the current track with the queue and loads it back', async () => {
    const { actions, media, queue } = await setup();
    await actions.add(DJ, 'one');
    await actions.add(DJ, 'list');
    media.finish(180_000);
    await flush();
    const saved = await actions.playlistSave(DJ, 'Friday');
    assert.equal(saved.size, 3);
    await actions.clear(DJ);
    await actions.playlistLoad(DJ, 'Friday');
    assert.deepEqual(
      (await queue.list(GUILD)).map((item) => item.track.title),
      ['Track 1', 'Track 3', 'Track 4'],
    );
    assert.equal(await code(() => actions.playlistRename(DJ, 'Friday', 'Friday')), 'none');
    await actions.playlistDelete(DJ, 'Friday');
    assert.deepEqual(await actions.playlists(DJ), []);
  });

  it('joins and leaves through the voice control once the bot provides one', async () => {
    const { actions } = await setup();
    const calls: string[] = [];
    const voice: VoiceControl = {
      join: async (_guild, channel) => {
        calls.push(`join ${channel}`);
        return { channelId: channel ?? '400000000000000001', name: 'Lounge' };
      },
      leave: () => {
        calls.push('leave');
        return true;
      },
      channel: () => null,
      channels: () => [{ id: '400000000000000001', name: 'Lounge', people: 2 }],
    };
    actions.setVoice(voice, () => true);
    assert.equal((await actions.join(DJ, null)).name, 'Lounge');
    await actions.leave(DJ);
    assert.deepEqual(calls, ['join null', 'leave']);
    assert.equal(actions.status().discord, true);
  });
});

describe('Actions resume', () => {
  it('continues a paused track, starts the queue after a stop, and says why when it cannot', async () => {
    const { actions } = await setup();
    await assert.rejects(async () => actions.resume(DJ), /the queue is empty/);
    await actions.add(DJ, 'list');
    await actions.stop(DJ);
    assert.equal(actions.nowPlaying(DJ).status, 'idle');
    // After a stop the play key starts the queue again.
    assert.equal((await actions.resume(DJ)).status, 'loading');
    // While it gets ready it is on its way to playing, which is what is said (it is not playing yet).
    await assert.rejects(() => actions.resume(DJ), /^ActionError: the track is getting ready$/);
  });

  it('says a paused track is already paused, not that nothing is playing', async () => {
    const { actions, media } = await setup();
    await actions.add(DJ, 'one');
    media.finish(180_000);
    await flush();
    await actions.pause(DJ);
    // A second press of Pause (/pause twice, two people at once, an old card's key).
    await assert.rejects(() => actions.pause(DJ), /^ActionError: it is already paused$/);
    await actions.resume(DJ);
    await assert.rejects(() => actions.resume(DJ), /^ActionError: it is already playing$/);
    // Paused while it loads: it starts paused, which a second pause also says.
    await actions.add(DJ, 'two');
    await actions.skip(DJ);
    await actions.pause(DJ);
    await assert.rejects(() => actions.pause(DJ), /^ActionError: it is already paused$/);
    // And with nothing at all, nothing is playing.
    await actions.stop(DJ);
    await assert.rejects(() => actions.pause(DJ), /^ActionError: nothing is playing$/);
  });
});
