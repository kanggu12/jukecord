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

function setup() {
  const clock = new FakeClock();
  // The card is drawn as its state and title, which is all these tests compare.
  const keeper = new CardKeeper({
    clock,
    render: (value, lang) => ({ text: `${lang} ${value.status} ${value.track?.title ?? ''}` }) as never,
    log: createLogger({ level: 'error', sinks: [] }),
  });
  const edits: string[] = [];
  let failing = false;
  const card = {
    lang: 'en' as const,
    edit: async (payload: unknown) => {
      if (failing) throw new Error('Unknown Message');
      edits.push((payload as { text: string }).text);
    },
  };
  return { clock, keeper, edits, card, fail: () => (failing = true) };
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
