/**
 * Coming back to voice after a restart: the channel each server's bot is in is kept as it joins, moves and leaves (a
 * stop of jukecord aside), and after the restart the bot goes back where people are.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Bus } from '../../src/core/bus.ts';
import { VoiceMemory } from '../../src/discord/rejoin.ts';
import { createLogger, MemorySink } from '../../src/log.ts';
import { memoryStore } from '../support/store.ts';

const A = '100000000000000001';
const B = '100000000000000002';
const LOUNGE = { channelId: '400000000000000001', name: 'Lounge' };
const STUDIO = { channelId: '400000000000000002', name: 'Studio' };

function setup() {
  const store = memoryStore();
  const bus = new Bus();
  const sink = new MemorySink();
  const memory = new VoiceMemory({
    bus,
    channels: store.voiceChannels,
    log: createLogger({ level: 'debug', sinks: [sink] }),
  });
  memory.start();
  return { store, bus, sink, memory };
}

describe('VoiceMemory', () => {
  it('keeps the channel the bot joins or is moved to, forgets one it leaves, and keeps them all when jukecord stops', () => {
    const { store, bus, memory } = setup();
    bus.emit('voice', { guildId: A, channel: LOUNGE });
    bus.emit('voice', { guildId: A, channel: STUDIO });
    bus.emit('voice', { guildId: B, channel: LOUNGE });
    assert.deepEqual(store.voiceChannels.all(), [
      { guildId: A, channelId: STUDIO.channelId },
      { guildId: B, channelId: LOUNGE.channelId },
    ]);
    // Left (a person's /leave, nobody there, kicked): not to come back to.
    bus.emit('voice', { guildId: B, channel: null });
    assert.deepEqual(store.voiceChannels.all(), [{ guildId: A, channelId: STUDIO.channelId }]);
    // jukecord stops and leaves every channel: that is not people leaving, and the channel stays kept.
    memory.freeze();
    bus.emit('voice', { guildId: A, channel: null });
    assert.deepEqual(store.voiceChannels.all(), [{ guildId: A, channelId: STUDIO.channelId }]);
  });

  it('goes back after a restart where people are, says so there, and forgets a channel nobody is in', async () => {
    const { store, bus, sink, memory } = setup();
    store.voiceChannels.remember(A, LOUNGE.channelId);
    store.voiceChannels.remember(B, STUDIO.channelId);
    const joined: string[] = [];
    const told: string[] = [];
    const back = await memory.rejoin({
      // Two people in A's channel, nobody in B's.
      people: (guildId) => (guildId === A ? 2 : 0),
      join: async (guildId, channelId) => {
        joined.push(`${guildId} ${channelId}`);
        // As the voice manager does once it is in.
        bus.emit('voice', { guildId, channel: { channelId, name: 'Lounge' } });
      },
      told: async (guildId) => {
        told.push(guildId);
      },
    });
    assert.equal(back, 1);
    assert.deepEqual(joined, [`${A} ${LOUNGE.channelId}`]);
    assert.deepEqual(told, [A]);
    assert.deepEqual(store.voiceChannels.all(), [{ guildId: A, channelId: LOUNGE.channelId }]);
    assert.ok(sink.records.some((record) => record.msg === 'came back to voice after a restart'));
  });

  it('forgets a channel it cannot go back to, and says why in the log', async () => {
    const { store, sink, memory } = setup();
    store.voiceChannels.remember(A, LOUNGE.channelId);
    const back = await memory.rejoin({
      people: () => 3,
      join: async () => {
        throw new Error('the bot may not connect or speak in Lounge');
      },
      told: async () => {},
    });
    assert.equal(back, 0);
    assert.deepEqual(store.voiceChannels.all(), []);
    assert.ok(sink.records.some((record) => record.msg === 'could not come back to voice after a restart'));
  });
});
