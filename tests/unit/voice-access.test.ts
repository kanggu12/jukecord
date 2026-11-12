import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { ActionError } from '../../src/app/actions.ts';
import { VoiceManager } from '../../src/discord/voice.ts';
import { createLogger } from '../../src/log.ts';

const VIEW = PermissionFlagsBits.ViewChannel;
const CONNECT = PermissionFlagsBits.Connect;
const SPEAK = PermissionFlagsBits.Speak;

// A channel's members as discord.js keeps them (a collection to filter): people, and the bot when it is in there.
function members(ids: string[]) {
  const list = ids.map((id) => ({ id, user: { bot: id === 'bot' } }));
  return {
    size: list.length,
    filter: (test: (member: (typeof list)[number]) => boolean) => ({ size: list.filter(test).length }),
  };
}

// A voice channel whose permissions are a table: who (a member's ID, "everyone" or "bot") has which rights.
function channel(id: string, name: string, position: number, rights: Record<string, bigint[]>, inside = ['a', 'b']) {
  return {
    id,
    name,
    position,
    type: ChannelType.GuildVoice,
    isVoiceBased: () => true,
    members: members(inside),
    // No member limit unless a channel sets one.
    userLimit: 0,
    permissionsFor: (target: { id: string }) => ({
      has: (flags: bigint | bigint[]) => [flags].flat().every((flag) => (rights[target.id] ?? []).includes(flag)),
    }),
  };
}

// One server with a channel for everyone and a staff channel only Alice (and the bot) can see.
function manager(options: { small?: string[] } = {}) {
  const lounge = channel('1', 'Lounge', 0, {
    bot: [VIEW, CONNECT, SPEAK],
    everyone: [VIEW, CONNECT],
    alice: [VIEW, CONNECT],
    bob: [VIEW, CONNECT],
  });
  const staff = channel('2', 'Staff', 1, { bot: [VIEW, CONNECT, SPEAK], alice: [VIEW, CONNECT] });
  // A channel at its member limit, two (the bot has no Move Members to pass it): Alice and Bob are in it, or Alice and
  // the bot (`small` below).
  const small = {
    ...channel(
      '3',
      'Small',
      2,
      { bot: [VIEW, CONNECT, SPEAK], everyone: [VIEW, CONNECT], alice: [VIEW, CONNECT], bob: [VIEW, CONNECT] },
      options.small ?? ['alice', 'bob'],
    ),
    userLimit: 2,
    // As discord.js says it: its members (the bot among them, when it is in there) at the limit.
    get full(): boolean {
      return this.userLimit > 0 && this.members.size >= this.userLimit;
    },
  };
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
        ['3', small],
      ]),
    },
    voiceStates: { cache: new Map() },
    // Connecting is as far as these tests go: it says it was tried.
    voiceAdapterCreator: () => {
      throw new Error('connecting');
    },
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
    // (A full channel is listed like any other: whether it is full changes by the minute, and joining says so.)
    assert.deepEqual(names({ userId: 'alice', all: false }), ['Lounge', 'Staff', 'Small']);
    assert.deepEqual(names({ userId: 'bob', all: false }), ['Lounge', 'Small']);
    // Everyone's view (the shared updates), and someone not in the cache: what everyone sees.
    assert.deepEqual(names({ userId: null, all: false }), ['Lounge', 'Small']);
    assert.deepEqual(names({ userId: 'stranger', all: false }), ['Lounge', 'Small']);
    assert.deepEqual(names({ userId: null, all: true }), ['Lounge', 'Staff', 'Small']);
  });

  it('says at once that a channel at its member limit is full, rather than trying to connect for twenty seconds', async () => {
    const voice = manager();
    const started = Date.now();
    await assert.rejects(
      voice.join('G', '3', null),
      (error: unknown) =>
        error instanceof ActionError &&
        error.code === 'conflict' &&
        error.message === 'the voice channel Small is full',
    );
    assert.ok(Date.now() - started < 1000);
  });

  it('does not count the bot against the limit of a channel it is in', async () => {
    // Alice and the bot in Small (limit 2), as the voice manager joined it: her /join there does nothing, it is no
    // "full" refusal.
    const there = manager({ small: ['alice', 'bot'] });
    (there as unknown as { joined: Map<string, unknown> }).joined.set('G', { channelId: '3', name: 'Small' });
    assert.deepEqual(await there.join('G', '3', null), { channelId: '3', name: 'Small' });
    // Discord still lists the bot there after a crash (its voice state outlives the process): coming back connects.
    const listed = manager({ small: ['alice', 'bot'] });
    await assert.rejects(listed.join('G', '3', null), (error: unknown) => (error as Error).message === 'connecting');
  });

  it('refuses to carry the music into a channel the person may not go to themselves', async () => {
    const voice = manager();
    await assert.rejects(
      voice.join('G', '2', 'bob'),
      (error: unknown) => error instanceof ActionError && error.code === 'forbidden',
    );
  });
});
