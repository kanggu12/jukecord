/**
 * Resting: a player that nobody hears anywhere (the bot out of voice, no browser playing along) pauses after a while
 * and says so, instead of fetching and counting plays for nobody.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Rest } from '../../src/app/rest.ts';
import { Bus } from '../../src/core/bus.ts';
import { Players } from '../../src/core/players.ts';
import { QueueService } from '../../src/core/queue.ts';
import { createLogger } from '../../src/log.ts';
import { FakeClock, FakeMedia, flush } from '../support/fakes.ts';
import { addTracks, memoryStore } from '../support/store.ts';

const GUILD = '100000000000000001';

// A playing server whose voice and browsers a test sets, and the watch on it.
async function setup(afterMs = 120_000) {
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
  const heard = { voice: false, browsers: 0 };
  const rest = new Rest({
    bus,
    players,
    inVoice: () => heard.voice,
    listeners: () => heard.browsers,
    clock,
    afterMs,
    log,
  });
  rest.start();
  const tracks = addTracks(store, 3);
  queue.add(
    GUILD,
    tracks.map((track) => track.id),
    'end',
    null,
  );
  const player = players.get(GUILD);
  player.play();
  // A long track, so the first one plays through every wait of these tests.
  media.finish(4 * 3_600_000);
  await flush();
  return { clock, store, bus, media, heard, player, rest };
}

describe('Rest', () => {
  it('pauses a player nobody hears after the wait, and says why', async () => {
    const { clock, store, player, rest } = await setup();
    assert.equal(player.snapshot().status, 'playing');
    await clock.advance(119_000);
    assert.equal(player.snapshot().status, 'playing');
    await clock.advance(2000);
    assert.equal(player.snapshot().status, 'paused');
    assert.equal(player.snapshot().notice, 'paused with nobody listening');
    // Nothing was counted as a listen for nobody, and nothing more is fetched.
    await clock.advance(3_600_000);
    assert.equal(store.history.list(GUILD).length, 0);
    rest.stop();
  });

  it('lets it play while the bot is in voice or a browser plays along, and counts the wait from when the last one left', async () => {
    const { clock, bus, heard, player, rest } = await setup();
    // A browser starts listening within the wait: nothing happens however long it plays.
    heard.browsers = 1;
    bus.emit('listeners', { guildId: GUILD, count: 1 });
    await clock.advance(300_000);
    assert.equal(player.snapshot().status, 'playing');
    // It stops; the bot joins voice before the wait is over.
    heard.browsers = 0;
    bus.emit('listeners', { guildId: GUILD, count: 0 });
    await clock.advance(60_000);
    heard.voice = true;
    bus.emit('voice', { guildId: GUILD, channel: { channelId: '400000000000000001', name: 'Lounge' } });
    await clock.advance(600_000);
    assert.equal(player.snapshot().status, 'playing');
    // The bot leaves (nobody was in the channel): the wait starts again from now.
    heard.voice = false;
    bus.emit('voice', { guildId: GUILD, channel: null });
    await clock.advance(119_000);
    assert.equal(player.snapshot().status, 'playing');
    await clock.advance(2000);
    assert.equal(player.snapshot().status, 'paused');
    // A person playing on clears the notice; it rests again only after another wait with nobody.
    player.resume();
    assert.equal(player.snapshot().notice, null);
    rest.stop();
  });

  it('never rests when told not to', async () => {
    const { clock, player, rest } = await setup(0);
    await clock.advance(600_000);
    assert.equal(player.snapshot().status, 'playing');
    rest.stop();
  });
});
