import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type ActionContext, ActionError, Actions, type VoiceControl } from '../../src/app/actions.ts';
import { Bus } from '../../src/core/bus.ts';
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
function setup() {
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
  const tracks = addTracks(store, 4);
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
  const actions = new Actions({ store, queue, players, resolver, log });
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
    const { actions, media, queue } = setup();
    const {
      items: [item],
    } = await actions.add(DJ, 'one');
    assert.equal(item?.addedBy, DJ.userId);
    // The first track became current at once and left the queue.
    assert.equal(media.last().track.title, 'Track 1');
    await actions.add(DJ, 'list');
    assert.deepEqual(
      queue.list(GUILD).map((entry) => entry.track.title),
      ['Track 3', 'Track 4'],
    );
  });

  it('plays now by putting the track first and skipping the current one', async () => {
    const { actions, media } = setup();
    await actions.add(DJ, 'one');
    media.finish(180_000);
    await flush();
    await actions.playNow(DJ, 'two');
    assert.equal(actions.nowPlaying(DJ).track?.title, 'Track 2');
  });

  it('turns lookup failures and impossible requests into codes the ways in can show', async () => {
    const { actions } = setup();
    assert.equal(await code(() => actions.add(DJ, 'missing')), 'not-found');
    assert.equal(await code(() => actions.skip(DJ)), 'conflict');
    assert.equal(await code(() => actions.seek(DJ, -1)), 'invalid');
    assert.equal(await code(() => actions.remove(DJ, 999)), 'not-found');
    assert.equal(await code(() => actions.playlistLoad(DJ, 'nope')), 'not-found');
    // Without a bot, voice is unavailable rather than broken.
    assert.equal(await code(() => actions.join(DJ, null)), 'unavailable');
  });

  it('lets everyone look but only people allowed to change the music change it', async () => {
    const { actions } = setup();
    assert.equal(await code(() => actions.add(LISTENER, 'one')), 'forbidden');
    assert.equal(await code(() => actions.clear(LISTENER)), 'forbidden');
    assert.deepEqual(actions.queue(LISTENER).items, []);
    assert.equal(actions.nowPlaying(LISTENER).status, 'idle');
  });

  it('saves the current track with the queue and loads it back', async () => {
    const { actions, media, queue } = setup();
    await actions.add(DJ, 'one');
    await actions.add(DJ, 'list');
    media.finish(180_000);
    await flush();
    const saved = actions.playlistSave(DJ, 'Friday');
    assert.equal(saved.size, 3);
    actions.clear(DJ);
    actions.playlistLoad(DJ, 'Friday');
    assert.deepEqual(
      queue.list(GUILD).map((item) => item.track.title),
      ['Track 1', 'Track 3', 'Track 4'],
    );
    assert.equal(await code(() => actions.playlistRename(DJ, 'Friday', 'Friday')), 'none');
    actions.playlistDelete(DJ, 'Friday');
    assert.deepEqual(actions.playlists(DJ), []);
  });

  it('joins and leaves through the voice control once the bot provides one', async () => {
    const { actions } = setup();
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
    actions.leave(DJ);
    assert.deepEqual(calls, ['join null', 'leave']);
    assert.equal(actions.status().discord, true);
  });
});

describe('Actions resume', () => {
  it('continues a paused track, starts the queue after a stop, and says why when it cannot', async () => {
    const { actions } = setup();
    await assert.rejects(async () => actions.resume(DJ), /the queue is empty/);
    await actions.add(DJ, 'list');
    actions.stop(DJ);
    assert.equal(actions.nowPlaying(DJ).status, 'idle');
    // After a stop the play key starts the queue again.
    assert.equal(actions.resume(DJ).status, 'loading');
    assert.throws(() => actions.resume(DJ), /already playing/);
  });
});
