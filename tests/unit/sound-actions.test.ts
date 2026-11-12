/**
 * The voice channel's sound through the actions and the voice side: who may change it, what is refused, and that a
 * change starts the voice stream again once, spaced out when changes come close together.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type ActionContext, ActionError, Actions, type VoiceControl } from '../../src/app/actions.ts';
import { Bus } from '../../src/core/bus.ts';
import { Players } from '../../src/core/players.ts';
import { QueueService } from '../../src/core/queue.ts';
import type { Sound } from '../../src/core/sound.ts';
import { VoiceManager } from '../../src/discord/voice.ts';
import { createLogger } from '../../src/log.ts';
import type { Resolver } from '../../src/media/resolver.ts';
import { FakeClock, FakeMedia } from '../support/fakes.ts';
import { memoryStore } from '../support/store.ts';

const GUILD = '100000000000000001';
const DJ: ActionContext = { guildId: GUILD, userId: '300000000000000001', mayControl: true, mayManage: false };
const LISTENER: ActionContext = { guildId: GUILD, userId: '300000000000000002', mayControl: false, mayManage: false };

// Actions with a voice side that counts how often it was told the sound changed, and a count of the panels' messages.
function setup() {
  const clock = new FakeClock();
  const store = memoryStore(() => clock.now());
  const bus = new Bus();
  const queue = new QueueService(store.queue, bus);
  const log = createLogger({ level: 'error', sinks: [] });
  const players = new Players({
    queue,
    media: new FakeMedia(),
    history: store.history,
    state: store.playerState,
    bus,
    clock,
    log,
    fetchTimeoutMs: 60_000,
  });
  const actions = new Actions({ store, queue, players, resolver: {} as Resolver, log, bus });
  const changed: string[] = [];
  actions.setVoice({ soundChanged: (guildId: string) => changed.push(guildId) } as unknown as VoiceControl, () => true);
  const told: string[] = [];
  bus.on('sound', ({ guildId }) => told.push(guildId));
  return { actions, changed, told };
}

// The code and message of an action's refusal.
function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ActionError) return `${error.code}: ${error.message}`;
    throw error;
  }
  return 'none';
}

describe('the voice sound through the actions', () => {
  it('sets the volume and the preset, tells the voice and the panels once per change, and nothing for the same', () => {
    const { actions, changed, told } = setup();
    assert.deepEqual(actions.volume(DJ, 150), { volume: 150, preset: 'off' });
    assert.deepEqual(actions.sound(DJ, 'night'), { volume: 150, preset: 'night' });
    // The same again: nothing starts again, and the panels hear nothing new.
    actions.sound(DJ, 'night');
    assert.deepEqual(changed, [GUILD, GUILD]);
    assert.deepEqual(told, [GUILD, GUILD]);
    assert.deepEqual(actions.currentSound(GUILD), { volume: 150, preset: 'night' });
    assert.equal(actions.settings(DJ).volume, 150);
  });

  it('refuses what is not a volume or a preset, and anyone who may not change the music', () => {
    const { actions } = setup();
    assert.equal(
      refusal(() => actions.volume(DJ, 201)),
      'invalid: the volume is 0 to 200 percent',
    );
    assert.equal(
      refusal(() => actions.volume(DJ, 12.5)),
      'invalid: the volume is 0 to 200 percent',
    );
    assert.equal(
      refusal(() => actions.sound(DJ, 'nightcore')),
      'invalid: the sound is one of off, bass, voices, bright, night',
    );
    assert.match(
      refusal(() => actions.volume(LISTENER, 50)),
      /^forbidden: only members with the DJ role/,
    );
    assert.match(
      refusal(() => actions.sound(LISTENER, 'bass')),
      /^forbidden: only members with the DJ role/,
    );
  });
});

describe('the voice side and a change of sound', () => {
  it('starts the stream again at once, merges the changes of the next 400 ms into one, and skips a stream up to date', async () => {
    const clock = new FakeClock();
    // The server's sound, which each test step sets, and the sound of the stream playing, which a restart takes up.
    let sound: Sound = { volume: 100, preset: 'off' };
    let streaming: Sound | null = { volume: 100, preset: 'off' };
    let restarts = 0;
    const voice = new VoiceManager({
      client: { guilds: { cache: new Map() } } as never,
      players: {
        get: () => ({
          restartOutputs: () => {
            restarts += 1;
            streaming = sound;
          },
          detach: () => {},
        }),
      } as never,
      ffmpeg: {} as never,
      log: createLogger({ level: 'error', sinks: [] }),
      idleMs: 0,
      clock,
      sound: () => sound,
    });
    const change = (next: Sound) => {
      sound = next;
      voice.soundChanged('G');
    };
    // Not in voice: nothing to start again.
    change({ volume: 90, preset: 'off' });
    assert.equal(restarts, 0);
    // In voice, as a join leaves it, its stream playing.
    (voice as unknown as { joined: Map<string, unknown> }).joined.set('G', {
      connection: { state: { status: 'ready' }, destroy: () => {} },
      output: { streamSound: () => streaming },
      channelId: '1',
      name: 'Lounge',
    });
    change({ volume: 80, preset: 'off' });
    assert.equal(restarts, 1);
    // Three more within the cooldown: one, when it ends, with the last of them.
    await clock.advance(100);
    change({ volume: 70, preset: 'off' });
    change({ volume: 60, preset: 'bass' });
    await clock.advance(100);
    change({ volume: 50, preset: 'bass' });
    assert.equal(restarts, 1);
    await clock.advance(200);
    assert.equal(restarts, 2);
    assert.deepEqual(streaming, { volume: 50, preset: 'bass' });
    // A change back and forth within the cooldown, ending where the stream is: nothing to start again.
    change({ volume: 40, preset: 'bass' });
    change({ volume: 50, preset: 'bass' });
    await clock.advance(1000);
    assert.equal(restarts, 2);
    // A stream that started meanwhile with the newest sound (the next track) is not started again.
    await clock.advance(1000);
    change({ volume: 30, preset: 'bass' });
    assert.equal(restarts, 3);
    change({ volume: 20, preset: 'bass' });
    streaming = { volume: 20, preset: 'bass' };
    await clock.advance(1000);
    assert.equal(restarts, 3);
    // Leaving voice drops a change still waiting.
    change({ volume: 10, preset: 'bass' });
    change({ volume: 15, preset: 'bass' });
    voice.leave('G');
    await clock.advance(1000);
    assert.equal(restarts, 4);
  });
});
