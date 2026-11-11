import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { ActionError } from '../../src/app/actions.ts';
import { VoiceManager } from '../../src/discord/voice.ts';
import { createLogger } from '../../src/log.ts';

const VIEW = PermissionFlagsBits.ViewChannel;
const CONNECT = PermissionFlagsBits.Connect;
const SPEAK = PermissionFlagsBits.Speak;

// A voice channel whose permissions are a table: who (a member's ID, "everyone" or "bot") has which rights.
function channel(id: string, name: string, position: number, rights: Record<string, bigint[]>) {
  return {
    id,
    name,
    position,
    type: ChannelType.GuildVoice,
    isVoiceBased: () => true,
    members: { filter: () => ({ size: 2 }) },
    permissionsFor: (target: { id: string }) => ({
      has: (flags: bigint | bigint[]) => [flags].flat().every((flag) => (rights[target.id] ?? []).includes(flag)),
    }),
  };
}

// One server with a channel for everyone and a staff channel only Alice (and the bot) can see.
function manager() {
  const lounge = channel('1', 'Lounge', 0, {
    bot: [VIEW, CONNECT, SPEAK],
    everyone: [VIEW, CONNECT],
    alice: [VIEW, CONNECT],
    bob: [VIEW, CONNECT],
  });
  const staff = channel('2', 'Staff', 1, { bot: [VIEW, CONNECT, SPEAK], alice: [VIEW, CONNECT] });
  const members = new Map([
    ['alice', { id: 'alice' }],
    ['bob', { id: 'bob' }],
  ]);
  const guild = {
    id: 'G',
    members: { me: { id: 'bot' }, cache: members, fetch: async (id: string) => members.get(id) ?? null },
    roles: { everyone: { id: 'everyone' } },
    channels: {
      cache: new Map<string, unknown>([
        ['1', lounge],
        ['2', staff],
      ]),
    },
    voiceStates: { cache: new Map() },
  };
  const client = { guilds: { cache: new Map([['G', guild]]) }, on: () => {} };
  return new VoiceManager({
    client: client as never,
    players: {} as never,
    ffmpeg: {} as never,
    log: createLogger({ level: 'error', sinks: [] }),
    idleMs: 0,
  });
}

describe('voice channels and who may see them', () => {
  it('lists a private channel only to those who can see it, and every channel to the host', () => {
    const voice = manager();
    const names = (viewer: { userId: string | null; all: boolean }) =>
      voice.channels('G', viewer).map((entry) => entry.name);
    assert.deepEqual(names({ userId: 'alice', all: false }), ['Lounge', 'Staff']);
    assert.deepEqual(names({ userId: 'bob', all: false }), ['Lounge']);
    // Everyone's view (the shared updates), and someone not in the cache: what everyone sees.
    assert.deepEqual(names({ userId: null, all: false }), ['Lounge']);
    assert.deepEqual(names({ userId: 'stranger', all: false }), ['Lounge']);
    assert.deepEqual(names({ userId: null, all: true }), ['Lounge', 'Staff']);
  });

  it('refuses to carry the music into a channel the person may not go to themselves', async () => {
    const voice = manager();
    await assert.rejects(
      voice.join('G', '2', 'bob'),
      (error: unknown) => error instanceof ActionError && error.code === 'forbidden',
    );
  });
});
