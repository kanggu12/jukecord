/**
 * Stop after this track: the player stops when the current track ends by itself, the queue staying as it is, and
 * forgets it when the track changes any other way; the action needs control; the API, the command line (both ways of
 * typing it) and the Discord card say it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { afterTrack, findCommand, parseLine, run } from '../../src/cli/main.ts';
import { Bus } from '../../src/core/bus.ts';
import { Player } from '../../src/core/player.ts';
import { QueueService } from '../../src/core/queue.ts';
import { nowCard } from '../../src/discord/cards.ts';
import { createLogger } from '../../src/log.ts';
import { API_PREFIX } from '../../src/web/api.ts';
import { FakeClock, FakeMedia, FakeOutput, flush } from '../support/fakes.ts';
import { addTracks, memoryStore } from '../support/store.ts';
import { ALICE, asHost, DJ_ROLE, exampleTrack, GUILD, sessionFor, testServer } from '../support/web.ts';

const SONG = 180_000;

// A player with three queued tracks, its first one playing.
async function playing() {
  const clock = new FakeClock();
  const store = memoryStore(() => clock.now());
  const bus = new Bus();
  const queue = new QueueService(store.queue, bus);
  const media = new FakeMedia();
  const player = new Player({
    guildId: GUILD,
    queue,
    media,
    history: store.history,
    state: store.playerState,
    bus,
    clock,
    log: createLogger({ level: 'error', sinks: [] }),
    fetchTimeoutMs: 60_000,
  });
  const tracks = addTracks(store, 3);
  queue.add(
    GUILD,
    tracks.map((track) => track.id),
    'end',
    'u1',
  );
  player.play();
  media.finish(SONG);
  await flush();
  return { clock, store, queue, media, player };
}

describe('Player.setStopAfter', () => {
  it('stops when the track ends by itself, which counts as played, the queue left as it was', async () => {
    const { clock, store, queue, player } = await playing();
    assert.equal(player.setStopAfter(true), true);
    assert.equal(player.snapshot().stopAfter, true);
    // Asking again changes nothing.
    assert.equal(player.setStopAfter(true), false);
    await clock.advance(SONG);
    const snapshot = player.snapshot();
    assert.deepEqual([snapshot.status, snapshot.track, snapshot.stopAfter], ['idle', null, false]);
    assert.equal(queue.size(GUILD), 2);
    assert.equal(store.history.list(GUILD).length, 1);
    // Played on afterwards, the next track is not stopped after.
    assert.equal(player.play(), true);
    assert.equal(player.snapshot().stopAfter, false);
  });

  it('stops after the track with an output too, when the output reports the end', async () => {
    const { clock, player } = await playing();
    const output = new FakeOutput();
    player.attach(output);
    player.setStopAfter(true);
    await clock.advance(SONG);
    player.outputEnded(output.lastSession(), output);
    assert.equal(player.snapshot().status, 'idle');
  });

  it('wins over repeating the track, and keeps a looping queue whole', async () => {
    const track = await playing();
    track.player.setRepeat('track');
    track.player.setStopAfter(true);
    await track.clock.advance(SONG);
    assert.equal(track.player.snapshot().status, 'idle');
    const loop = await playing();
    loop.player.setRepeat('queue');
    loop.player.setStopAfter(true);
    await loop.clock.advance(SONG);
    assert.equal(loop.player.snapshot().status, 'idle');
    // The finished track went back to the end of the loop, as after any track.
    assert.deepEqual(
      loop.queue.list(GUILD).map((item) => item.track.title),
      ['Track 2', 'Track 3', 'Track 1'],
    );
  });

  it('is forgotten when the track changes another way, and off plays on after it', async () => {
    const skipped = await playing();
    skipped.player.setStopAfter(true);
    skipped.player.skip();
    assert.equal(skipped.player.snapshot().stopAfter, false);
    skipped.media.finish(SONG);
    await flush();
    await skipped.clock.advance(SONG);
    assert.notEqual(skipped.player.snapshot().status, 'idle');
    const changed = await playing();
    changed.player.setStopAfter(true);
    assert.equal(changed.player.setStopAfter(false), true);
    await changed.clock.advance(SONG);
    assert.equal(changed.player.snapshot().status, 'loading');
    // Nothing current: nothing to stop after.
    changed.player.stop();
    assert.equal(changed.player.setStopAfter(true), false);
  });
});

describe('the stop-after operation', () => {
  it('needs control, says when nothing plays, and answers with the player', async () => {
    const server = await testServer({ found: { one: [exampleTrack('a')] } });
    try {
      const put = (headers: Record<string, string>, on: boolean) =>
        server.web.app.inject({
          method: 'PUT',
          url: `${API_PREFIX}/guilds/${GUILD}/player/stop-after`,
          headers,
          payload: { on },
        });
      assert.equal((await put(asHost, true)).statusCode, 409);
      await server.web.app.inject({
        method: 'POST',
        url: `${API_PREFIX}/guilds/${GUILD}/queue`,
        headers: asHost,
        payload: { input: 'one' },
      });
      const on = await put(asHost, true);
      assert.equal(on.statusCode, 200);
      assert.equal(on.json().stopAfter, true);
      // Someone without the DJ role may not.
      server.directory.join(GUILD, ALICE);
      server.store.settings.setDjRole(GUILD, DJ_ROLE);
      const { cookie, csrf } = sessionFor(server, ALICE);
      const refused = await put({ cookie, 'x-jukecord-csrf': csrf }, false);
      assert.equal(refused.statusCode, 403);
      assert.equal(server.players.get(GUILD).snapshot().stopAfter, true);
    } finally {
      await server.close();
    }
  });
});

describe('jukecord stop --after-track', () => {
  it('is the stop-after command, and --after-track means nothing elsewhere', async () => {
    const typed = afterTrack(parseLine(['stop', '--after-track', '--json']));
    assert.deepEqual(typed.args, ['stop-after']);
    assert.deepEqual([...typed.flags.keys()], ['json']);
    assert.equal(findCommand([...typed.args])?.operation, 'stop-after');
    // Off: "jukecord stop-after off".
    assert.equal(findCommand(['stop-after', 'off'])?.rest[0], 'off');
    const printed: string[] = [];
    // An option of stop only: on another command it is a typing mistake, said before anything is asked.
    assert.equal(await run(['skip', '--after-track'], {}, (text) => printed.push(text)), 2);
    assert.match(printed.join('\n'), /no option --after-track/);
  });
});

describe('the Discord card', () => {
  it('says the player stops after this track, beside the repeat mode', async () => {
    const { player } = await playing();
    player.setRepeat('queue');
    player.setStopAfter(true);
    const card = nowCard(player.snapshot(), 'en', null);
    assert.equal(card.embeds[0]?.data.footer?.text, 'Repeating the queue · Stops after this track');
    assert.equal(
      nowCard(player.snapshot(), 'ko', null).embeds[0]?.data.footer?.text,
      '대기열 반복 · 이 곡이 끝나면 멈춤',
    );
  });
});
