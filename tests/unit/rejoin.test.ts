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
  // The date, which a test moves on (a restart an hour later).
  const time = { now: Date.UTC(2026, 10, 13, 20) };
  const store = memoryStore(() => time.now);
  const bus = new Bus();
  const sink = new MemorySink();
  const log = createLogger({ level: 'debug', sinks: [sink] });
  // A run of jukecord: its own memory over the same database (as after a restart).
  const run = () => new VoiceMemory({ bus, channels: store.voiceChannels, log, now: () => time.now });
  const memory = run();
  memory.start();
  return { store, bus, sink, memory, run, time };
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
      inVoice: () => false,
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
      inVoice: () => false,
      join: async () => {
        throw new Error('the bot may not connect or speak in Lounge');
      },
      told: async () => {},
    });
    assert.equal(back, 0);
    assert.deepEqual(store.voiceChannels.all(), []);
    assert.ok(sink.records.some((record) => record.msg === 'could not come back to voice after a restart'));
  });

  it('leaves alone a server whose bot someone called into voice while it went back to another', async () => {
    const { store, bus, memory } = setup();
    store.voiceChannels.remember(A, LOUNGE.channelId);
    store.voiceChannels.remember(B, LOUNGE.channelId);
    // Where each server's bot is now, as the voice manager knows it.
    const inVoice = new Set<string>();
    const joined: string[] = [];
    const back = await memory.rejoin({
      people: () => 2,
      inVoice: (guildId) => inVoice.has(guildId),
      join: async (guildId, channelId) => {
        joined.push(`${guildId} ${channelId}`);
        inVoice.add(guildId);
        bus.emit('voice', { guildId, channel: { channelId, name: 'Lounge' } });
        // While A's bot connects (up to twenty seconds), someone in B uses /play from the Studio: the bot joins them.
        if (guildId === A) {
          inVoice.add(B);
          bus.emit('voice', { guildId: B, channel: STUDIO });
        }
      },
      told: async () => {},
    });
    // B's bot stays with the people who called it, and the Studio stays kept for the next restart.
    assert.equal(back, 1);
    assert.deepEqual(joined, [`${A} ${LOUNGE.channelId}`]);
    assert.deepEqual(store.voiceChannels.all(), [
      { guildId: A, channelId: LOUNGE.channelId },
      { guildId: B, channelId: STUDIO.channelId },
    ]);
  });

  it('does not go back to a server whose bot was called and sent away again while its turn came', async () => {
    const { store, bus, memory } = setup();
    store.voiceChannels.remember(A, LOUNGE.channelId);
    store.voiceChannels.remember(B, LOUNGE.channelId);
    const joined: string[] = [];
    const back = await memory.rejoin({
      people: () => 2,
      inVoice: () => false,
      join: async (guildId, channelId) => {
        joined.push(`${guildId} ${channelId}`);
        bus.emit('voice', { guildId, channel: { channelId, name: 'Lounge' } });
        // While A's bot connects, someone in B calls it to the Studio and sends it away again with /leave.
        if (guildId === A) {
          bus.emit('voice', { guildId: B, channel: STUDIO });
          bus.emit('voice', { guildId: B, channel: null });
        }
      },
      told: async () => {},
    });
    // B's turn reads its kept channel again: there is none now, and the bot stays away as it was told.
    assert.equal(back, 1);
    assert.deepEqual(joined, [`${A} ${LOUNGE.channelId}`]);
    assert.deepEqual(store.voiceChannels.all(), [{ guildId: A, channelId: LOUNGE.channelId }]);
  });

  it('says it came back at most once an hour in a server, however often jukecord restarts (a crash loop)', async () => {
    const { store, bus, run, time } = setup();
    store.voiceChannels.remember(A, LOUNGE.channelId);
    const told: number[] = [];
    const discord = {
      people: () => 2,
      inVoice: () => false,
      join: async (guildId: string, channelId: string) => {
        bus.emit('voice', { guildId, channel: { channelId, name: 'Lounge' } });
      },
      told: async () => {
        told.push(time.now);
      },
    };
    // A run that crashes half a minute after its start, again and again: back each time, said the first time only.
    for (let restart = 0; restart < 4; restart += 1) {
      assert.equal(await run().rejoin(discord), 1);
      time.now += 30_000;
    }
    assert.equal(told.length, 1);
    // An hour after it was said, a restart says it again.
    time.now = (told[0] ?? 0) + 3_600_000;
    await run().rejoin(discord);
    assert.equal(told.length, 2);
  });
});
