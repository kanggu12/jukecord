import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Actions } from '../../src/app/actions.ts';
import { Bus } from '../../src/core/bus.ts';
import { Players } from '../../src/core/players.ts';
import { QueueService } from '../../src/core/queue.ts';
import { Bot } from '../../src/discord/bot.ts';
import { createLogger } from '../../src/log.ts';
import type { Ffmpeg } from '../../src/media/ffmpeg.ts';
import type { Resolver } from '../../src/media/resolver.ts';
import { FakeClock, FakeMedia, flush } from '../support/fakes.ts';
import { addTracks, memoryStore } from '../support/store.ts';

const REMOVED = '100000000000000001';
const STAYS = '100000000000000002';

// A bot that never logs in (no token is used, nothing reaches Discord), around players that really play.
function setup() {
  const clock = new FakeClock();
  const store = memoryStore(() => clock.now());
  const bus = new Bus();
  const media = new FakeMedia();
  const log = createLogger({ level: 'error', sinks: [] });
  const queue = new QueueService(store.queue, bus);
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
  // The bot only passes its actions on; no lookup happens in these tests.
  const actions = new Actions({ store, queue, players, resolver: {} as Resolver, log });
  const bot = new Bot({
    token: 'not used',
    actions,
    players,
    bus,
    ffmpeg: {} as Ffmpeg,
    settings: store.settings,
    log,
    panelUrl: null,
    discord: store.discord,
    voiceIdleMs: 0,
    users: store.users,
  });
  return { store, queue, players, media, bot };
}

describe('the bot and the servers it is in', () => {
  it('stops the player of a server that removed it, forgets its commands, and leaves the other servers alone', async () => {
    const { store, queue, players, media, bot } = setup();
    try {
      const tracks = addTracks(store, 2);
      for (const [index, guild] of [REMOVED, STAYS].entries()) {
        const track = tracks[index];
        assert.ok(track);
        queue.add(guild, [track.id], 'end', null);
        players.get(guild).play();
        await flush();
        media.finish(60_000);
        await flush();
        assert.equal(players.get(guild).snapshot().status, 'playing');
      }
      store.discord.setCommandsHash(REMOVED, 'registered');
      store.discord.setCommandsHash(STAYS, 'registered');

      bot.removed(REMOVED);

      assert.equal(players.get(REMOVED).snapshot().status, 'idle');
      assert.equal(players.get(STAYS).snapshot().status, 'playing');
      // Added back later, the server gets its commands again (Discord removed them with the bot).
      assert.equal(store.discord.commandsHash(REMOVED), null);
      assert.equal(store.discord.commandsHash(STAYS), 'registered');
    } finally {
      await bot.client.destroy();
    }
  });

  it('counts a DJ role deleted in Discord as none for slash commands too', async () => {
    const { store, bot } = setup();
    try {
      // Who may change the music, worked out for a command as the bot does (a member without Manage Server).
      const context = (roles: string[]) =>
        (bot as unknown as { context(interaction: unknown): { mayControl: boolean } | null }).context({
          inGuild: () => true,
          guildId: STAYS,
          user: { id: '300000000000000001' },
          member: { roles },
          memberPermissions: { has: () => false },
        });
      // The server's roles as Discord says now; the role chosen earlier is no longer among them.
      bot.knownRoles = () => [{ id: '500000000000000001', name: 'DJ', color: 0 }];
      store.settings.setDjRole(STAYS, '500000000000000099');
      assert.equal(context([])?.mayControl, true);
      // A role that exists still decides.
      store.settings.setDjRole(STAYS, '500000000000000001');
      assert.equal(context([])?.mayControl, false);
      assert.equal(context(['500000000000000001'])?.mayControl, true);
      // A server whose roles are not known keeps the role chosen.
      bot.knownRoles = () => null;
      store.settings.setDjRole(STAYS, '500000000000000099');
      assert.equal(context([])?.mayControl, false);
    } finally {
      await bot.client.destroy();
    }
  });

  it('makes no player for a server it never played in', async () => {
    const { players, bot } = setup();
    try {
      bot.removed(REMOVED);
      assert.equal(players.existing(REMOVED), undefined);
      assert.equal(players.all().length, 0);
    } finally {
      await bot.client.destroy();
    }
  });
});
