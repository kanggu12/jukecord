/**
 * The now-playing card with a vote to skip under way: its Skip button and the line under the bar say how the vote
 * stands, on the card a press drew and on the card kept current, which follows the votes as they change from anywhere
 * (a vote from the panel changes no player, so only the votes say so).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Directory } from '../../src/app/actions.ts';
import { fakeBot, GUILD, handlers, interaction, PERSON } from '../support/discord.ts';
import { flush } from '../support/fakes.ts';
import { addTracks } from '../support/store.ts';

const DJ_ROLE = '500000000000000001';
// Two more people listening besides the person who presses (PERSON): three in all, so two votes skip.
const BEN = '300000000000000002';
const CAT = '300000000000000003';

// A server with a DJ role, three people listening and a track playing; nobody pressing has the role.
async function voting() {
  const people = new Set([PERSON, BEN, CAT]);
  const made = fakeBot({ listening: () => people });
  // Discord's side: the server has the DJ role among its roles (the bot of the tests sees no server).
  const directory = Object.assign(Object.create(made.bot), {
    roles: () => [{ id: DJ_ROLE, name: 'DJ', color: 0 }],
  }) as Directory;
  made.actions.setVoice(made.bot.voice, () => true, directory);
  made.store.settings.setDjRole(GUILD, DJ_ROLE);
  const tracks = addTracks(made.store, 3);
  made.queue.add(
    GUILD,
    tracks.map((track) => track.id),
    'end',
    null,
  );
  made.players.get(GUILD).play();
  made.media.finish(180_000);
  await flush();
  return made;
}

describe('the playing card and the votes to skip', () => {
  it('keeps the card answered to /np current with the votes cast elsewhere, and draws a press of Skip as a vote', async () => {
    const { bot, actions, clock, players } = await voting();
    const np = interaction('command', 'np');
    await handlers(bot).onCommand(np.interaction);
    assert.match(np.shown[0]?.text ?? '', /\[Skip jukecord:skip:en:\d+\]/);
    // The keeper's look at the player once the card is out: nothing to draw again.
    await clock.advance(10);
    await flush();
    assert.equal(np.shown.length, 1);
    // A vote from someone listening in a browser: no change of the player, and the kept card says it all the same.
    actions.skip({ guildId: GUILD, userId: BEN, mayControl: false, mayManage: false });
    await clock.advance(10);
    await flush();
    const kept = np.shown.at(-1)?.text ?? '';
    assert.equal(np.shown.length, 2);
    assert.match(kept, /\[Skip \(1 of 2\) jukecord:skip:en:\d+\]/);
    assert.match(kept, /Votes to skip: 1 of 2/);
    // The press of the card's Skip by someone without the role is the second vote: the track goes.
    const track = players.get(GUILD).snapshot().track?.id;
    const press = interaction('button', `jukecord:skip:en:${track}`);
    await handlers(bot).onButton(press.interaction);
    assert.equal(press.shown[0]?.kind, 'update');
    assert.notEqual(players.get(GUILD).snapshot().track?.id, track);
    assert.doesNotMatch(press.shown[0]?.text ?? '', /of 2/);
    await bot.client.destroy();
  });

  it('says how a vote stands on the card a press of Skip draws, while the track stays', async () => {
    const { bot, players } = await voting();
    const track = players.get(GUILD).snapshot().track?.id;
    const press = interaction('button', `jukecord:skip:en:${track}`);
    await handlers(bot).onButton(press.interaction);
    assert.equal(players.get(GUILD).snapshot().track?.id, track);
    assert.match(press.shown[0]?.text ?? '', /\[Skip \(1 of 2\) jukecord:skip:en:\d+\]/);
    assert.match(press.shown[0]?.text ?? '', /Votes to skip: 1 of 2/);
    await bot.client.destroy();
  });
});
