/**
 * The now-playing card kept current: edited as the player changes, at most once every few seconds, only when what it
 * shows changed, and let go once it cannot be edited.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PlayerSnapshot } from '../../src/core/player.ts';
import { CardKeeper } from '../../src/discord/keeper.ts';
import { createLogger } from '../../src/log.ts';
import { FakeClock, flush } from '../support/fakes.ts';

const GUILD = '100000000000000001';

// A snapshot with the fields the fake drawing below reads.
function snapshot(status: PlayerSnapshot['status'], title = 'Track 1'): PlayerSnapshot {
  return { guildId: GUILD, status, track: { title } } as unknown as PlayerSnapshot;
}

function setup(now: PlayerSnapshot | null = null) {
  const clock = new FakeClock();
  // The card is drawn as its state and title, which is all these tests compare.
  const keeper = new CardKeeper({
    clock,
    render: (value, lang) => ({ text: `${lang} ${value.status} ${value.track?.title ?? ''}` }) as never,
    log: createLogger({ level: 'error', sinks: [] }),
    // The player as it is now, when a test says (the others start with nothing to catch up with).
    current: () => now,
  });
  const edits: string[] = [];
  // The next edits' failure, as discord.js throws it (a DiscordAPIError's code, or none for a server error).
  let failing: Error | null = null;
  const card = {
    lang: 'en' as const,
    edit: async (payload: unknown) => {
      if (failing) throw failing;
      edits.push((payload as { text: string }).text);
    },
  };
  // Deleted in the channel: Discord's "Unknown Message".
  const fail = (error: Error = Object.assign(new Error('Unknown Message'), { code: 10008 })) => (failing = error);
  return { clock, keeper, edits, card, fail, heal: () => (failing = null) };
}

describe('CardKeeper', () => {
  it('edits the last card as the player changes, at once and then at most every five seconds, the newest state winning', async () => {
    const { clock, keeper, edits, card } = setup();
    keeper.keep(GUILD, card, { text: 'en playing Track 1' } as never);
    // Paused: the card says so at once.
    keeper.changed(snapshot('paused'));
    await clock.advance(0);
    assert.deepEqual(edits, ['en paused Track 1']);
    // A burst within the next seconds (play on, skip, the next track loading): one edit, five seconds after the last,
    // with what plays then.
    keeper.changed(snapshot('playing'));
    keeper.changed(snapshot('loading', 'Track 2'));
    keeper.changed(snapshot('playing', 'Track 2'));
    await clock.advance(4000);
    assert.equal(edits.length, 1);
    await clock.advance(1000);
    assert.deepEqual(edits, ['en paused Track 1', 'en playing Track 2']);
    // A snapshot that changes nothing on the card (a loading track's progress) edits nothing.
    keeper.changed(snapshot('playing', 'Track 2'));
    await clock.advance(10_000);
    assert.equal(edits.length, 2);
    keeper.stop();
  });

  it('catches a card up at once with what changed while it was on its way to Discord', async () => {
    // /skip answered "Getting it ready"; the next track (fetched already) started before Discord showed the answer.
    const { clock, keeper, edits, card } = setup(snapshot('playing', 'Track 2'));
    keeper.keep(GUILD, card, { text: 'en loading Track 2' } as never);
    await clock.advance(0);
    assert.deepEqual(edits, ['en playing Track 2']);
    // A card that shows the player as it is now is left as it is.
    keeper.keep(GUILD, card, { text: 'en playing Track 2' } as never);
    await clock.advance(10_000);
    assert.equal(edits.length, 1);
    keeper.stop();
  });

  it('keeps a card through a passing failure, and draws it again at the next change', async () => {
    const { clock, keeper, edits, card, fail, heal } = setup();
    keeper.keep(GUILD, card, { text: 'en playing Track 1' } as never);
    // Discord busy (a server error after discord.js's retries): the pause does not show, the card stays kept.
    fail(Object.assign(new Error('Service Unavailable'), { status: 503 }));
    keeper.changed(snapshot('paused'));
    await clock.advance(0);
    await flush();
    assert.equal(keeper.kept(GUILD), true);
    // Discord answers again: the next change draws it, the pause the failed edit did not show among it.
    heal();
    keeper.changed(snapshot('paused'));
    await clock.advance(5000);
    assert.deepEqual(edits, ['en paused Track 1']);
    keeper.stop();
  });

  it('keeps only the newest card of a server, and lets go of one it cannot edit', async () => {
    const { clock, keeper, edits, card, fail } = setup();
    const older: string[] = [];
    keeper.keep(GUILD, { lang: 'ko', edit: async (payload: unknown) => older.push(String(payload)) }, {} as never);
    keeper.keep(GUILD, card, { text: 'en playing Track 1' } as never);
    keeper.changed(snapshot('paused'));
    await clock.advance(0);
    assert.deepEqual(older, []);
    assert.deepEqual(edits, ['en paused Track 1']);
    // Deleted in the channel: the edit fails, and no more are tried.
    fail();
    keeper.changed(snapshot('playing'));
    await clock.advance(5000);
    await flush();
    keeper.changed(snapshot('paused'));
    await clock.advance(5000);
    assert.equal(keeper.kept(GUILD), false);
    assert.equal(clock.pending(), 0);
    keeper.stop();
  });
});
