/**
 * Staying in voice: a server's stay setting keeps the bot in its channel when everyone has left; without it the bot
 * leaves after the host's time alone, and a change of the setting is acted on at once.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChannelType } from 'discord.js';
import { VoiceManager } from '../../src/discord/voice.ts';
import { createLogger } from '../../src/log.ts';
import { FakeClock } from '../support/fakes.ts';

// One server whose bot sits alone in the Lounge, the setting read from `stay`, and a way to see the bot leave.
function alone(stay: { on: boolean }) {
  const clock = new FakeClock();
  const lounge = {
    id: '1',
    name: 'Lounge',
    type: ChannelType.GuildVoice,
    isVoiceBased: () => true,
    // Nobody but bots: the filter for people finds none.
    members: { filter: () => ({ size: 0 }) },
  };
  const guild = {
    id: 'G',
    members: { me: { voice: { channel: lounge } } },
    channels: { cache: new Map([['1', lounge]]) },
  };
  const client = { guilds: { cache: new Map([['G', guild]]) } };
  let destroyed = 0;
  const voice = new VoiceManager({
    client: client as never,
    players: { get: () => ({ detach: () => {} }) } as never,
    ffmpeg: {} as never,
    log: createLogger({ level: 'error', sinks: [] }),
    idleMs: 60_000,
    clock,
    stays: () => stay.on,
  });
  // As a join leaves it (joining itself needs a real voice connection): the connection, the output and the channel.
  (voice as unknown as { joined: Map<string, unknown> }).joined.set('G', {
    connection: {
      state: { status: 'ready' },
      destroy: () => {
        destroyed += 1;
      },
    },
    output: {},
    channelId: '1',
    name: 'Lounge',
  });
  return { clock, voice, destroyed: () => destroyed };
}

describe('staying in voice', () => {
  it('keeps the bot in a channel nobody is in while the server asks it to stay', async () => {
    const stay = { on: true };
    const { clock, voice, destroyed } = alone(stay);
    voice.voiceStateChanged('G');
    await clock.advance(10 * 60_000);
    assert.equal(voice.channel('G')?.name, 'Lounge');
    assert.equal(destroyed(), 0);
  });

  it('leaves after the time alone once the setting is turned off, counting from the change', async () => {
    const stay = { on: true };
    const { clock, voice, destroyed } = alone(stay);
    voice.voiceStateChanged('G');
    await clock.advance(5 * 60_000);
    stay.on = false;
    voice.stayChanged('G');
    // The host's minute alone starts at the change, not at the last change of who is in the channel.
    await clock.advance(59_000);
    assert.equal(voice.channel('G')?.name, 'Lounge');
    await clock.advance(2000);
    assert.equal(voice.channel('G'), null);
    assert.equal(destroyed(), 1);
  });

  it('stops a countdown under way when the setting is turned on', async () => {
    const stay = { on: false };
    const { clock, voice } = alone(stay);
    voice.voiceStateChanged('G');
    await clock.advance(30_000);
    stay.on = true;
    voice.stayChanged('G');
    await clock.advance(5 * 60_000);
    assert.equal(voice.channel('G')?.name, 'Lounge');
  });
});
